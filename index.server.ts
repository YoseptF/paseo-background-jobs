import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createHandlers, findJobRoots, forgetAgent, recordTurnSurvivors } from "./server/jobs";
import { readProcessTable } from "./server/processes";
import { killBackgroundJobRpc, listBackgroundJobsRpc, readJobOutputRpc } from "./shared/jobs";

export default function contribute(server: PluginServerContext) {
  // Paseo's daemon spawns both this plugin host and every provider process, so our own
  // parent identifies the provider processes and separates an agent's provider from the
  // work that agent started.
  const daemonPid = process.ppid;
  const { listBackgroundJobs, readJobOutput, killBackgroundJob } = createHandlers(daemonPid);

  server.handle(listBackgroundJobsRpc, listBackgroundJobs);
  server.handle(readJobOutputRpc, readJobOutput);
  server.handle(killBackgroundJobRpc, killBackgroundJob);

  // Anything the agent started that is still alive once its turn ends is, by definition,
  // not being waited on. This is the background signal for providers that do not announce
  // one themselves.
  server.on("agent.turn_ended", async ({ agent }) => {
    const table = await readProcessTable();
    const survivors = findJobRoots(table, daemonPid)
      .filter((root) => root.agentId === agent.id)
      .map((root) => root.entry.stat.pid);
    if (survivors.length > 0) recordTurnSurvivors(agent.id, survivors);
  });

  server.on("agent.archived", ({ agent }) => forgetAgent(agent.id));

  return () => {};
}
