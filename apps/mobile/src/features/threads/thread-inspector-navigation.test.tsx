import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as React from "react";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type { SubagentWorkflowGroup } from "@t3tools/client-runtime/state/subagentRuntime";

const harness = vi.hoisted(() => ({
  dispatch: (_action: unknown) => {},
  getState: (): unknown => undefined,
  getRoute: (): unknown => undefined,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: (props: {
    readonly children?: React.ReactNode;
    readonly accessibilityLabel?: string;
    readonly disabled?: boolean;
    readonly onPress?: () => void;
  }) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
  ScrollView: (props: { readonly children?: React.ReactNode }) => <div>{props.children}</div>,
  View: (props: { readonly children?: React.ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { readonly children?: React.ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Chip", () => ({
  Chip: (props: {
    readonly accessibilityLabel?: string;
    readonly label: string;
    readonly onPress?: () => void;
  }) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel ?? props.label}
      onClick={props.onPress}
    />
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { readonly label: string; readonly description: string }) => (
    <span>{`${props.label} ${props.description}`}</span>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { readonly children?: React.ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    readonly children?: React.ReactNode;
    readonly accessibilityLabel?: string;
    readonly disabled?: boolean;
    readonly onPress?: () => void;
  }) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => null,
  useThreadShell: () => null,
}));
vi.mock("./SubagentStatusDot", () => ({
  SUBAGENT_TONE_TEXT_CLASS: { working: "", completed: "", failed: "", stopped: "" },
  SubagentStatusDot: () => null,
}));
vi.mock("./SubagentStopButton", () => ({ SubagentStopButton: () => null }));
vi.mock("./use-visible-second-clock", () => ({ useVisibleSecondClock: () => 0 }));
vi.mock("@t3tools/shared/orchestrationTiming", () => ({
  deriveSubagentElapsedMs: () => null,
  formatDuration: () => "",
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useWorkspacePaneState: () => ({ fileInspector: { supported: true } }),
}));
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const requireNavigation = createRequire(
    createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  return {
    StackActions: requireNavigation("@react-navigation/routers").StackActions,
    useNavigation: () => ({ dispatch: harness.dispatch, getState: harness.getState }),
    useRoute: () => harness.getRoute(),
  };
});

import { useOpenThreadInspector } from "./thread-inspector-navigation";
import { useOpenLinkedThread } from "./useOpenLinkedThread";
import { ThreadWorkflowGroup } from "./ThreadWorkflowGroup";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, StackActions } = requireNavigation("@react-navigation/routers") as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  StackActions: typeof import("@react-navigation/native").StackActions;
};

function setup(fromAgents: boolean, fullscreen = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const router = StackRouter({});
  const options = {
    routeNames: ["Home", "Thread", "ThreadAgents", "ThreadInspectorFullscreen"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = router.getInitialState(options);
  const dispatch = (action: Parameters<typeof router.getStateForAction>[1]) => {
    const next = router.getStateForAction(state, action, options);
    if (!next) throw new Error(`Rejected ${action.type}`);
    state = router.getRehydratedState(next, options);
  };
  harness.dispatch = (action) => dispatch(action as Parameters<typeof dispatch>[0]);
  harness.getState = () => state;
  harness.getRoute = () => state.routes.at(-1);
  const source = { environmentId: "remote-environment", threadId: "parent" };
  dispatch(StackActions.push("Thread", { ...source, prompt: "retained prompt" }));
  const parentKey = state.routes.at(-1)!.key;
  if (fullscreen)
    dispatch(StackActions.push("ThreadInspectorFullscreen", { ...source, threadId: "child" }));
  if (fromAgents)
    dispatch(
      StackActions.push("ThreadAgents", fullscreen ? { ...source, threadId: "child" } : source),
    );
  let openInspector: ReturnType<typeof useOpenThreadInspector>;
  let openLinkedThread: ReturnType<typeof useOpenLinkedThread>;
  function Probe() {
    const open = useOpenThreadInspector();
    const openLinked = useOpenLinkedThread();
    useLayoutEffect(() => {
      openInspector = open;
      openLinkedThread = openLinked;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  return {
    source,
    parentKey,
    dispatch,
    get state() {
      return state;
    },
    open(target: Parameters<typeof openInspector>[1], from = source) {
      let opened = false;
      act(() => {
        opened = openInspector(from, target);
      });
      return opened;
    },
    openLinked(threadId: string) {
      act(() => openLinkedThread({ environmentId: source.environmentId, threadId }));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("opens a subagent from the Agents sheet without replacing the parent thread", () => {
  using screen = setup(true);
  const inspector = {
    type: "thread",
    environmentId: screen.source.environmentId,
    threadId: "child",
  } as const;
  screen.open(inspector);
  expect(screen.state.routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: { ...screen.source, prompt: "retained prompt", inspector },
  });
  screen.dispatch(StackActions.push("ThreadInspectorFullscreen", inspector));
  screen.dispatch(StackActions.pop());
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: { ...screen.source, inspector },
  });
});

it("opens a completion link in the parent inspector", () => {
  using screen = setup(false);
  screen.openLinked("child");
  expect(screen.state.routes).toHaveLength(2);
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: {
      ...screen.source,
      inspector: { type: "thread", environmentId: screen.source.environmentId, threadId: "child" },
    },
  });
});

it("opens a workflow member from Agents while its child shell is not cached", () => {
  using screen = setup(true);
  const childThreadId = ThreadId.make("workflow-child");
  const member = {
    id: "workflow:agent:0",
    kind: "workflow_agent",
    title: "Review implementation",
    role: null,
    model: null,
    effort: null,
    status: "completed",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: "workflow",
    agentIndex: 0,
    phaseIndex: 0,
    phaseTitle: "Review",
    attempt: null,
    workflowName: "Review workflow",
    phases: [],
    runHandles: null,
    childThreadId,
    recentActivity: [],
    firstSeenAt: "2026-11-01T00:00:00.000Z",
    startedAt: "2026-11-01T00:00:00.000Z",
    completedAt: "2026-11-01T00:00:01.000Z",
    updatedAt: "2026-11-01T00:00:01.000Z",
  } as const;
  const coordinator = {
    id: NodeId.make("workflow-node"),
    threadId: ThreadId.make("parent"),
    runId: null,
    parentNodeId: NodeId.make("root-node"),
    origin: "provider_native" as const,
    createdBy: "agent" as const,
    driver: ProviderDriverKind.make("kiro"),
    providerInstanceId: ProviderInstanceId.make("kiro"),
    providerThreadId: null,
    childThreadId: ThreadId.make("workflow-coordinator"),
    nativeTaskRef: null,
    prompt: "Run workflow",
    title: "Review workflow",
    model: null,
    status: "completed" as const,
    result: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-01T00:00:01.000Z"),
  };
  const group = {
    workflow: { ...member, id: "workflow", kind: "workflow", title: "Review workflow" },
    phases: [{ index: 0, title: "Review", members: [member], state: "done", settledCount: 1 }],
    unphasedMembers: [],
  } satisfies SubagentWorkflowGroup;
  function WorkflowProbe() {
    const open = useOpenThreadInspector();
    return (
      <ThreadWorkflowGroup
        environmentId={EnvironmentId.make(screen.source.environmentId)}
        subagent={coordinator}
        group={group}
        onOpen={(threadId) =>
          open(screen.source, {
            type: "thread",
            environmentId: screen.source.environmentId,
            threadId,
          })
        }
      />
    );
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() => root.render(<WorkflowProbe />));
  act(() =>
    container.querySelector<HTMLButtonElement>('button[aria-label*="Review workflow"]')?.click(),
  );
  const memberRow = container.querySelector<HTMLButtonElement>(
    'button[aria-label*="Review implementation"]',
  );
  expect(memberRow?.disabled).toBe(false);
  act(() => memberRow?.click());
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: {
      ...screen.source,
      inspector: {
        type: "thread",
        environmentId: screen.source.environmentId,
        threadId: childThreadId,
      },
    },
  });
});

it("switches between subagents and devices in the same parent route", () => {
  using screen = setup(false);
  screen.open({ type: "thread", environmentId: screen.source.environmentId, threadId: "child" });
  const inspector = { type: "device", ...screen.source } as const;
  screen.open(inspector);
  expect(screen.state.routes).toHaveLength(2);
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: { ...screen.source, inspector },
  });
});

it.each(["thread", "device"] as const)(
  "keeps the parent when a maximized child opens a %s preview",
  (type) => {
    using screen = setup(false, true);
    const child = { ...screen.source, threadId: "child" };
    const originalState = screen.state;
    expect(screen.open({ type, ...child, threadId: "grandchild" }, child)).toBe(false);
    expect(screen.state).toEqual(originalState);
    screen.dispatch(StackActions.pop());
    expect(screen.state.routes.at(-1)).toMatchObject({
      key: screen.parentKey,
      params: screen.source,
    });
  },
);

it("keeps the parent when the maximized child's Agents sheet opens another child", () => {
  using screen = setup(true, true);
  const child = { ...screen.source, threadId: "child" };
  const originalState = screen.state;
  expect(screen.open({ type: "thread", ...child, threadId: "grandchild" }, child)).toBe(false);
  expect(screen.state).toEqual(originalState);
});

it("keeps a focused inspector registered across renders and updates its content", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const requireMobile = NodeModule.createRequire(import.meta.url);
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  let focused = true;
  let activeRender: (() => React.ReactNode) | undefined;
  const deactivate = vi.fn(() => {
    activeRender = undefined;
  });
  const registerWorkspaceInspector = vi.fn(
    (content: { readonly panes: ReadonlyArray<{ readonly render: () => React.ReactNode }> }) => {
      activeRender = content.panes[0]?.render;
      return deactivate;
    },
  );
  const navigation = {
    isFocused: () => focused,
    addListener(event: "focus" | "blur", listener: () => void) {
      listeners[event].add(listener);
      return () => {
        listeners[event].delete(listener);
      };
    },
  };
  const navigationContext = React.createContext(navigation);
  const routeContext = React.createContext({ key: "file" });
  const babel = requireMobile("@babel/core") as {
    transformFileSync(file: string, options: Record<string, unknown>): { code: string };
  };
  const compiled = babel.transformFileSync(
    NodePath.resolve(__dirname, "../layout/AdaptiveWorkspaceLayout.tsx"),
    {
      babelrc: false,
      configFile: false,
      presets: [
        [
          requireMobile.resolve("babel-preset-expo"),
          { unstable_transformImportMeta: true, enableBabelRuntime: false },
        ],
      ],
      caller: {
        name: "metro",
        bundler: "metro",
        platform: "ios",
        isDev: false,
        isServer: false,
        isNodeModule: false,
        supportsStaticESM: false,
        supportsReactCompiler: true,
      },
    },
  );
  const exports: {
    Inspector?: (props: {
      readonly content: {
        readonly active: string;
        readonly panes: ReadonlyArray<{ readonly key: string; readonly render: () => string }>;
      };
    }) => null;
  } = {};
  const load = (name: string) => {
    if (name === "react" || name.startsWith("react/")) return requireMobile(name);
    if (name === "./adaptive-workspace-context")
      return {
        useAdaptiveWorkspaceLayout: () => ({ registerWorkspaceInspector }),
      };
    if (name === "@react-navigation/native")
      return {
        NavigationContext: navigationContext,
        NavigationRouteContext: routeContext,
      };
    return {};
  };
  new Function("require", "exports", compiled.code)(load, exports);
  const Inspector = exports.Inspector!;
  const contents = new Map<string, Parameters<typeof Inspector>[0]["content"]>();
  function Screen({ content }: { content: string | undefined }) {
    if (content === undefined) return null;
    let panes = contents.get(content);
    if (!panes) {
      panes = { active: "main", panes: [{ key: "main", render: () => content }] };
      contents.set(content, panes);
    }
    return <Inspector content={panes} />;
  }
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const render = (content: string | undefined) =>
    act(() => root.render(<Screen content={content} />));
  const first = "first";
  render(first);
  registerWorkspaceInspector.mockClear();
  deactivate.mockClear();
  render(first);
  render(first);
  expect(registerWorkspaceInspector).not.toHaveBeenCalled();
  expect(deactivate).not.toHaveBeenCalled();
  const second = "second";
  render(second);
  expect(registerWorkspaceInspector).toHaveBeenCalledTimes(1);
  const paneContainer = document.createElement("div");
  const paneRoot = createRoot(paneContainer);
  using _pane = { [Symbol.dispose]: () => act(() => paneRoot.unmount()) };
  act(() => paneRoot.render(activeRender?.()));
  expect(paneContainer.textContent).toBe("second");
  const emit = (event: "focus" | "blur") =>
    act(() => {
      focused = event === "focus";
      for (const listener of listeners[event]) listener();
    });
  emit("blur");
  expect(deactivate).toHaveBeenCalledTimes(1);
  registerWorkspaceInspector.mockClear();
  render(first);
  expect(registerWorkspaceInspector).not.toHaveBeenCalled();
  emit("focus");
  expect(registerWorkspaceInspector).toHaveBeenCalledTimes(1);
  emit("focus");
  expect(registerWorkspaceInspector).toHaveBeenCalledTimes(1);
  render(undefined);
  expect(activeRender).toBeUndefined();
  render(second);
  expect(activeRender).toBeDefined();
  act(() => root.unmount());
  expect(activeRender).toBeUndefined();
  expect(listeners.focus.size + listeners.blur.size).toBe(0);
});
