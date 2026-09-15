import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Poll cadence for the pill count and the panels, in milliseconds. */
export const JOB_POLL_MS = 4_000;
/** Largest output tail the daemon will return for one job. */
export const MAX_OUTPUT_BYTES = 64_000;

export const backgroundJobSchema = z.object({
  /** PID of the shell the provider backgrounded. */
  pid: z.number().int(),
  /** Process group; the whole group is signalled when the job is killed. */
  pgid: z.number().int(),
  /** Provider-assigned shell id, e.g. `b6rsaz396`. */
  shellId: z.string(),
  /** Provider session the job belongs to. */
  sessionId: z.string(),
  agentId: z.string().nullable(),
  agentTitle: z.string().nullable(),
  agentStatus: z.string().nullable(),
  workspaceId: z.string().nullable(),
  /** The command the agent actually ran, unwrapped from the provider's shell preamble. */
  command: z.string(),
  cwd: z.string(),
  startedAt: z.string(),
  elapsedSeconds: z.number(),
  cpuSeconds: z.number(),
  /** procfs state letter: R running, S sleeping, D uninterruptible, Z zombie. */
  state: z.string(),
  descendants: z.number().int(),
  outputBytes: z.number().int(),
  outputUpdatedAt: z.string().nullable(),
  /** The job outlived its agent's turn: still alive while the agent sits idle, closed, or gone. */
  orphaned: z.boolean(),
});

export type BackgroundJob = z.output<typeof backgroundJobSchema>;

export const listBackgroundJobsRpc = defineRpc({
  name: "background-jobs.list",
  input: z.object({ agentId: z.string().optional() }),
  output: z.object({
    jobs: z.array(backgroundJobSchema),
    scannedAt: z.string(),
  }),
});

export const readJobOutputRpc = defineRpc({
  name: "background-jobs.output",
  input: z.object({ pid: z.number().int(), shellId: z.string() }),
  output: z.object({
    text: z.string(),
    bytes: z.number().int(),
    truncated: z.boolean(),
  }),
});

export const killBackgroundJobRpc = defineRpc({
  name: "background-jobs.kill",
  input: z.object({
    pid: z.number().int(),
    shellId: z.string(),
    signal: z.enum(["SIGTERM", "SIGKILL"]).optional(),
  }),
  output: z.object({ killed: z.boolean(), message: z.string() }),
});

export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
