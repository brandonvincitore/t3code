import type { KiroPowersState } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

export function KiroPowersPanel({
  state,
  canManage,
  refresh,
  install,
  remove,
}: {
  readonly state: KiroPowersState;
  readonly canManage: boolean;
  readonly refresh: () => Promise<void>;
  readonly install: (target: string) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [inspected, setInspected] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  async function run(label: string, action: () => Promise<void>, mutation = false) {
    if (pending) return;
    setPending(label);
    setError(null);
    try {
      await action();
      if (mutation) {
        setChanged(true);
        await refresh();
      }
    } catch {
      setError("Could not complete the Powers operation. Refresh and try again.");
    } finally {
      setPending(null);
    }
  }
  return (
    <View className="gap-3">
      <AppText className="font-t3-medium">Kiro Powers</AppText>
      <Button
        label="Refresh"
        size="compact"
        disabled={pending !== null}
        onPress={() => {
          void run("Refreshing Powers…", refresh);
        }}
      />
      {!state.reported ? (
        <AppText>Kiro has not reported installed Powers.</AppText>
      ) : state.powers.length === 0 ? (
        <AppText>No Powers are available in this project.</AppText>
      ) : (
        state.powers.map((power) => (
          <View key={power.name} className="gap-2">
            <Button
              label={power.name}
              size="compact"
              onPress={() => setInspected(inspected === power.name ? null : power.name)}
            />
            {inspected === power.name ? (
              <View className="gap-1">
                <AppText>{power.description || "No description provided."}</AppText>
                <AppText>
                  {power.scope === "workspace"
                    ? "Project Power"
                    : power.canRemove
                      ? "Installed in this Kiro environment"
                      : "Managed by Kiro configuration"}
                </AppText>
              </View>
            ) : null}
            {power.canRemove ? (
              <Button
                label="Remove"
                size="compact"
                disabled={!canManage || pending !== null}
                onPress={() => {
                  void run(`Removing ${power.name}…`, () => remove(power.name), true);
                }}
              />
            ) : null}
          </View>
        ))
      )}
      <AppText>Catalog name or absolute path on the Kiro environment</AppText>
      <AppTextInput
        accessibilityLabel="Power catalog name or absolute path"
        value={target}
        onChangeText={setTarget}
        editable={canManage && state.canInstall && pending === null}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Power name or /path/to/power"
      />
      <Button
        label="Install Power"
        size="compact"
        disabled={!canManage || !state.canInstall || !target.trim() || pending !== null}
        onPress={() => {
          void run("Installing Power…", () => install(target.trim()), true);
        }}
      />
      {!state.canInstall && state.reported ? (
        <AppText>Kiro policy manages Power installation.</AppText>
      ) : null}
      {pending ? <AppText accessibilityRole="alert">{pending}</AppText> : null}
      {changed ? (
        <AppText>
          Powers updated. Start a new Kiro session to use the updated configuration.
        </AppText>
      ) : null}
      {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
    </View>
  );
}
