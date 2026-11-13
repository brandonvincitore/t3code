import type {
  KiroMcpAuthorizationResult,
  KiroMcpBeginSignInResult,
  KiroMcpStatus,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useStableCallback } from "../../hooks/useStableCallback";

import { Button } from "../ui/button";

export function KiroMcpPanel({
  status,
  canManage,
  isLocalEnvironment,
  beginSignIn,
  takeAuthorizationUrl,
  cancelSignIn,
  openAuthorizationUrl,
  refresh,
}: {
  readonly status: KiroMcpStatus;
  readonly canManage: boolean;
  readonly isLocalEnvironment: boolean;
  readonly beginSignIn: (serverName: string) => Promise<KiroMcpBeginSignInResult>;
  readonly takeAuthorizationUrl: (attemptId: string) => Promise<KiroMcpAuthorizationResult>;
  readonly cancelSignIn: (attemptId: string) => Promise<void>;
  readonly openAuthorizationUrl: (url: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
}) {
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const previousStatus = useRef(status);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const attemptId = useRef<string | null>(null);

  const cancel = useStableCallback(cancelSignIn);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshed native status retires the externally owned transient sign-in link
  useEffect(() => {
    if (previousStatus.current === status) return;
    previousStatus.current = status;
    if (attemptId.current && status.attempt?.attemptId !== attemptId.current) {
      generation.current += 1;
      attemptId.current = null;
      setAuthorizationUrl(null);
      setFeedback(null);
      setPending(false);
    }
  }, [status]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismiss the session-owned transient OAuth flow when this panel leaves its thread
  useEffect(
    () => () => {
      generation.current += 1;
      const current = attemptId.current;
      if (current) void cancel(current).catch(() => {});
    },
    [cancel],
  );

  async function signIn(serverName: string) {
    if (pending || !canManage || !isLocalEnvironment) return;
    const current = ++generation.current;
    setPending(true);
    setError(null);
    setFeedback(null);
    setAuthorizationUrl(null);
    try {
      const started = await beginSignIn(serverName);
      if (generation.current !== current) {
        await cancelSignIn(started.attemptId);
        return;
      }
      attemptId.current = started.attemptId;
      const result = await takeAuthorizationUrl(started.attemptId);
      if (generation.current === current) setAuthorizationUrl(result.url);
    } catch {
      if (generation.current === current) {
        setError("Could not start MCP sign-in. Refresh the status and try again.");
        await refresh().catch(() => {});
      }
    }
    if (generation.current === current) setPending(false);
  }

  async function dismiss() {
    generation.current += 1;
    const current = attemptId.current ?? status.attempt?.attemptId;
    attemptId.current = null;
    setAuthorizationUrl(null);
    setFeedback(null);
    setPending(false);
    try {
      if (current) await cancelSignIn(current);
      await refresh();
    } catch {
      setError("The sign-in page was dismissed. Refresh to check the Kiro connection attempt.");
    }
  }

  async function open() {
    if (!authorizationUrl || !canManage || !isLocalEnvironment) return;
    const url = authorizationUrl;
    const current = generation.current;
    try {
      await openAuthorizationUrl(url);
      if (generation.current === current) setFeedback("Sign-in page opened.");
    } catch {
      if (generation.current === current)
        setError("Could not open the sign-in page. Copy the sign-in link or try opening it again.");
    }
  }

  async function copy() {
    if (!authorizationUrl || !canManage || !isLocalEnvironment) return;
    const current = generation.current;
    try {
      await writeTextToClipboard(authorizationUrl, "MCP sign-in link");
      if (generation.current === current) setFeedback("Sign-in link copied.");
    } catch {
      if (generation.current === current) setError("Could not copy the sign-in link.");
    }
  }

  return (
    <section aria-label="Kiro MCP servers" className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Kiro MCP servers</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void refresh().catch(() => setError("Could not refresh MCP status."));
          }}
        >
          Refresh
        </Button>
      </div>
      {!status.reported ? (
        <p className="text-muted-foreground">
          Kiro has not reported MCP status for this session yet.
        </p>
      ) : status.servers.length === 0 ? (
        <p className="text-muted-foreground">Kiro reported no MCP servers in this session.</p>
      ) : (
        status.servers.map((server) => (
          <div key={server.name} className="flex items-center justify-between gap-3">
            <div>
              <span>{server.name}</span>
              <p className="text-muted-foreground">
                {server.failedAuthorization
                  ? "Authorization needed"
                  : server.status === "pending"
                    ? "Connecting"
                    : server.status.charAt(0).toUpperCase() + server.status.slice(1)}
              </p>
            </div>
            {server.failedAuthorization && server.status === "failed" && status.canSignIn ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!canManage || !isLocalEnvironment || status.busy || pending}
                onClick={() => {
                  void signIn(server.name);
                }}
              >
                Sign in / reconnect
              </Button>
            ) : null}
          </div>
        ))
      )}
      {status.servers.some((server) => server.failedAuthorization) && !status.canSignIn ? (
        <p className="text-muted-foreground">
          MCP sign-in is unavailable in this connection. Update Kiro CLI on its server and start a
          new session, then retry here. CLI MCP credentials are separate from T3.
        </p>
      ) : null}
      {!isLocalEnvironment ? (
        <p className="text-muted-foreground">
          MCP sign-in must finish in a browser on the machine running Kiro. Remote callback
          forwarding is not supported. Open this T3 server through localhost on that machine and
          start sign-in there. CLI MCP credentials are separate from T3.
        </p>
      ) : null}
      {pending ? <p role="status">Waiting for a fresh sign-in page from Kiro…</p> : null}
      {authorizationUrl ? (
        <div className="flex flex-col gap-2">
          <p>Continue in your browser to authorize this MCP server.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canManage || !isLocalEnvironment}
              onClick={() => {
                void open();
              }}
            >
              Open sign-in page
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canManage || !isLocalEnvironment}
              onClick={() => {
                void copy();
              }}
            >
              Copy sign-in link
            </Button>
          </div>
        </div>
      ) : null}
      {pending || authorizationUrl || status.attempt ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={!canManage}
              onClick={() => {
                void dismiss();
              }}
            >
              Dismiss sign-in
            </Button>
          </div>
          <p className="text-muted-foreground">
            Dismissal closes this flow. Kiro may still finish its connection attempt; it does not
            sign out or revoke access.
          </p>
        </div>
      ) : status.busy ? (
        <p className="text-muted-foreground">
          A previous sign-in is still finishing. Refresh to check its status.
        </p>
      ) : null}
      {feedback ? <p role="status">{feedback}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
