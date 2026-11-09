import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { makeKiroMcpActions } from "@t3tools/client-runtime/kiro-actions";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, KiroMcpStatus, ThreadId } from "@t3tools/contracts";
import { useContext, useState } from "react";
import { ensureLocalApi } from "../../localApi";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironment, useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { KiroMcpPanel } from "./KiroMcpPanel";

export function KiroThreadMcp(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const providers = useEnvironmentProviders().get(props.environmentId) ?? [];
  if (
    providers.find((provider) => provider.instanceId === thread?.modelSelection.instanceId)
      ?.driver !== "kiro"
  )
    return null;
  return (
    <KiroThreadMcpControls
      key={`${props.environmentId}:${props.threadId}:${thread?.modelSelection.instanceId}`}
      {...props}
    />
  );
}

function KiroThreadMcpControls(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const registry = useContext(RegistryContext);
  const environment = useEnvironment(props.environmentId);
  const actions = makeKiroMcpActions({
    registry,
    commands: serverEnvironment,
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const canManage = useAtomValue(
    serverEnvironment.kiroMcpBeginSignIn.permissionAtom(props.environmentId),
  );
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<KiroMcpStatus>({
    reported: false,
    canSignIn: false,
    busy: false,
    servers: [],
    attempt: null,
  });
  const refresh = async () => {
    setStatus(await actions.getStatus());
    setError(null);
  };
  let isLocalEnvironment = false;
  try {
    const url = new URL(environment?.displayUrl ?? "");
    isLocalEnvironment = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    /* An unaddressed or relayed environment cannot receive a local OAuth callback. */
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setExpanded(!expanded);
          if (!expanded && canManage)
            void refresh().catch(() =>
              setError("Start a Kiro session in this thread, then refresh MCP status."),
            );
        }}
      >
        MCP servers
      </Button>
      {error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {error}
        </p>
      ) : null}
      {expanded && canManage ? (
        <KiroMcpPanel
          status={status}
          canManage={canManage}
          isLocalEnvironment={isLocalEnvironment}
          beginSignIn={actions.beginSignIn}
          takeAuthorizationUrl={actions.takeAuthorizationUrl}
          cancelSignIn={actions.cancelSignIn}
          openAuthorizationUrl={(url) => ensureLocalApi().shell.openExternal(url)}
          refresh={refresh}
        />
      ) : null}
    </div>
  );
}
