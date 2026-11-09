import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { makeKiroResourceActions } from "@t3tools/client-runtime/kiro-actions";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  KiroPowersState,
} from "@t3tools/contracts";
import { useContext, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { KiroPowersPanel } from "../chat/KiroPowersPanel";
import { KiroMemoryPanel } from "./KiroMemoryPanel";
import { KiroSpecsPanel } from "./KiroSpecsPanel";
import { SettingsSection } from "./settingsLayout";

type Project = { readonly id: ProjectId; readonly title: string; readonly workspaceRoot: string };

export function KiroRefinementSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly projects: ReadonlyArray<Project>;
  readonly readOnly: boolean;
}) {
  const [selected, setSelected] = useState<ProjectId | null>(null);
  const [panel, setPanel] = useState<"specs" | "powers" | "memory" | null>(null);
  const project = props.projects.find((item) => item.id === selected) ?? props.projects[0];
  return (
    <SettingsSection title="Kiro workspace">
      <div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
        {project ? (
          <>
            <Select
              value={project.id}
              onValueChange={(value) => {
                const next = props.projects.find((item) => item.id === value);
                if (next) setSelected(next.id);
              }}
            >
              <SelectTrigger aria-label="Kiro project">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {props.projects.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <div className="flex flex-wrap gap-2">
              {(["specs", "powers", "memory"] as const).map((item) => (
                <Button
                  key={item}
                  variant={panel === item ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => setPanel(panel === item ? null : item)}
                >
                  {item === "specs" ? "Specs" : item === "powers" ? "Powers" : "Memory"}
                </Button>
              ))}
            </div>
            {panel ? (
              <KiroResourcePanel
                key={`${props.environmentId}:${props.instanceId}:${project.id}:${panel}`}
                {...props}
                project={project}
                panel={panel}
              />
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Add a project on this environment to manage its Kiro resources.
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

function KiroResourcePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly project: Project;
  readonly panel: "specs" | "powers" | "memory";
  readonly readOnly: boolean;
}) {
  const registry = useContext(RegistryContext);
  const actions = makeKiroResourceActions({
    registry,
    commands: serverEnvironment,
    environmentId: props.environmentId,
    instanceId: props.instanceId,
    projectId: props.project.id,
  });
  const canManage =
    useAtomValue(serverEnvironment.kiroPowersInstall.permissionAtom(props.environmentId)) &&
    !props.readOnly;
  const [powers, setPowers] = useState<KiroPowersState>({
    reported: false,
    canInstall: false,
    powers: [],
  });
  const refresh = async () => {
    setPowers(await actions.powers.list());
  };
  if (props.panel === "memory")
    return <KiroMemoryPanel actions={actions.memory} canManage={canManage} />;
  if (props.panel === "specs")
    return (
      <KiroSpecsPanel
        environmentId={props.environmentId}
        projectId={props.project.id}
        cwd={props.project.workspaceRoot}
      />
    );
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
