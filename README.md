# Background Jobs

A [Paseo](https://paseo.sh) plugin that shows what your agents left running — the
dev server, the `tail -f`, the stuck `until` loop — and lets you stop it.

Paseo marks an agent idle as soon as its turn ends. If that turn started something that
outlives the turn, nothing in the UI says so: the sidebar shows a stopped agent while the
process keeps running. This plugin lists those processes, attributes each one to the agent
that started it, tails their output, and stops them.

Works with **any provider** — Claude Code, Codex, Gemini, and anything else Paseo can launch.

## Install

```bash
paseo plugin add YoseptF/paseo-background-jobs
```

Then reload the app. The plugin adds:

| Surface | Where |
| --- | --- |
| **Background jobs** sidebar item | every live job, across all agents |
| **Background jobs** agent panel | just this agent's jobs |
| Composer pill | live count, shown only while an agent has jobs |
| `/jobs` slash command | opens the panel for the current agent |
| Command Center: *Show background jobs* | opens the sidebar surface |

Each job shows elapsed time, PID, process state, CPU time, child count, output size, and
the agent that started it. **Stop** sends `SIGTERM` to the job's process group; long-press
sends `SIGKILL`.

Jobs are labelled by how sure we are that nothing is waiting on them:

| Label | Meaning |
| --- | --- |
| `background` | the provider said it backgrounded this, it outlived the turn that started it, or its agent is no longer running |
| `detached` | the process escaped the agent's process tree entirely |
| `active` | the agent is mid-turn and may still be waiting on this one |

`active` jobs are hidden by default and excluded from the pill count, so the count does not
flicker once per command while an agent works. Toggle **in-turn** to see them.

## How it works

Paseo exports `PASEO_AGENT_ID` into every provider process it launches, and the environment
is inherited by everything that process spawns. So the plugin walks `/proc` once, reads that
variable, and knows exactly which agent every process on the machine belongs to — without
knowing anything about the provider that started it.

A *job* is then the topmost agent-owned process of a piece of work: one whose parent is the
provider itself, or one that has been reparented away from it. Anything deeper is part of
that job rather than a job of its own. The provider process, and the session plumbing it
starts in its first seconds (MCP servers and friends), are excluded.

Because attribution is by inherited environment rather than by process tree, a job is still
attributed correctly after it detaches — a `setsid`/`nohup` process reparented to init is
found and labelled `detached`, which is usually the one you most wanted to know about.

On top of that generic base, two extra signals sharpen the `background` label:

- Paseo's `agent.turn_ended` hook: anything still alive when a turn finishes is by
  definition not being waited on, and stays marked for the rest of its life. This works for
  every provider.
- Claude Code names each Bash shell and announces the ones it backgrounds in the session
  transcript, which is read incrementally from the last byte offset. When that signal is
  present a job is known to be background immediately, without waiting for the turn to end.

Stopping a job re-resolves the PID and checks its start time still matches before signalling,
so a recycled PID can never be hit by a stale row.

## Known limitations

- The daemon host must be Linux: attribution reads `/proc`.
- Codex runs shell commands inside a sandbox in its default modes and reaps the sandbox when
  the command returns, so a process it backgrounds usually does not survive to be listed.
  This is Codex's behaviour, not a detection gap; jobs it starts in full-access mode are
  found normally.
- The output tail only works when the job's stdout is a regular file — Claude Code's task
  logs, or anything the agent redirected itself. Providers that pipe output instead show the
  job without a tail.
- Work started before the plugin was installed is still found, but its `background` label may
  rely on its agent no longer running, since no turn boundary was observed for it.
- Jobs are visible to the daemon on whose machine they run.

## Development

```bash
bun install
bun run typecheck
bun run test
paseo plugin reload background-jobs
```

`paseo plugin logs background-jobs` tails the daemon-side handler output.

## License

MIT
