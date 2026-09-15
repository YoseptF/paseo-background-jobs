import { open, readFile, readdir, readlink, stat } from "node:fs/promises";

/**
 * Paseo exports `PASEO_AGENT_ID` into every provider process it launches, and the
 * environment is inherited, so any process an agent spawns carries the id of the agent
 * that spawned it — whatever provider that agent runs, and even after the process is
 * reparented away from the provider. This is the whole basis for attribution here; it
 * replaces per-provider conventions like Claude Code's task-output paths.
 */
export const AGENT_ID_VAR = "PASEO_AGENT_ID";

const CLOCK_TICKS_PER_SECOND = 100;

export interface ProcStat {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  cpuSeconds: number;
}

export interface ProcessEntry {
  stat: ProcStat;
  agentId: string | null;
  /** Where stdout points, when it is readable. */
  stdout: string | null;
  command: string;
  cwd: string;
  startedAt: Date;
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

export function readEnvValue(environ: string, name: string): string | null {
  for (const entry of environ.split("\0")) {
    if (entry.startsWith(`${name}=`)) return entry.slice(name.length + 1);
  }
  return null;
}

/** Providers wrap a command in a shell-snapshot preamble; this recovers what the agent wrote. */
const EVAL_COMMAND = /&&\s*eval\s+'([\s\S]*?)'\s*<\s*\/dev\/null/;

export function unwrapCommand(cmdline: string): string {
  const argv = cmdline.split("\0").filter((part) => part.length > 0);
  const joined = argv.join(" ");
  const command = EVAL_COMMAND.exec(joined)?.[1] ?? joined;
  // zsh -c 'eval ...' escapes an embedded single quote as '"'"'.
  return command.replaceAll(`'"'"'`, "'").trim();
}

/**
 * The environment never changes after exec, and reading it for every process on every
 * poll is the expensive part of a scan, so keep it keyed by pid and start time — a
 * recycled pid gets a different start time and so misses the cache.
 */
const agentIdCache = new Map<number, { startedAtMs: number; agentId: string | null }>();

async function readAgentId(pid: number, startedAtMs: number): Promise<string | null> {
  const cached = agentIdCache.get(pid);
  if (cached && cached.startedAtMs === startedAtMs) return cached.agentId;
  let agentId: string | null = null;
  try {
    agentId = readEnvValue(await readFile(`/proc/${pid}/environ`, "utf8"), AGENT_ID_VAR);
  } catch {
    agentId = null;
  }
  agentIdCache.set(pid, { startedAtMs, agentId });
  return agentId;
}

/** One pass over /proc per refresh, shared by every consumer of the snapshot. */
export async function readProcessTable(): Promise<Map<number, ProcessEntry>> {
  const uid = process.getuid?.();
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return new Map();
  }
  const table = new Map<number, ProcessEntry>();
  const live = new Set<number>();
  await Promise.all(
    names.map(async (name) => {
      if (!/^\d+$/.test(name)) return;
      const pid = Number(name);
      let procStat: ProcStat | null;
      let startedAt: Date;
      try {
        const info = await stat(`/proc/${name}`);
        if (uid !== undefined && info.uid !== uid) return;
        startedAt = info.ctime;
        procStat = parseProcStat(pid, await readFile(`/proc/${name}/stat`, "utf8"));
      } catch {
        return;
      }
      if (!procStat) return;
      live.add(pid);
      const [agentId, stdout, command, cwd] = await Promise.all([
        readAgentId(pid, startedAt.getTime()),
        readlink(`/proc/${name}/fd/1`).catch(() => null),
        readFile(`/proc/${name}/cmdline`, "utf8")
          .then(unwrapCommand)
          .catch(() => ""),
        readlink(`/proc/${name}/cwd`).catch(() => ""),
      ]);
      table.set(pid, { stat: procStat, agentId, stdout, command, cwd, startedAt });
    }),
  );
  for (const pid of agentIdCache.keys()) {
    if (!live.has(pid)) agentIdCache.delete(pid);
  }
  return table;
}

/** Transitive child count per root, so a job reads as more than the one process being signalled. */
export function countDescendants(
  table: Map<number, ProcessEntry>,
  roots: readonly number[],
): Map<number, number> {
  const children = new Map<number, number[]>();
  for (const { stat: procStat } of table.values()) {
    const siblings = children.get(procStat.ppid);
    if (siblings) siblings.push(procStat.pid);
    else children.set(procStat.ppid, [procStat.pid]);
  }
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

/** Tail a regular file, for jobs whose stdout the provider pointed at one. */
export async function tailFile(path: string, maxBytes: number) {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) return null;
  const start = Math.max(0, info.size - maxBytes);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return { text: buffer.toString("utf8"), bytes: info.size, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

export async function statFile(path: string) {
  const info = await stat(path).catch(() => null);
  return info?.isFile() ? info : null;
}
