# Changelog

## 0.2.0

- **Works with every provider, not just Claude Code.** Jobs are now attributed through the
  inherited `PASEO_AGENT_ID` environment variable rather than Claude Code's task-output
  paths, so Codex, Gemini and anything else Paseo launches are covered.
- Detached processes are found. A job that `setsid`/`nohup`s itself away from the agent is
  now detected and labelled `detached`; previously it was a documented blind spot.
- Jobs are labelled `background`, `detached`, or `active`, with the reason shown. `active`
  jobs are hidden by default and excluded from the pill count.
- `agent.turn_ended` now marks anything that outlived a turn as background, for providers
  that do not announce backgrounding themselves.
- Output tailing generalised to any job whose stdout is a regular file.
- Stop and output now guard on PID start time instead of a Claude-specific shell id.

## 0.1.0

- Initial release.
- Sidebar surface listing every live background job across agents, and an agent-scoped panel.
- Composer pill with a live count, a `/jobs` slash command, and a Command Center entry.
- Per-job output tail, elapsed time, PID, process state, CPU time, and child count.
- `SIGTERM` / `SIGKILL` stop, signalling the job's process group, guarded against PID reuse.
