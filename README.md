# Background Jobs

A [Paseo](https://paseo.sh) plugin that surfaces the shells your Claude Code agents
backgrounded — including the ones still running after the agent went idle.

Paseo shows an agent as idle once its turn ends. If that turn left a `sleep`-loop, a dev
server, a `tail -f`, or a stuck `until` guard running in the background, nothing in the UI
says so. This plugin lists those processes, shows their live output, and lets you stop them.

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

Each job shows how long it has run, its PID, process state, CPU time, child count, and how
much output it has produced. **Stop** sends `SIGTERM` to the job's process group; long-press
(or hold) sends `SIGKILL`. A job whose agent is idle, closed, or gone is highlighted as
outliving its agent.

## How it works

Claude Code points a Bash tool's stdout at
`$TMPDIR/claude-<uid>/<project>/<sessionId>/tasks/<shellId>.output`. The daemon-side handler
walks `/proc`, finds every process of yours whose `fd/1` resolves into that path, and reads
the session and shell id straight out of it.

That alone is not enough: a *foreground* shell the agent is still blocked on is
indistinguishable from a backgrounded one in procfs — same own process group and session,
`/dev/null` on stdin, same output file. So the handler also reads the session transcript
under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR`) and keeps only shells the provider
announced as `running in background with ID: <shellId>`. Transcripts are read incrementally
from the last byte offset, so polling stays cheap on multi-megabyte sessions.

Sessions are matched back to Paseo agents through the `runtimeInfo.sessionId` the daemon
already tracks, so each job is attributed to the agent that started it.

`Stop` re-resolves the PID to a live job and checks the shell id still matches before
signalling, so a recycled PID can never be hit by a stale row.

## Known limitations

- Claude Code only. Other providers do not use the same task-output convention, so their
  background work will not appear.
- Linux only. The scanner reads `/proc`, so it does not run on a macOS or Windows daemon.
- Processes fully detached from the agent (`setsid`, `nohup`, a service the agent started
  through `systemctl`) redirect their own output and will not be listed.
- Jobs are only visible while their process is alive; this is a live process view, not a
  history of everything the agent backgrounded.
- The plugin reports on the daemon host it runs on, so a job is only visible to the daemon
  whose machine it is running on.

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
