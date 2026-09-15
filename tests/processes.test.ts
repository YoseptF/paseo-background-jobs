import { describe, expect, it } from "vitest";
import {
  countDescendants,
  parseProcStat,
  readEnvValue,
  unwrapCommand,
  type ProcessEntry,
} from "../server/processes";
import { formatBytes, formatElapsed } from "../shared/jobs";

describe("parseProcStat", () => {
  it("survives a comm containing spaces and parentheses", () => {
    const raw = "4242 (my (odd) proc) S 1200 4242 4242 0 -1 0 0 0 0 0 150 50 0 0 20 0 1 0 999 0 0";
    expect(parseProcStat(4242, raw)).toEqual({
      pid: 4242,
      ppid: 1200,
      pgid: 4242,
      state: "S",
      cpuSeconds: 2,
    });
  });

  it("returns null for a line it cannot read", () => {
    expect(parseProcStat(1, "garbage without a paren")).toBeNull();
  });
});

describe("readEnvValue", () => {
  it("finds a variable among NUL-separated entries", () => {
    const environ = "PATH=/usr/bin\0PASEO_AGENT_ID=abc-123\0HOME=/home/me\0";
    expect(readEnvValue(environ, "PASEO_AGENT_ID")).toBe("abc-123");
  });

  it("does not match a variable that merely ends with the name", () => {
    expect(readEnvValue("NOT_PASEO_AGENT_ID=nope\0", "PASEO_AGENT_ID")).toBeNull();
  });

  it("returns null when the variable is absent", () => {
    expect(readEnvValue("PATH=/usr/bin\0", "PASEO_AGENT_ID")).toBeNull();
  });
});

describe("unwrapCommand", () => {
  it("recovers the agent's command from a shell snapshot preamble", () => {
    const cmdline = [
      "/usr/bin/zsh",
      "-c",
      `source /home/me/.claude/shell-snapshots/snap.sh 2>/dev/null || true && eval 'until grep -qE '"'"'VERDICT'"'"' "$OUT"; do sleep 3; done' < /dev/null && pwd -P >| /tmp/claude-9fd9-cwd`,
    ].join("\0");
    expect(unwrapCommand(cmdline)).toBe(`until grep -qE 'VERDICT' "$OUT"; do sleep 3; done`);
  });

  it("falls back to the raw argv when there is no preamble", () => {
    expect(unwrapCommand("node\0server.js\0--port\x003000")).toBe("node server.js --port 3000");
  });
});

function entry(pid: number, ppid: number): ProcessEntry {
  return {
    stat: { pid, ppid, pgid: pid, state: "S", cpuSeconds: 0 },
    agentId: null,
    stdout: null,
    command: "",
    cwd: "/",
    startedAt: new Date(0),
  };
}

describe("countDescendants", () => {
  it("counts a whole subtree, not just direct children", () => {
    const table = new Map([
      [10, entry(10, 1)],
      [11, entry(11, 10)],
      [12, entry(12, 11)],
      [13, entry(13, 10)],
      [20, entry(20, 1)],
    ]);
    expect(countDescendants(table, [10, 20])).toEqual(new Map([
      [10, 3],
      [20, 0],
    ]));
  });
});

describe("formatters", () => {
  it("formats elapsed time by magnitude", () => {
    expect(formatElapsed(9)).toBe("9s");
    expect(formatElapsed(83)).toBe("1m 23s");
    expect(formatElapsed(7_400)).toBe("2h 3m");
  });

  it("formats byte counts by magnitude", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1_024 * 1_024)).toBe("5.0 MB");
  });
});
