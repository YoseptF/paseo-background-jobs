import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { open } from "node:fs/promises";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  MAX_OUTPUT_BYTES,
  type BackgroundJob,
  type JobKind,
  type killBackgroundJobRpc,
  type listBackgroundJobsRpc,
  type readJobOutputRpc,
} from "../shared/jobs";
import {
  countDescendants,
  readProcessTable,
  statFile,
  tailFile,
  type ProcessEntry,
} from "./processes";

/** An agent in one of these states cannot be waiting on anything it started. */
const INACTIVE_AGENT_STATUSES = new Set(["idle", "closed", "error", "initializing"]);

/**
 * Providers start their MCP servers and other session plumbing immediately after launch.
 * Those are part of the agent's runtime rather than work it kicked off, so anything that
 * appears in the provider's first moments is treated as setup, not as a job.
 */
const SETUP_GRACE_MS = 15_000;

/**
 * Claude Code names each Bash shell and points its stdout at
 * `<tmp>/claude-<uid>/<project>/<sessionId>/tasks/<shellId>.output`. Other providers do
 * not, so this is read as a bonus — the shell id and a tailable log — never as the way
 * jobs are found.
 */
const CLAUDE_TASK_OUTPUT =
  /\/(?<session>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/tasks\/(?<shell>[^/]+)\.output$/;

/** Claude Code announces every shell it backgrounds, by id, in the session transcript. */
export const BACKGROUND_ANNOUNCEMENT = /running in background with ID: ([A-Za-z0-9_-]+)/g;

export interface AgentInfo {
  id: string;
  title: string | null;
  status: string | null;
  workspaceId: string | null;
  provider: string | null;
  sessionId: string | null;
}

/** Agents the daemon knows about, keyed by agent id. */
export async function listAgents(
  paseo: PluginHandlerContext["paseo"],
): Promise<Map<string, AgentInfo>> {
  const agents = new Map<string, AgentInfo>();
  let entries: readonly unknown[];
  try {
    ({ entries } = await paseo.agents.list());
  } catch {
    return agents;
  }
  for (const entry of entries) {
    const agent = (entry as { agent?: Record<string, unknown> }).agent;
    const id = agent && typeof agent["id"] === "string" ? agent["id"] : null;
    if (!agent || !id) continue;
    const runtimeInfo = agent["runtimeInfo"] as { sessionId?: unknown } | undefined;
    agents.set(id, {
      id,
      title: typeof agent["title"] === "string" ? agent["title"] : null,
      status: typeof agent["status"] === "string" ? agent["status"] : null,
      workspaceId: typeof agent["workspaceId"] === "string" ? agent["workspaceId"] : null,
      provider: typeof agent["provider"] === "string" ? agent["provider"] : null,
      sessionId: typeof runtimeInfo?.sessionId === "string" ? runtimeInfo.sessionId : null,
    });
  }
  return agents;
}

/**
 * Processes still alive when a turn finished. Nothing is waiting on them by definition,
 * so they stay marked as background for the rest of their life — this is what gives
 * providers with no background announcement of their own an exact signal.
 */
const survivedATurn = new Map<string, Set<number>>();

export function recordTurnSurvivors(agentId: string, pids: readonly number[]): void {
  const known = survivedATurn.get(agentId) ?? new Set<number>();
  for (const pid of pids) known.add(pid);
  survivedATurn.set(agentId, known);
}

export function forgetAgent(agentId: string): void {
  survivedATurn.delete(agentId);
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

/** Transcripts are filed under a per-cwd directory, so find the session by file name. */
async function findTranscript(sessionId: string): Promise<string | null> {
  let projects: string[];
  try {
    projects = await readdir(claudeProjectsDir());
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = join(claudeProjectsDir(), project, `${sessionId}.jsonl`);
    if (await statFile(candidate)) return candidate;
  }
  return null;
}

/** Shell ids Claude Code explicitly backgrounded in this session. */
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
      for (const match of buffer.toString("utf8").matchAll(BACKGROUND_ANNOUNCEMENT)) {
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

export interface JobRoot {
  entry: ProcessEntry;
  agentId: string;
  /** The provider process this agent runs in, when it is still alive. */
  provider: ProcessEntry | null;
  detached: boolean;
}

/**
 * The topmost agent-owned process of each piece of work.
 *
 * Every process an agent touches carries its `PASEO_AGENT_ID`, so a job is a process
 * whose parent is *not* also owned by the same agent — either a direct child of the
 * provider, or one that has been reparented away from it. Anything deeper is part of
 * that job rather than a job of its own.
 */
export function findJobRoots(table: Map<number, ProcessEntry>, daemonPid: number): JobRoot[] {
  // Providers are recognised by being the daemon's own children. If the daemon pid is
  // wrong the whole classification inverts silently — providers become jobs and real
  // jobs disappear — so refuse to guess rather than report nonsense.
  if (!table.has(daemonPid)) {
    throw new Error(
      `Paseo daemon process ${daemonPid} is not running; cannot tell provider processes from the jobs they started.`,
    );
  }
  const providers = new Map<string, ProcessEntry>();
  for (const entry of table.values()) {
    if (entry.agentId && entry.stat.ppid === daemonPid) providers.set(entry.agentId, entry);
  }

  const roots: JobRoot[] = [];
  for (const entry of table.values()) {
    const agentId = entry.agentId;
    if (!agentId) continue;
    const provider = providers.get(agentId) ?? null;
    if (provider && entry.stat.pid === provider.stat.pid) continue;
    // The provider is agent-owned too, so its direct children start jobs rather than
    // continue one; anything deeper under another agent-owned process is part of that job.
    const parentIsProvider = provider !== null && entry.stat.ppid === provider.stat.pid;
    const parent = table.get(entry.stat.ppid);
    if (!parentIsProvider && parent?.agentId === agentId) continue;

    const detached = !parentIsProvider;
    // Session plumbing (MCP servers and friends) starts with the provider, not as work.
    const startedWithProvider =
      provider !== null &&
      entry.startedAt.getTime() - provider.startedAt.getTime() < SETUP_GRACE_MS;
    if (startedWithProvider && !detached) continue;

    roots.push({ entry, agentId, provider, detached });
  }
  return roots;
}

function classify(
  root: JobRoot,
  agent: AgentInfo | undefined,
  explicitlyBackgrounded: boolean,
): { kind: JobKind; reason: string } {
  if (explicitlyBackgrounded) {
    return { kind: "background", reason: "the provider backgrounded it" };
  }
  if (root.detached) {
    return { kind: "detached", reason: "it left the agent's process tree" };
  }
  if (survivedATurn.get(root.agentId)?.has(root.entry.stat.pid)) {
    return { kind: "background", reason: "it outlived the turn that started it" };
  }
  if (!agent) {
    return { kind: "background", reason: "its agent is gone" };
  }
  if (INACTIVE_AGENT_STATUSES.has(agent.status ?? "")) {
    return { kind: "background", reason: `its agent is ${agent.status}` };
  }
  return { kind: "active", reason: "its agent is mid-turn and may be waiting on it" };
}

/** Claude Code's task-output path, when this job happens to have one. */
function claudeTaskOutput(entry: ProcessEntry): { sessionId: string; shellId: string } | null {
  if (!entry.stdout) return null;
  const groups = CLAUDE_TASK_OUTPUT.exec(entry.stdout)?.groups;
  const sessionId = groups?.["session"];
  const shellId = groups?.["shell"];
  return sessionId && shellId ? { sessionId, shellId } : null;
}

export interface ScanOptions {
  daemonPid: number;
  paseo: PluginHandlerContext["paseo"];
}

export async function scanJobs({ daemonPid, paseo }: ScanOptions): Promise<BackgroundJob[]> {
  const [table, agents] = await Promise.all([readProcessTable(), listAgents(paseo)]);
  const roots = findJobRoots(table, daemonPid);
  const descendants = countDescendants(
    table,
    roots.map((root) => root.entry.stat.pid),
  );
  const now = Date.now();

  return Promise.all(
    roots.map(async (root): Promise<BackgroundJob> => {
      const agent = agents.get(root.agentId);
      const task = claudeTaskOutput(root.entry);
      const explicit =
        task !== null && (await backgroundShellIds(task.sessionId)).has(task.shellId);
      const { kind, reason } = classify(root, agent, explicit);
      const output = root.entry.stdout ? await statFile(root.entry.stdout) : null;
      return {
        pid: root.entry.stat.pid,
        pgid: root.entry.stat.pgid,
        startedAt: root.entry.startedAt.toISOString(),
        kind,
        reason,
        agentId: root.agentId,
        agentTitle: agent?.title ?? null,
        agentStatus: agent?.status ?? null,
        workspaceId: agent?.workspaceId ?? null,
        provider: agent?.provider ?? null,
        shellId: task?.shellId ?? null,
        command: root.entry.command,
        cwd: root.entry.cwd,
        elapsedSeconds: Math.max(0, (now - root.entry.startedAt.getTime()) / 1_000),
        cpuSeconds: root.entry.stat.cpuSeconds,
        state: root.entry.stat.state,
        descendants: descendants.get(root.entry.stat.pid) ?? 0,
        outputBytes: output?.size ?? null,
        outputUpdatedAt: output?.mtime.toISOString() ?? null,
        orphaned: !agent || INACTIVE_AGENT_STATUSES.has(agent.status ?? ""),
      };
    }),
  );
}

export function createHandlers(daemonPid: number) {
  /** Resolve a reference to a live job so output and stop can never touch another process. */
  const requireJob = async (
    pid: number,
    startedAt: string,
    paseo: PluginHandlerContext["paseo"],
  ) => {
    const job = (await scanJobs({ daemonPid, paseo })).find((candidate) => candidate.pid === pid);
    if (!job) throw new Error(`No agent job is running as PID ${pid}.`);
    if (job.startedAt !== startedAt) {
      throw new Error(`PID ${pid} has been reused since it was listed.`);
    }
    return job;
  };

  const listBackgroundJobs = async (
    { agentId, includeActive = true }: RpcInput<typeof listBackgroundJobsRpc>,
    { paseo }: PluginHandlerContext,
  ) => {
    const jobs = (await scanJobs({ daemonPid, paseo }))
      .filter((job) => (agentId ? job.agentId === agentId : true))
      .filter((job) => (includeActive ? true : job.kind !== "active"))
      .sort((left, right) => right.elapsedSeconds - left.elapsedSeconds);
    return { jobs, scannedAt: new Date().toISOString() };
  };

  const readJobOutput = async (
    { pid, startedAt }: RpcInput<typeof readJobOutputRpc>,
    { paseo }: PluginHandlerContext,
  ) => {
    const job = await requireJob(pid, startedAt, paseo);
    const stdout = (await readProcessTable()).get(job.pid)?.stdout;
    const tail = stdout ? await tailFile(stdout, MAX_OUTPUT_BYTES) : null;
    if (!tail) return { text: "", bytes: 0, truncated: false, available: false };
    return { ...tail, available: true };
  };

  const killBackgroundJob = async (
    { pid, startedAt, signal = "SIGTERM" }: RpcInput<typeof killBackgroundJobRpc>,
    { paseo }: PluginHandlerContext,
  ) => {
    const job = await requireJob(pid, startedAt, paseo);
    // A job normally leads its own process group, so signalling the group takes its
    // children with it. Fall back to the lone pid when it shares a group with others.
    const ownsGroup = job.pgid === job.pid;
    try {
      process.kill(ownsGroup ? -job.pgid : job.pid, signal);
    } catch (error) {
      return { killed: false, message: error instanceof Error ? error.message : String(error) };
    }
    return {
      killed: true,
      message: ownsGroup
        ? `Sent ${signal} to process group ${job.pgid}.`
        : `Sent ${signal} to PID ${job.pid}.`,
    };
  };

  return { listBackgroundJobs, readJobOutput, killBackgroundJob };
}
