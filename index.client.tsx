import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  BackgroundJobsPanel,
  BackgroundJobsSurface,
  contributeBackgroundJobsClient,
} from "./client/jobs";

export default function contribute(client: PluginClientContext) {
  client.addSurface("background-jobs", BackgroundJobsSurface);
  client.addSidebarItem({
    id: "background-jobs",
    title: "Background jobs",
    icon: "Activity",
    surface: "background-jobs",
  });
  client.addWorkspacePanel({
    id: "background-jobs",
    title: "Background jobs",
    icon: "Activity",
    context: "agent",
    Component: BackgroundJobsPanel,
  });
  client.addCommandCenterItem({
    id: "open-background-jobs",
    title: "Show background jobs",
    icon: "Activity",
    keywords: ["background", "jobs", "processes", "shells", "running"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("background-jobs");
    },
  });
  client.addSlashCommand({
    name: "jobs",
    description: "Show background jobs still running for this agent",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel("background-jobs");
    },
  });

  return contributeBackgroundJobsClient(client);
}
