import type { KiroPowersState } from "@t3tools/contracts";
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
      setError("Could not complete the Powers operation. Refresh and try again.");
    }
    setPending(null);
  }
  return (
    <section aria-label="Kiro Powers" className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Kiro Powers</span>
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => {
            void run("Refreshing Powers…", refresh);
          }}
        >
          Refresh
        </Button>
      </div>
      {!state.reported ? (
        <p>Kiro has not reported installed Powers.</p>
      ) : state.powers.length === 0 ? (
        <p>No Powers are available in this project.</p>
      ) : (
        state.powers.map((power) => (
          <div key={power.name} className="flex items-start justify-between gap-3">
            <details className="min-w-0 flex-1">
              <summary className="cursor-pointer">{power.name}</summary>
              <p className="text-muted-foreground">
                {power.description || "No description provided."}
              </p>
              <p className="text-muted-foreground">
                {power.scope === "workspace"
                  ? "Project Power"
                  : power.canRemove
                    ? "Installed in this Kiro environment"
                    : "Managed by Kiro configuration"}
              </p>
            </details>
            {power.canRemove ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canManage || pending !== null}
                onClick={() => {
                  void run(`Removing ${power.name}…`, () => remove(power.name), true);
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ))
      )}
      <label className="flex flex-col gap-1">
        <span>Catalog name or absolute path on the Kiro environment</span>
        <Input
          value={target}
          onValueChange={setTarget}
          disabled={!canManage || !state.canInstall || pending !== null}
          placeholder="Power name or /path/to/power"
        />
      </label>
      <div>
        <Button
          size="sm"
          disabled={!canManage || !state.canInstall || !target.trim() || pending !== null}
          onClick={() => {
            void run("Installing Power…", () => install(target.trim()), true);
          }}
        >
          Install Power
        </Button>
      </div>
      {!state.canInstall && state.reported ? (
        <p className="text-muted-foreground">Kiro policy manages Power installation.</p>
      ) : null}
      {pending ? <p role="status">{pending}</p> : null}
      {changed ? (
        <p role="status">
          Powers updated. Start a new Kiro session to use the updated configuration.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
