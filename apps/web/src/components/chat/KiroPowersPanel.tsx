import type { KiroPowersState } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

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
    <section aria-label={gt("Kiro Powers")} className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">
          <T>Kiro Powers</T>
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => {
            void run(gt("Refreshing Powers…"), refresh);
          }}
        >
          <T>Refresh</T>
        </Button>
      </div>
      {!state.reported ? (
        <p>
          <T>Kiro has not reported installed Powers.</T>
        </p>
      ) : state.powers.length === 0 ? (
        <p>
          <T>No Powers are available in this project.</T>
        </p>
      ) : (
        state.powers.map((power) => (
          <div key={power.name} className="flex items-start justify-between gap-3">
            <details className="min-w-0 flex-1">
              <summary className="cursor-pointer">{power.name}</summary>
              <p className="text-muted-foreground">
                {power.description || gt("No description provided.")}
              </p>
              <p className="text-muted-foreground">
                {power.scope === "workspace"
                  ? gt("Project Power")
                  : power.canRemove
                    ? gt("Installed in this Kiro environment")
                    : gt("Managed by Kiro configuration")}
              </p>
            </details>
            {power.canRemove ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canManage || pending !== null}
                onClick={() => {
                  void run(
                    gt("Removing {name}…", { name: power.name }),
                    () => remove(power.name),
                    true,
                  );
                }}
              >
                <T>Remove</T>
              </Button>
            ) : null}
          </div>
        ))
      )}
      <label className="flex flex-col gap-1">
        <span>
          <T>Catalog name or absolute path on the Kiro environment</T>
        </span>
        <Input
          value={target}
          onValueChange={setTarget}
          disabled={!canManage || !state.canInstall || pending !== null}
          placeholder={gt("Power name or {path}", { path: "/path/to/power" })}
        />
      </label>
      <div>
        <Button
          size="sm"
          disabled={!canManage || !state.canInstall || !target.trim() || pending !== null}
          onClick={() => {
            void run(gt("Installing Power…"), () => install(target.trim()), true);
          }}
        >
          <T>Install Power</T>
        </Button>
      </div>
      {!state.canInstall && state.reported ? (
        <p className="text-muted-foreground">
          <T>Kiro policy manages Power installation.</T>
        </p>
      ) : null}
      {pending ? <p role="status">{pending}</p> : null}
      {changed ? (
        <p role="status">
          <T>Powers updated. Start a new Kiro session to use the updated configuration.</T>
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
