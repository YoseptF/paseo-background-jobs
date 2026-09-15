import { open, readFile, readdir, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  MAX_OUTPUT_BYTES,
  type BackgroundJob,
  type killBackgroundJobRpc,
  type listBackgroundJobsRpc,
  type readJobOutputRpc,
} from "../shared/jobs";

/**
 * Claude Code points a Bash tool's stdout at
 * `<tmp>/claude-<uid>/<project>/<sessionId>/tasks/<shellId>.output`, so a live process
 * holding that path on fd 1 is an agent-spawned shell, and the path carries both the
 * session and the provider's own shell id.
 */
export const OUTPUT_PATH =
  /\/(?<session>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/tasks\/(?<shell>[^/]+)\.output$/;

/**
 * procfs cannot tell a backgrounded shell from one the agent is still blocked on:
 * both get their own process group and session, /dev/null on stdin, and the same
 * output file. The transcript is the only authoritative record, and it announces
 * every backgrounded shell by id.
 */
export const BACKGROUND_ANNOUNCEMENT = /running in background with ID: ([A-Za-z0-9_-]+)/g;

/** The command the agent wrote, wrapped in the provider's shell-snapshot preamble. */
const EVAL_COMMAND = /&&\s*eval\s+'([\s\S]*?)'\s*<\s*\/dev\/null/;

const CLOCK_TICKS_PER_SECOND = 100;
/** An agent in one of these states is not going to collect this job's output. */
const INACTIVE_AGENT_STATUSES = new Set(["idle", "closed", "error", "initializing"]);

interface ProcStat {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  cpuSeconds: number;
}

export interface ShellProcess extends ProcStat {
  shellId: string;
  sessionId: string;
  outputPath: string;
  command: string;
  cwd: string;
  startedAt: Date;
}

async function listOwnPids(): Promise<number[]> {
  const uid = process.getuid?.();
  const entries = await readdir("/proc", { withFileTypes: true });
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    if (uid !== undefined) {
      try {
        const info = await stat(`/proc/${entry.name}`);
        if (info.uid !== uid) continue;
      } catch {
        continue;
      }
    }
    pids.push(Number(entry.name));
  }
  return pids;
}

/** `pid (comm) state ppid pgrp ...` — comm can contain spaces and parentheses, so split on the last `)`. */
export function parseProcStat(pid: number, raw: string): ProcStat | null {
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!state || Number.isNaN(ppid) || Number.isNaN(pgid)) return null;
  return { pid, ppid, pgid, state, cpuSeconds: (utime + stime) / CLOCK_TICKS_PER_SECOND };
}

async function readProcStat(pid: number): Promise<ProcStat | null> {
  try {
    return parseProcStat(pid, await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/** Strip the provider's shell-snapshot preamble back down to the command the agent wrote. */
export function unwrapCommand(cmdline: string): string {
  const argv = cmdline.split("\0").filter((part) => part.length > 0);
  const joined = argv.join(" ");
  const command = EVAL_COMMAND.exec(joined)?.[1] ?? joined;
  // zsh -c 'eval ...' escapes an embedded single quote as '"'"'.
  return command.replaceAll(`'"'"'`, "'").trim();
}

async function readCommand(pid: number): Promise<string> {
  try {
    return unwrapCommand(await readFile(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return "";
  }
}

/** Every live process whose stdout is an agent shell's output file, children included. */
export async function scanShellProcesses(): Promise<ShellProcess[]> {
  const pids = await listOwnPids();
  const shells: ShellProcess[] = [];
  await Promise.all(
    pids.map(async (pid) => {
      let outputPath: string;
      try {
        outputPath = await readlink(`/proc/${pid}/fd/1`);
      } catch {
        return;
      }
      const match = OUTPUT_PATH.exec(outputPath);
      const sessionId = match?.groups?.["session"];
      const shellId = match?.groups?.["shell"];
      if (!sessionId || !shellId) return;
      const procStat = await readProcStat(pid);
      if (!procStat) return;
      const [command, cwd, startedAt] = await Promise.all([
        readCommand(pid),
        readlink(`/proc/${pid}/cwd`).catch(() => ""),
        stat(`/proc/${pid}`)
          .then((info) => info.ctime)
          .catch(() => new Date()),
      ]);
      shells.push({ ...procStat, shellId, sessionId, outputPath, command, cwd, startedAt });
    }),
  );
  return shells;
}

/** Transitive child count per root, so a job reads as more than the one shell being signalled. */
async function countDescendants(roots: readonly number[]): Promise<Map<number, number>> {
  const children = new Map<number, number[]>();
  await Promise.all(
    (await listOwnPids()).map(async (pid) => {
      const procStat = await readProcStat(pid);
      if (!procStat) return;
      const siblings = children.get(procStat.ppid);
      if (siblings) siblings.push(pid);
      else children.set(procStat.ppid, [pid]);
    }),
  );
  const counts = new Map<number, number>();
  for (const root of roots) {
    let total = 0;
    const queue = [...(children.get(root) ?? [])];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      total += 1;
      queue.push(...(children.get(next) ?? []));
    }
    counts.set(root, total);
  }
  return counts;
}

interface TranscriptScan {
  /** Byte offset already consumed, so a growing transcript is only read once. */
  offset: number;
  shellIds: Set<string>;
}

const transcriptScans = new Map<string, TranscriptScan>();

function claudeProjectsDir(): string {
  const configDir = process.env["CLAUDE_CONFIG_DIR"];
  return join(configDir && configDir.length > 0 ? configDir : join(homedir(), ".claude"), "projects");
}

/** Transcripts are filed under a per-cwd directory, so find the session by name. */
async function findTranscript(sessionId: string): Promise<string | null> {
  const root = claudeProjectsDir();
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = join(root, project, `${sessionId}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Shell ids the agent explicitly backgrounded in this session. */
async function backgroundShellIds(sessionId: string): Promise<Set<string>> {
  const cached = transcriptScans.get(sessionId) ?? { offset: 0, shellIds: new Set<string>() };
  const path = await findTranscript(sessionId);
  if (!path) return cached.shellIds;
  const info = await stat(path).catch(() => null);
  if (!info) return cached.shellIds;
  // A shorter file means a new transcript took the name; start over.
  if (info.size < cached.offset) {
    cached.offset = 0;
    cached.shellIds = new Set();
  }
  if (info.size > cached.offset) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(info.size - cached.offset);
      await handle.read(buffer, 0, buffer.length, cached.offset);
      const text = buffer.toString("utf8");
      for (const match of text.matchAll(BACKGROUND_ANNOUNCEMENT)) {
        const shellId = match[1];
        if (shellId) cached.shellIds.add(shellId);
      }
      cached.offset = info.size;
    } finally {
      await handle.close();
    }
  }
  transcriptScans.set(sessionId, cached);
  return cached.shellIds;
}

interface AgentInfo {
  id: string;
  title: string | null;
  status: string | null;
  workspaceId: string | null;
}

/** sessionId -> agent, from the runtime info the daemon already tracks. */
async function mapSessionsToAgents(
  paseo: PluginHandlerContext["paseo"],
): Promise<Map<string, AgentInfo>> {
  const bySession = new Map<string, AgentInfo>();
  let entries: readonly unknown[];
  try {
    ({ entries } = await paseo.agents.list());
  } catch {
    return bySession;
  }
  for (const entry of entries) {
    const agent = (entry as { agent?: Record<string, unknown> }).agent;
    if (!agent) continue;
    const runtimeInfo = agent["runtimeInfo"] as { sessionId?: unknown } | undefined;
    const sessionId = typeof runtimeInfo?.sessionId === "string" ? runtimeInfo.sessionId : null;
    if (!sessionId) continue;
    bySession.set(sessionId, {
      id: String(agent["id"] ?? ""),
      title: typeof agent["title"] === "string" ? agent["title"] : null,
      status: typeof agent["status"] === "string" ? agent["status"] : null,
      workspaceId: typeof agent["workspaceId"] === "string" ? agent["workspaceId"] : null,
    });
  }
  return bySession;
}

/**
 * One entry per backgrounded shell. Children inherit the output file on fd 1, so
 * collapse each shell id onto its process-group leader.
 */
export async function collectJobShells(): Promise<ShellProcess[]> {
  const byShell = new Map<string, ShellProcess>();
  for (const shell of await scanShellProcesses()) {
    const key = `${shell.sessionId}:${shell.shellId}`;
    const current = byShell.get(key);
    const isLeader = shell.pid === shell.pgid;
    if (!current || (isLeader && current.pid !== current.pgid) || shell.pid < current.pid) {
      if (current && current.pid === current.pgid && !isLeader) continue;
      byShell.set(key, shell);
    }
  }
  const leaders = [...byShell.values()];
  const backgrounded = await Promise.all(
    leaders.map(async (shell) => (await backgroundShellIds(shell.sessionId)).has(shell.shellId)),
  );
  return leaders.filter((_, index) => backgrounded[index]);
}

export async function listBackgroundJobs(
  { agentId }: RpcInput<typeof listBackgroundJobsRpc>,
  { paseo }: PluginHandlerContext,
) {
  const [shells, agentsBySession] = await Promise.all([collectJobShells(), mapSessionsToAgents(paseo)]);
  const descendants = await countDescendants(shells.map((shell) => shell.pid));
  const now = Date.now();

  const jobs: BackgroundJob[] = [];
  for (const shell of shells) {
    const agent = agentsBySession.get(shell.sessionId) ?? null;
    if (agentId && agent?.id !== agentId) continue;
    const output = await stat(shell.outputPath).catch(() => null);
    jobs.push({
      pid: shell.pid,
      pgid: shell.pgid,
      shellId: shell.shellId,
      sessionId: shell.sessionId,
      agentId: agent?.id ?? null,
      agentTitle: agent?.title ?? null,
      agentStatus: agent?.status ?? null,
      workspaceId: agent?.workspaceId ?? null,
      command: shell.command,
      cwd: shell.cwd,
      startedAt: shell.startedAt.toISOString(),
      elapsedSeconds: Math.max(0, (now - shell.startedAt.getTime()) / 1_000),
      cpuSeconds: shell.cpuSeconds,
      state: shell.state,
      descendants: descendants.get(shell.pid) ?? 0,
      outputBytes: output?.size ?? 0,
      outputUpdatedAt: output?.mtime.toISOString() ?? null,
      orphaned: agent === null || INACTIVE_AGENT_STATUSES.has(agent.status ?? ""),
    });
  }
  jobs.sort((left, right) => right.elapsedSeconds - left.elapsedSeconds);
  return { jobs, scannedAt: new Date().toISOString() };
}

/** Resolve a pid back to a live job so output and kill can never touch an unrelated process. */
async function requireJob(pid: number, shellId: string): Promise<ShellProcess> {
  const shell = (await collectJobShells()).find((candidate) => candidate.pid === pid);
  if (!shell) throw new Error(`No background job is running as PID ${pid}.`);
  if (shell.shellId !== shellId) {
    throw new Error(`PID ${pid} now belongs to shell ${shell.shellId}, not ${shellId}.`);
  }
  return shell;
}

export async function readJobOutput({ pid, shellId }: RpcInput<typeof readJobOutputRpc>) {
  const shell = await requireJob(pid, shellId);
  const info = await stat(shell.outputPath).catch(() => null);
  if (!info) return { text: "", bytes: 0, truncated: false };
  const start = Math.max(0, info.size - MAX_OUTPUT_BYTES);
  const handle = await open(shell.outputPath, "r");
  try {
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return { text: buffer.toString("utf8"), bytes: info.size, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

export async function killBackgroundJob({
  pid,
  shellId,
  signal = "SIGTERM",
}: RpcInput<typeof killBackgroundJobRpc>) {
  const shell = await requireJob(pid, shellId);
  // Each background shell leads its own process group, so signalling the group takes
  // the job's children with it. Fall back to the lone pid if it ever shares a group.
  const ownsGroup = shell.pgid === shell.pid;
  try {
    process.kill(ownsGroup ? -shell.pgid : shell.pid, signal);
  } catch (error) {
    return { killed: false, message: error instanceof Error ? error.message : String(error) };
  }
  return {
    killed: true,
    message: ownsGroup
      ? `Sent ${signal} to process group ${shell.pgid}.`
      : `Sent ${signal} to PID ${shell.pid}.`,
  };
}
