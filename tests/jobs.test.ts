import { describe, expect, it } from "vitest";
import { BACKGROUND_ANNOUNCEMENT, findJobRoots } from "../server/jobs";
import type { ProcessEntry } from "../server/processes";

const DAEMON = 100;
const PROVIDER_START = new Date("2026-01-01T10:00:00Z");

interface Spec {
  pid: number;
  ppid: number;
  agentId?: string;
  /** Seconds after the provider started. */
  after?: number;
  command?: string;
}

function table(...specs: Spec[]): Map<number, ProcessEntry> {
  const entries = [{ pid: DAEMON, ppid: 1 }, ...specs].map((spec): [number, ProcessEntry] => [
    spec.pid,
    {
      stat: { pid: spec.pid, ppid: spec.ppid, pgid: spec.pid, state: "S", cpuSeconds: 0 },
      agentId: spec.agentId ?? null,
      stdout: null,
      command: spec.command ?? `cmd-${spec.pid}`,
      cwd: "/work",
      startedAt: new Date(PROVIDER_START.getTime() + (spec.after ?? 0) * 1_000),
    },
  ]);
  return new Map(entries);
}

const roots = (map: Map<number, ProcessEntry>) =>
  findJobRoots(map, DAEMON)
    .map((root) => root.entry.stat.pid)
    .sort((left, right) => left - right);

describe("findJobRoots", () => {
  it("never reports the provider process itself as a job", () => {
    expect(roots(table({ pid: 200, ppid: DAEMON, agentId: "a" }))).toEqual([]);
  });

  it("reports work the agent started after its session came up", () => {
    const map = table(
      { pid: 200, ppid: DAEMON, agentId: "a" },
      { pid: 300, ppid: 200, agentId: "a", after: 600 },
    );
    expect(roots(map)).toEqual([300]);
  });

  it("ignores session plumbing that starts with the provider", () => {
    const map = table(
      { pid: 200, ppid: DAEMON, agentId: "a" },
      { pid: 300, ppid: 200, agentId: "a", after: 1, command: "npm exec @playwright/mcp" },
      { pid: 301, ppid: 300, agentId: "a", after: 2 },
    );
    expect(roots(map)).toEqual([]);
  });

  it("treats a process reparented away from the provider as detached, even at startup", () => {
    const map = table(
      { pid: 200, ppid: DAEMON, agentId: "a" },
      { pid: 300, ppid: 1, agentId: "a", after: 1 },
    );
    const [root] = findJobRoots(map, DAEMON);
    expect(root?.entry.stat.pid).toBe(300);
    expect(root?.detached).toBe(true);
  });

  it("collapses a job's own subtree onto one root", () => {
    const map = table(
      { pid: 200, ppid: DAEMON, agentId: "a" },
      { pid: 300, ppid: 200, agentId: "a", after: 600 },
      { pid: 301, ppid: 300, agentId: "a", after: 601 },
      { pid: 302, ppid: 301, agentId: "a", after: 602 },
    );
    expect(roots(map)).toEqual([300]);
  });

  it("keeps each agent's jobs separate, whatever provider they run", () => {
    const map = table(
      { pid: 200, ppid: DAEMON, agentId: "claude-agent" },
      { pid: 210, ppid: DAEMON, agentId: "codex-agent" },
      { pid: 220, ppid: DAEMON, agentId: "gemini-agent" },
      { pid: 300, ppid: 200, agentId: "claude-agent", after: 600 },
      { pid: 310, ppid: 210, agentId: "codex-agent", after: 600 },
      { pid: 320, ppid: 220, agentId: "gemini-agent", after: 600 },
    );
    expect(
      findJobRoots(map, DAEMON)
        .map((root) => `${root.agentId}:${root.entry.stat.pid}`)
        .sort(),
    ).toEqual(["claude-agent:300", "codex-agent:310", "gemini-agent:320"]);
  });

  it("ignores processes that carry no agent id at all", () => {
    const map = table({ pid: 200, ppid: DAEMON, agentId: "a" }, { pid: 900, ppid: 1 });
    expect(roots(map)).toEqual([]);
  });

  it("still finds work whose provider process has already exited", () => {
    const map = table({ pid: 300, ppid: 1, agentId: "a", after: 600 });
    const [root] = findJobRoots(map, DAEMON);
    expect(root?.entry.stat.pid).toBe(300);
    expect(root?.provider).toBeNull();
  });
});

describe("daemon identification", () => {
  it("refuses to classify when the daemon pid is not a live process", () => {
    const map = table({ pid: 200, ppid: DAEMON, agentId: "a" });
    expect(() => findJobRoots(map, 999_999)).toThrow(/not running/);
  });
});

describe("BACKGROUND_ANNOUNCEMENT", () => {
  it("collects every shell id Claude Code backgrounded", () => {
    const transcript = [
      "Command running in background with ID: byjp77cd1. Output is at /tmp/x",
      "an unrelated line mentioning background",
      "Command running in background with ID: b6rsaz396. Output is at /tmp/y",
    ].join("\n");
    expect([...transcript.matchAll(BACKGROUND_ANNOUNCEMENT)].map((m) => m[1])).toEqual([
      "byjp77cd1",
      "b6rsaz396",
    ]);
  });
});
