import type { KiroPowersState } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
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
  const gt = useGT();
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
      setError(gt("Could not complete the Powers operation. Refresh and try again."));
    }
    setPending(null);
  }
  return (
    <View className="gap-3">
      <AppText className="font-t3-medium">
        <T>Kiro Powers</T>
      </AppText>
      <Button
        label={gt("Refresh")}
        size="compact"
        disabled={pending !== null}
        onPress={() => {
          void run(gt("Refreshing Powers…"), refresh);
        }}
      />
      {!state.reported ? (
        <AppText>
          <T>Kiro has not reported installed Powers.</T>
        </AppText>
      ) : state.powers.length === 0 ? (
        <AppText>
          <T>No Powers are available in this project.</T>
        </AppText>
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
                <AppText>{power.description || gt("No description provided.")}</AppText>
                <AppText>
                  {power.scope === "workspace"
                    ? gt("Project Power")
                    : power.canRemove
                      ? gt("Installed in this Kiro environment")
                      : gt("Managed by Kiro configuration")}
                </AppText>
              </View>
            ) : null}
            {power.canRemove ? (
              <Button
                label={gt("Remove")}
                size="compact"
                disabled={!canManage || pending !== null}
                onPress={() => {
                  void run(
                    gt("Removing {name}…", { name: power.name }),
                    () => remove(power.name),
                    true,
                  );
                }}
              />
            ) : null}
          </View>
        ))
      )}
      <AppText>
        <T>Catalog name or absolute path on the Kiro environment</T>
      </AppText>
      <AppTextInput
        accessibilityLabel={gt("Power catalog name or absolute path")}
        value={target}
        onChangeText={setTarget}
        editable={canManage && state.canInstall && pending === null}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={gt("Power name or {path}", { path: "/path/to/power" })}
      />
      <Button
        label={gt("Install Power")}
        size="compact"
        disabled={!canManage || !state.canInstall || !target.trim() || pending !== null}
        onPress={() => {
          void run(gt("Installing Power…"), () => install(target.trim()), true);
        }}
      />
      {!state.canInstall && state.reported ? (
        <AppText>
          <T>Kiro policy manages Power installation.</T>
        </AppText>
      ) : null}
      {pending ? <AppText accessibilityRole="alert">{pending}</AppText> : null}
      {changed ? (
        <AppText>
          <T>Powers updated. Start a new Kiro session to use the updated configuration.</T>
        </AppText>
      ) : null}
      {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
    </View>
  );
}
