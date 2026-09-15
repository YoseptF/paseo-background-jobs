import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type PluginAgentPanelProps,
  type PluginClientContext,
  type PluginSurfaceProps,
  useRpc,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  JOB_POLL_MS,
  formatBytes,
  formatElapsed,
  killBackgroundJobRpc,
  listBackgroundJobsRpc,
  readJobOutputRpc,
  type BackgroundJob,
} from "../shared/jobs";

type Theme = PluginSurfaceProps["theme"];
type Navigation = PluginSurfaceProps["navigation"];

const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
const RADIUS = { sm: 6, md: 10 } as const;
const TYPE = { caption: 11, body: 13, title: 15, heading: 18 } as const;
const OUTPUT_LINES = 24;

const JOBS_KEY = ["background-jobs", "list"] as const;

function useJobs(agentId?: string) {
  const listJobs = useRpc(listBackgroundJobsRpc);
  return useQuery({
    queryKey: [...JOBS_KEY, agentId ?? "all"],
    queryFn: () => listJobs(agentId ? { agentId } : {}),
    refetchInterval: JOB_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

function stateLabel(state: string): string {
  if (state.startsWith("R")) return "running";
  if (state.startsWith("D")) return "blocked on I/O";
  if (state.startsWith("Z")) return "zombie";
  if (state.startsWith("T")) return "stopped";
  return "sleeping";
}

function statusColor(job: BackgroundJob, theme: Theme): string {
  if (job.state.startsWith("Z")) return theme.colors.statusDanger;
  if (job.orphaned) return theme.colors.statusWarning;
  return theme.colors.statusSuccess;
}

function JobOutput({ job, theme }: { job: BackgroundJob; theme: Theme }) {
  const readOutput = useRpc(readJobOutputRpc);
  const query = useQuery({
    queryKey: ["background-jobs", "output", job.pid, job.shellId],
    queryFn: () => readOutput({ pid: job.pid, shellId: job.shellId }),
    refetchInterval: JOB_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const body = useMemo(() => {
    if (query.isPending) return "Reading output…";
    if (query.isError) return query.error instanceof Error ? query.error.message : "Output unavailable.";
    const text = query.data?.text.trimEnd() ?? "";
    if (text.length === 0) return "No output yet.";
    return text.split("\n").slice(-OUTPUT_LINES).join("\n");
  }, [query.data, query.error, query.isError, query.isPending]);

  return (
    <View
      style={{
        marginTop: SPACE.sm,
        padding: SPACE.sm,
        borderRadius: RADIUS.sm,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontFamily: "monospace",
          fontSize: TYPE.caption,
        }}
      >
        {body}
      </Text>
    </View>
  );
}

function JobCard({
  job,
  theme,
  showAgent,
  navigation,
}: {
  job: BackgroundJob;
  theme: Theme;
  showAgent: boolean;
  navigation: Navigation;
}) {
  const [expanded, setExpanded] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();
  const killJob = useRpc(killBackgroundJobRpc);

  const kill = useMutation({
    mutationFn: (signal: "SIGTERM" | "SIGKILL") =>
      killJob({ pid: job.pid, shellId: job.shellId, signal }),
    onSuccess: (result) => {
      toast.show(result.message, { variant: result.killed ? "success" : "error" });
      void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const openAgent = useCallback(() => {
    if (job.agentId) navigation?.openAgent({ agentId: job.agentId });
  }, [job.agentId, navigation]);

  const meta = [
    `PID ${job.pid}`,
    stateLabel(job.state),
    job.descendants > 0 ? `${job.descendants} child${job.descendants === 1 ? "" : "ren"}` : null,
    `${formatBytes(job.outputBytes)} out`,
    `${job.cpuSeconds.toFixed(1)}s cpu`,
  ]
    .filter((part): part is string => part !== null)
    .join("  ·  ");

  return (
    <View
      style={{
        padding: SPACE.md,
        gap: SPACE.sm,
        borderRadius: RADIUS.md,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: job.orphaned ? theme.colors.statusWarning : theme.colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: statusColor(job, theme),
          }}
        />
        <Text style={{ color: theme.colors.foreground, fontSize: TYPE.title, flexShrink: 1 }}>
          {formatElapsed(job.elapsedSeconds)}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.caption, flex: 1 }}>
          {job.shellId}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Stop background job ${job.shellId}`}
          disabled={kill.isPending}
          onPress={() => kill.mutate("SIGTERM")}
          onLongPress={() => kill.mutate("SIGKILL")}
          style={{
            paddingVertical: SPACE.xs,
            paddingHorizontal: SPACE.md,
            borderRadius: RADIUS.sm,
            backgroundColor: theme.colors.surface2,
            borderWidth: 1,
            borderColor: theme.colors.border,
            opacity: kill.isPending ? 0.5 : 1,
          }}
        >
          <Text style={{ color: theme.colors.statusDanger, fontSize: TYPE.caption }}>
            {kill.isPending ? "Stopping…" : "Stop"}
          </Text>
        </Pressable>
      </View>

      <Text
        numberOfLines={expanded ? undefined : 3}
        style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: TYPE.caption }}
      >
        {job.command || "(command unavailable)"}
      </Text>

      <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.caption }}>{meta}</Text>

      {showAgent ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={job.agentId ? "Open the agent that started this job" : "Agent unknown"}
          disabled={!job.agentId || !navigation}
          onPress={openAgent}
        >
          <Text style={{ color: theme.colors.accent, fontSize: TYPE.caption }}>
            {job.agentTitle ?? "Unknown agent"}
            {job.agentStatus ? ` · agent ${job.agentStatus}` : " · no live agent"}
          </Text>
        </Pressable>
      ) : job.orphaned ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: TYPE.caption }}>
          Still running while the agent is {job.agentStatus ?? "gone"}.
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Hide output" : "Show output"}
        onPress={() => setExpanded((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: SPACE.xs }}
      >
        <Icon
          name={expanded ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.caption }}>Output</Text>
      </Pressable>
      {expanded ? <JobOutput job={job} theme={theme} /> : null}
    </View>
  );
}

function JobList({
  agentId,
  theme,
  layout,
  navigation,
  emptyHint,
}: {
  agentId?: string;
  theme: Theme;
  layout: PluginSurfaceProps["layout"];
  navigation: Navigation;
  emptyHint: string;
}) {
  const query = useJobs(agentId);
  const jobs = query.data?.jobs ?? [];
  const orphaned = jobs.filter((job) => job.orphaned).length;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? SPACE.lg : SPACE.xl,
        gap: layout.compact ? SPACE.sm : SPACE.md,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
        <Text style={{ color: theme.colors.foreground, fontSize: TYPE.heading }}>
          {jobs.length === 0 ? "No background jobs" : `${jobs.length} background job${jobs.length === 1 ? "" : "s"}`}
        </Text>
        {query.isFetching ? <ActivityIndicator color={theme.colors.accent} size="small" /> : null}
      </View>
      {orphaned > 0 ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: TYPE.body }}>
          {orphaned} outliving {orphaned === 1 ? "its" : "their"} agent.
        </Text>
      ) : null}
      {query.isError ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: TYPE.body }}>
          {query.error instanceof Error ? query.error.message : "Could not scan for background jobs."}
        </Text>
      ) : null}
      {jobs.length === 0 && !query.isPending ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.body }}>{emptyHint}</Text>
      ) : null}
      {jobs.map((job) => (
        <JobCard
          key={`${job.pid}:${job.shellId}`}
          job={job}
          theme={theme}
          showAgent={agentId === undefined}
          navigation={navigation}
        />
      ))}
    </ScrollView>
  );
}

export function BackgroundJobsSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  return (
    <JobList
      theme={theme}
      layout={layout}
      navigation={navigation}
      emptyHint="Nothing your agents started in the background is still alive on this machine."
    />
  );
}

export function BackgroundJobsPanel({ theme, layout, navigation, agentId }: PluginAgentPanelProps) {
  return (
    <JobList
      agentId={agentId}
      theme={theme}
      layout={layout}
      navigation={navigation}
      emptyHint="This agent has no background job still running."
    />
  );
}

/** One composer pill per agent, showing that agent's live background job count. */
export function contributeBackgroundJobsClient(client: PluginClientContext) {
  const agents = new Map<string, string>();
  const pills = new Map<string, { remove(): void; update(patch: { label?: string; visible?: boolean }): void }>();
  let counts = new Map<string, number>();
  let stopped = false;
  let refreshing = false;

  const removePill = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  const syncPill = (agentId: string, workspaceId: string) => {
    const count = counts.get(agentId) ?? 0;
    const label = count === 1 ? "1 background job" : `${count} background jobs`;
    const existing = pills.get(agentId);
    if (existing) {
      existing.update({ label, visible: count > 0 });
      return;
    }
    const pill = client.addComposerPill({
      id: "background-jobs",
      workspaceId,
      agentId,
      button: {
        title: "Background jobs",
        icon: "Activity",
        label,
        visible: count > 0,
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("background-jobs", { workspaceId, agentId });
          },
        },
      },
    });
    pills.set(agentId, pill);
  };

  const refresh = async () => {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      const { jobs } = await client.rpc(listBackgroundJobsRpc, {});
      if (stopped) return;
      const next = new Map<string, number>();
      for (const job of jobs) {
        if (!job.agentId) continue;
        next.set(job.agentId, (next.get(job.agentId) ?? 0) + 1);
      }
      counts = next;
      for (const [agentId, workspaceId] of agents) syncPill(agentId, workspaceId);
    } catch {
      return;
    } finally {
      refreshing = false;
    }
  };

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      agents.delete(update.agentId);
      removePill(update.agentId);
      return;
    }
    const { id, workspaceId } = update.agent;
    if (!workspaceId) {
      agents.delete(id);
      removePill(id);
      return;
    }
    agents.set(id, workspaceId);
    syncPill(id, workspaceId);
  });

  void client.paseo.agents
    .list()
    .then(async ({ entries }) => {
      for (const { agent } of entries) {
        if (agent.workspaceId) agents.set(agent.id, agent.workspaceId);
      }
      await refresh();
    })
    .catch(() => undefined);

  const timer = setInterval(() => void refresh(), JOB_POLL_MS);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    agents.clear();
  };
}
