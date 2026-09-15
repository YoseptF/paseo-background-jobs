import type { PluginServerContext } from "@getpaseo/plugin/server";
import { killBackgroundJob, listBackgroundJobs, readJobOutput } from "./server/jobs";
import { killBackgroundJobRpc, listBackgroundJobsRpc, readJobOutputRpc } from "./shared/jobs";

export default function contribute(server: PluginServerContext) {
  server.handle(listBackgroundJobsRpc, listBackgroundJobs);
  server.handle(readJobOutputRpc, readJobOutput);
  server.handle(killBackgroundJobRpc, killBackgroundJob);
  return () => {};
}
