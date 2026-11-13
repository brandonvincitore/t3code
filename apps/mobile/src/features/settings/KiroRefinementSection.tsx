import { nativeHistorySyncMessage } from "@t3tools/client-runtime/kiro-actions";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { makeKiroMcpActions, makeKiroResourceActions } from "@t3tools/client-runtime/kiro-actions";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  AcpRegistrySession,
  EnvironmentId,
  KiroMcpStatus,
  KiroPowersState,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { useProjects, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { KiroMcpPanel } from "../threads/KiroMcpPanel";
import { KiroPowersPanel } from "../threads/KiroPowersPanel";
import { KiroMemoryPanel } from "./KiroMemoryPanel";
import { KiroSpecsPanel } from "./KiroSpecsPanel";

type Panel = "specs" | "powers" | "memory" | "sessions" | "mcp";

export function KiroRefinementSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  const [selected, setSelected] = useState<ProjectId | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const project = projects.find((item) => item.id === selected) ?? projects[0];
  return (
    <View className="gap-3 p-4">
      <Text className="font-t3-medium text-foreground">Kiro workspace</Text>
      {project ? (
        <>
          <Menu
            title="Kiro project"
            actions={projects.map((item) => ({
              id: item.id,
              title: item.title,
              state: item.id === project.id ? "on" : "off",
            }))}
            onPressAction={({ nativeEvent }) => {
              const next = projects.find((item) => item.id === nativeEvent.event);
              if (next) setSelected(next.id);
            }}
          >
            <ControlPill label={project.title} accessibilityLabel="Choose Kiro project" />
          </Menu>
          <View className="flex-row flex-wrap gap-2">
            {(["specs", "powers", "memory", "sessions", "mcp"] as const).map((item) => (
              <Button
                key={item}
                label={
                  item === "mcp" ? "MCP servers" : item.charAt(0).toUpperCase() + item.slice(1)
                }
                onPress={() => setPanel(panel === item ? null : item)}
              />
            ))}
          </View>
          {panel ? (
            <KiroResourcePanel
              key={`${props.environmentId}:${props.instanceId}:${project.id}:${panel}`}
              {...props}
              projectId={project.id}
              cwd={project.workspaceRoot}
              panel={panel}
            />
          ) : null}
        </>
      ) : (
        <Text className="text-foreground-muted">
          Add a project on this environment to manage its Kiro resources.
        </Text>
      )}
    </View>
  );
}

function KiroResourcePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly panel: Panel;
}) {
  const registry = useContext(RegistryContext);
  const actions = useMemo(
    () =>
      makeKiroResourceActions({
        registry,
        commands: serverEnvironment,
        environmentId: props.environmentId,
        instanceId: props.instanceId,
        projectId: props.projectId,
      }),
    [registry, props.environmentId, props.instanceId, props.projectId],
  );
  const canManage = useAtomValue(
    serverEnvironment.kiroPowersInstall.permissionAtom(props.environmentId),
  );
  const [powers, setPowers] = useState<KiroPowersState>({
    reported: false,
    canInstall: false,
    powers: [],
  });
  const refresh = useMemo(
    () => async () => {
      setPowers(await actions.powers.list());
    },
    [actions],
  );
  if (props.panel === "memory")
    return <KiroMemoryPanel actions={actions.memory} canManage={canManage} />;
  if (props.panel === "specs")
    return (
      <KiroSpecsPanel
        environmentId={props.environmentId}
        projectId={props.projectId}
        cwd={props.cwd}
      />
    );
  if (props.panel === "sessions") return <KiroNativeSessions {...props} />;
  if (props.panel === "mcp") return <KiroSessionMcp {...props} />;
  return (
    <KiroPowersPanel
      state={powers}
      canManage={canManage}
      refresh={refresh}
      install={actions.powers.install}
      remove={actions.powers.remove}
    />
  );
}

function KiroSessionMcp(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly projectId: ProjectId;
}) {
  const threads = useThreadShells().filter(
    (thread) =>
      thread.environmentId === props.environmentId &&
      thread.projectId === props.projectId &&
      thread.modelSelection.instanceId === props.instanceId,
  );
  const [selected, setSelected] = useState<ThreadId | null>(null);
  const thread = threads.find((item) => item.id === selected) ?? threads[0];
  if (!thread)
    return (
      <Text className="text-foreground-muted">
        Start a Kiro conversation in this project to inspect its MCP servers.
      </Text>
    );
  return (
    <View className="gap-3">
      <Menu
        title="Kiro conversation"
        actions={threads.map((item) => ({
          id: item.id,
          title: item.title,
          state: item.id === thread.id ? "on" : "off",
        }))}
        onPressAction={({ nativeEvent }) => {
          const next = threads.find((item) => item.id === nativeEvent.event);
          if (next) setSelected(next.id);
        }}
      >
        <ControlPill label={thread.title} accessibilityLabel="Choose Kiro conversation" />
      </Menu>
      <KiroMcpStatusSection
        key={thread.id}
        environmentId={props.environmentId}
        threadId={thread.id}
      />
    </View>
  );
}

function KiroMcpStatusSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const registry = useContext(RegistryContext);
  const actions = useMemo(
    () =>
      makeKiroMcpActions({
        registry,
        commands: serverEnvironment,
        environmentId: props.environmentId,
        threadId: props.threadId,
      }),
    [registry, props.environmentId, props.threadId],
  );
  const canManage = useAtomValue(
    serverEnvironment.kiroMcpStatus.permissionAtom(props.environmentId),
  );
  const [status, setStatus] = useState<KiroMcpStatus>({
    reported: false,
    canSignIn: false,
    busy: false,
    servers: [],
    attempt: null,
  });
  const refresh = useMemo(() => async () => setStatus(await actions.getStatus()), [actions]);
  return <KiroMcpPanel status={status} canManage={canManage} refresh={refresh} />;
}

function KiroNativeSessions(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly projectId: ProjectId;
}) {
  const registry = useContext(RegistryContext);
  const navigation = useNavigation();
  const canImport = useAtomValue(
    serverEnvironment.importAcpRegistrySession.permissionAtom(props.environmentId),
  );
  const canDelete = useAtomValue(
    serverEnvironment.deleteAcpRegistrySession.permissionAtom(props.environmentId),
  );
  const canSync = useAtomValue(
    serverEnvironment.syncNativeHistory.permissionAtom(props.environmentId),
  );
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ReadonlyArray<AcpRegistrySession>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [deletable, setDeletable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ignore RPC completion after the owning project panel closes
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const target = { instanceId: props.instanceId, projectId: props.projectId };
  const open = (threadId: ThreadId) =>
    navigation.dispatch(
      StackActions.push("Thread", { environmentId: props.environmentId, threadId }),
    );
  async function load(next?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runAtomCommand(
      registry,
      serverEnvironment.listAcpRegistrySessions,
      {
        environmentId: props.environmentId,
        input: { ...target, ...(next ? { cursor: next } : {}) },
      },
      { reportFailure: false },
    );
    if (!alive.current) return;
    setBusy(false);
    if (result._tag === "Success") {
      setSessions((current) =>
        next ? [...current, ...result.value.sessions] : result.value.sessions,
      );
      setCursor(result.value.nextCursor);
      setDeletable(result.value.canDelete);
    } else
      setError("Could not load Kiro sessions. Check the environment's CLI sign-in and refresh.");
  }
  async function importSession(session: AcpRegistrySession) {
    if (busy || !canImport) return;
    if (session.importedThreadId && !session.nativeHistoryPending) {
      open(session.importedThreadId);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await runAtomCommand(
      registry,
      serverEnvironment.importAcpRegistrySession,
      {
        environmentId: props.environmentId,
        input: {
          ...target,
          sessionId: session.sessionId,
          ...(session.title ? { title: session.title } : {}),
        },
      },
      { reportFailure: false },
    );
    if (!alive.current) return;
    setBusy(false);
    if (result._tag === "Success") open(result.value.threadId);
    else setError("Could not import the Kiro session. Refresh and try again.");
  }
  async function syncHistory(session: AcpRegistrySession) {
    if (busy || !canSync || !session.importedThreadId) return;
    setBusy(true);
    setError(null);
    setSyncMessage(null);
    const result = await runAtomCommand(
      registry,
      serverEnvironment.syncNativeHistory,
      {
        environmentId: props.environmentId,
        input: { ...target, threadId: session.importedThreadId },
      },
      { reportFailure: false },
    );
    if (!alive.current) return;
    setBusy(false);
    if (result._tag === "Success") setSyncMessage(nativeHistorySyncMessage(result.value));
    else setError("Could not sync native history.");
  }
  async function remove(session: AcpRegistrySession) {
    if (busy || !canDelete || session.importedThreadId) return;
    setBusy(true);
    setError(null);
    const result = await runAtomCommand(
      registry,
      serverEnvironment.deleteAcpRegistrySession,
      { environmentId: props.environmentId, input: { ...target, sessionId: session.sessionId } },
      { reportFailure: false },
    );
    if (!alive.current) return;
    setBusy(false);
    if (result._tag === "Success")
      setSessions((current) => current.filter((item) => item.sessionId !== session.sessionId));
    else setError("Could not delete the native session. Refresh and try again.");
  }
  function confirmRemove(session: AcpRegistrySession) {
    Alert.alert(
      "Delete Kiro session?",
      "This removes its native Kiro history from this environment.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void remove(session);
          },
        },
      ],
    );
  }
  return (
    <View className="gap-3">
      <Text className="font-t3-medium text-foreground">Native Kiro sessions</Text>
      <Button
        label="Refresh"
        disabled={busy}
        onPress={() => {
          void load();
        }}
      />
      {sessions.map((session) => (
        <View key={session.sessionId} className="gap-2 border-b border-border pb-3">
          <Text className="text-foreground">{session.title ?? "Kiro session"}</Text>
          <View className="flex-row gap-2">
            <Button
              label={session.importedThreadId && !session.nativeHistoryPending ? "Open" : "Import"}
              disabled={busy || !canImport}
              onPress={() => {
                void importSession(session);
              }}
            />
            {session.importedThreadId ? (
              <Button
                label={busy ? "Checking / syncing" : "Sync from Kiro"}
                disabled={busy || !canSync}
                onPress={() => {
                  void syncHistory(session);
                }}
              />
            ) : null}
            {deletable && !session.importedThreadId ? (
              <Button
                label="Delete"
                disabled={busy || !canDelete}
                onPress={() => {
                  confirmRemove(session);
                }}
              />
            ) : null}
          </View>
        </View>
      ))}
      {cursor ? (
        <Button
          label="Load more"
          disabled={busy}
          onPress={() => {
            void load(cursor);
          }}
        />
      ) : null}
      {syncMessage ? <Text className="text-foreground-muted">{syncMessage}</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-foreground-muted">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
