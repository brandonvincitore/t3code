import type { KiroMcpStatus } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

export function KiroMcpPanel({
  status,
  canManage,
  refresh,
}: {
  readonly status: KiroMcpStatus;
  readonly canManage: boolean;
  readonly refresh: () => Promise<void>;
}) {
  const gt = useGT();
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="gap-3">
      <AppText className="font-t3-medium">
        <T>Kiro MCP servers</T>
      </AppText>
      <Button
        label={gt("Refresh")}
        size="compact"
        disabled={!canManage}
        onPress={() => {
          setError(null);
          void refresh().catch(() => setError(gt("Could not refresh MCP status.")));
        }}
      />
      {!status.reported ? (
        <AppText>
          <T>Kiro has not reported MCP status for this session yet.</T>
        </AppText>
      ) : status.servers.length === 0 ? (
        <AppText>
          <T>Kiro reported no MCP servers in this session.</T>
        </AppText>
      ) : (
        status.servers.map((server) => (
          <View key={server.name} className="gap-1">
            <AppText>{server.name}</AppText>
            <AppText>
              {server.failedAuthorization ? gt("Authorization needed") : server.status}
            </AppText>
          </View>
        ))
      )}
      <AppText>
        <T>
          MCP sign-in must finish in a browser on the machine running Kiro. Remote callback
          forwarding is not supported. Open this T3 server through <Var>{"localhost"}</Var> on that
          machine and start sign-in there. CLI MCP credentials are separate from T3.
        </T>
      </AppText>
      {status.servers.some((server) => server.failedAuthorization) && !status.canSignIn ? (
        <AppText>
          <T>
            MCP sign-in is unavailable in this connection. Update Kiro CLI on its server and start a
            new session, then retry from a local T3 browser.
          </T>
        </AppText>
      ) : null}
      {status.busy ? (
        <AppText>
          <T>A sign-in is still finishing on the Kiro environment. Refresh to check its status.</T>
        </AppText>
      ) : null}
      {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
    </View>
  );
}
