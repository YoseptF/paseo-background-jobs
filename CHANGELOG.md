# Changelog

## 0.1.0

- Initial release.
- Sidebar surface listing every live background job across agents, and an agent-scoped panel.
- Composer pill with a live count, a `/jobs` slash command, and a Command Center entry.
- Per-job output tail, elapsed time, PID, process state, CPU time, and child count.
- `SIGTERM` / `SIGKILL` stop, signalling the job's process group, guarded against PID reuse.
- Jobs outliving an idle, closed, or missing agent are highlighted.
