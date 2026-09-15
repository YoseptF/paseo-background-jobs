import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Poll cadence for the pill count and the panels, in milliseconds. */
export const JOB_POLL_MS = 4_000;
/** Largest output tail the daemon will return for one job. */
export const MAX_OUTPUT_BYTES = 64_000;

/**
 * - `background` the agent is not waiting on this, confirmed by the provider, by the
 *   process surviving a finished turn, or by the agent no longer running at all.
 * - `detached` the process escaped the agent's process tree entirely.
 * - `active` the agent is mid-turn and may still be waiting on this one.
 */
export const jobKindSchema = z.enum(["background", "detached", "active"]);
export type JobKind = z.output<typeof jobKindSchema>;

export const backgroundJobSchema = z.object({
  pid: z.number().int(),
  /** Process group; the whole group is signalled when the job is stopped. */
  pgid: z.number().int(),
  /** Doubles as the guard against acting on a recycled PID. */
  startedAt: z.string(),
  kind: jobKindSchema,
  /** Short human explanation of why the job carries that kind. */
  reason: z.string(),
  agentId: z.string().nullable(),
  agentTitle: z.string().nullable(),
  agentStatus: z.string().nullable(),
  workspaceId: z.string().nullable(),
  provider: z.string().nullable(),
  /** Provider-assigned shell id, when the provider names its shells (Claude Code does). */
  shellId: z.string().nullable(),
  command: z.string(),
  cwd: z.string(),
  elapsedSeconds: z.number(),
  cpuSeconds: z.number(),
  /** procfs state letter: R running, S sleeping, D uninterruptible, Z zombie. */
  state: z.string(),
  descendants: z.number().int(),
  /** Only set when the job's stdout is a regular file we can tail. */
  outputBytes: z.number().int().nullable(),
  outputUpdatedAt: z.string().nullable(),
  /** The agent that started this job is idle, closed, or gone. */
  orphaned: z.boolean(),
});

export type BackgroundJob = z.output<typeof backgroundJobSchema>;

/** Identifies a job and proves the PID has not been recycled since it was listed. */
const jobRefSchema = z.object({ pid: z.number().int(), startedAt: z.string() });

export const listBackgroundJobsRpc = defineRpc({
  name: "background-jobs.list",
  input: z.object({ agentId: z.string().optional(), includeActive: z.boolean().optional() }),
  output: z.object({ jobs: z.array(backgroundJobSchema), scannedAt: z.string() }),
});

export const readJobOutputRpc = defineRpc({
  name: "background-jobs.output",
  input: jobRefSchema,
  output: z.object({
    text: z.string(),
    bytes: z.number().int(),
    truncated: z.boolean(),
    /** Absent when the provider pipes output instead of writing it to a file. */
    available: z.boolean(),
  }),
});

export const killBackgroundJobRpc = defineRpc({
  name: "background-jobs.kill",
  input: jobRefSchema.extend({ signal: z.enum(["SIGTERM", "SIGKILL"]).optional() }),
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
