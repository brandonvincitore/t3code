import type { KiroMcpStatus } from "@t3tools/contracts";
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
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="gap-3">
      <AppText className="font-t3-medium">Kiro MCP servers</AppText>
      <Button
        label="Refresh"
        size="compact"
        disabled={!canManage}
        onPress={() => {
          setError(null);
          void refresh().catch(() => setError("Could not refresh MCP status."));
        }}
      />
      {!status.reported ? (
        <AppText>Kiro has not reported MCP status for this session yet.</AppText>
      ) : status.servers.length === 0 ? (
        <AppText>Kiro reported no MCP servers in this session.</AppText>
      ) : (
        status.servers.map((server) => (
          <View key={server.name} className="gap-1">
            <AppText>{server.name}</AppText>
            <AppText>{server.failedAuthorization ? "Authorization needed" : server.status}</AppText>
          </View>
        ))
      )}
      <AppText>
        MCP sign-in must finish in a browser on the machine running Kiro. Remote callback forwarding
        is not supported. Open this T3 server through localhost on that machine and start sign-in
        there. CLI MCP credentials are separate from T3.
      </AppText>
      {status.servers.some((server) => server.failedAuthorization) && !status.canSignIn ? (
        <AppText>
          MCP sign-in is unavailable in this connection. Update Kiro CLI on its server and start a
          new session, then retry from a local T3 browser.
        </AppText>
      ) : null}
      {status.busy ? (
        <AppText>
          A sign-in is still finishing on the Kiro environment. Refresh to check its status.
        </AppText>
      ) : null}
      {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
    </View>
  );
}
