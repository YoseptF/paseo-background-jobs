import { describe, expect, it } from "vitest";
import {
  BACKGROUND_ANNOUNCEMENT,
  OUTPUT_PATH,
  parseProcStat,
  unwrapCommand,
} from "../server/jobs";
import { formatBytes, formatElapsed } from "../shared/jobs";

const TASK_OUTPUT =
  "/tmp/claude-1000/-home-yosept-Documents-clad/d05b9aee-824f-46b1-a2a9-e52543ee8251/tasks/b6rsaz396.output";

describe("OUTPUT_PATH", () => {
  it("pulls the session and shell id out of a task output path", () => {
    const groups = OUTPUT_PATH.exec(TASK_OUTPUT)?.groups;
    expect(groups?.["session"]).toBe("d05b9aee-824f-46b1-a2a9-e52543ee8251");
    expect(groups?.["shell"]).toBe("b6rsaz396");
  });

  it("ignores unrelated redirections", () => {
    expect(OUTPUT_PATH.exec("/dev/null")).toBeNull();
    expect(OUTPUT_PATH.exec("/home/me/build.log")).toBeNull();
    expect(OUTPUT_PATH.exec("/tmp/claude-1000/project/tasks/b1.output")).toBeNull();
  });
});

describe("parseProcStat", () => {
  it("survives a comm containing spaces and parentheses", () => {
    const raw = `4242 (my (odd) proc) S 1200 4242 4242 0 -1 0 0 0 0 0 150 50 0 0 20 0 1 0 999 0 0`;
    const stat = parseProcStat(4242, raw);
    expect(stat).toEqual({ pid: 4242, ppid: 1200, pgid: 4242, state: "S", cpuSeconds: 2 });
  });

  it("returns null for a truncated line", () => {
    expect(parseProcStat(1, "garbage without a paren")).toBeNull();
  });
});

describe("unwrapCommand", () => {
  it("recovers the agent's command from the shell snapshot preamble", () => {
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

describe("BACKGROUND_ANNOUNCEMENT", () => {
  it("collects every shell id the provider backgrounded", () => {
    const transcript = [
      'Command running in background with ID: byjp77cd1. Output is being written to: /tmp/x',
      'unrelated line mentioning background',
      'Command running in background with ID: b6rsaz396. Output is being written to: /tmp/y',
    ].join("\n");
    const ids = [...transcript.matchAll(BACKGROUND_ANNOUNCEMENT)].map((match) => match[1]);
    expect(ids).toEqual(["byjp77cd1", "b6rsaz396"]);
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
