import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  buildKiroSpecContinuePrompt,
  discoverKiroSpecDocuments,
  discoverKiroSpecFolders,
  kiroSpecKind,
  parseKiroTaskProgress,
  type KiroSpecDocumentId,
} from "@t3tools/shared/kiroSpecs";
import { useState } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";

export interface KiroSpecsContinueInput {
  readonly projectId: ProjectId;
  readonly specName: string;
  readonly kind: "bugfix" | "feature";
  readonly documentPath: string;
  readonly prompt: string;
}

export function KiroSpecsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly onOpenFile?: (relativePath: string) => void;
  readonly onContinue?: (input: KiroSpecsContinueInput) => void;
}) {
  return (
    <KiroSpecsPanelContent
      key={`${props.environmentId}:${props.projectId}:${props.cwd}`}
      {...props}
    />
  );
}

function KiroSpecsPanelContent(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly onOpenFile?: (relativePath: string) => void;
  readonly onContinue?: (input: KiroSpecsContinueInput) => void;
}) {
  const [selectedSpec, setSelectedSpec] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<KiroSpecDocumentId | null>(null);
  const [editPath, setEditPath] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const canWrite = useAtomValue(projectEnvironment.writeFile.permissionAtom(props.environmentId));
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });

  const workspaceQuery = useEnvironmentQuery(
    projectEnvironment.listEntries({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, directoryPath: "" },
    }),
  );
  const kiroDirectory = workspaceQuery.data?.entries.find(
    (entry) => entry.path === ".kiro" && entry.kind === "directory",
  );
  const kiroQuery = useEnvironmentQuery(
    kiroDirectory
      ? projectEnvironment.listEntries({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, directoryPath: ".kiro" },
        })
      : null,
  );
  const specsDirectory = kiroQuery.data?.entries.find(
    (entry) => entry.path === ".kiro/specs" && entry.kind === "directory",
  );
  const specsQuery = useEnvironmentQuery(
    specsDirectory
      ? projectEnvironment.listEntries({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, directoryPath: ".kiro/specs" },
        })
      : null,
  );
  const specs = discoverKiroSpecFolders(specsQuery.data?.entries ?? []);
  const specName = specs.includes(selectedSpec ?? "") ? selectedSpec! : (specs[0] ?? null);
  const specDirectoryPath = specName === null ? null : `.kiro/specs/${specName}`;
  const documentsQuery = useEnvironmentQuery(
    specDirectoryPath
      ? projectEnvironment.listEntries({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, directoryPath: specDirectoryPath },
        })
      : null,
  );
  const documents = discoverKiroSpecDocuments(documentsQuery.data?.entries ?? [], specName ?? "");
  const document = documents.find(({ id }) => id === selectedDocument) ?? documents[0] ?? null;
  const readQuery = useEnvironmentQuery(
    document
      ? projectEnvironment.readFile({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, relativePath: document.path, allowMissing: true },
        })
      : null,
  );
  const taskPath = specDirectoryPath === null ? null : `${specDirectoryPath}/tasks.md`;
  const taskQuery = useEnvironmentQuery(
    taskPath
      ? projectEnvironment.readFile({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, relativePath: taskPath, allowMissing: true },
        })
      : null,
  );
  const taskMarkdown = editPath === taskPath ? draft : (taskQuery.data?.contents ?? "");
  const taskProgress = parseKiroTaskProgress(taskMarkdown);
  const kind = kiroSpecKind(documents);
  const content = readQuery.data?.exists === false ? null : (readQuery.data?.contents ?? null);
  const isEditing = editPath !== null && editPath === document?.path;

  const startEditing = () => {
    if (!document || content === null || !canWrite) return;
    setDraft(content);
    setEditPath(document.path);
    setSaveError(null);
  };

  const cancelEditing = () => {
    setEditPath(null);
    setSaveError(null);
  };

  const save = async () => {
    if (!document || !canWrite || !isEditing || saving) return;
    setSaving(true);
    setSaveError(null);
    const result = await writeFile({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, relativePath: document.path, contents: draft },
    }).finally(() => setSaving(false));
    if (result._tag === "Success") {
      setEditPath(null);
      readQuery.refresh();
      taskQuery.refresh();
    } else {
      setSaveError("Could not save this spec file. Check workspace write access and try again.");
    }
  };

  const refresh = () => {
    workspaceQuery.refresh();
    kiroQuery.refresh();
    specsQuery.refresh();
    documentsQuery.refresh();
    taskQuery.refresh();
    readQuery.refresh();
  };

  return (
    <section aria-label="Kiro Specs" className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Specs</h2>
          <p className="text-xs text-muted-foreground">Native Kiro artifacts in this project</p>
        </div>
        <Button size="sm" variant="outline" onClick={refresh}>
          Refresh
        </Button>
      </div>

      {workspaceQuery.error ? (
        <p role="alert" className="text-muted-foreground">
          Could not list project files.
        </p>
      ) : workspaceQuery.isPending || (specsDirectory && specsQuery.isPending) ? (
        <p role="status" className="text-muted-foreground">
          Looking for `.kiro/specs`…
        </p>
      ) : specs.length === 0 ? (
        <p className="text-muted-foreground">
          No spec artifacts found under `.kiro/specs/`. Start a Spec, Quick Spec, or Bug Fix session
          in Kiro to create them.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5" aria-label="Kiro specs">
            {specs.map((name) => (
              <Button
                key={name}
                size="sm"
                variant={name === specName ? "secondary" : "ghost"}
                aria-pressed={name === specName}
                disabled={editPath !== null}
                onClick={() => {
                  setSelectedSpec(name);
                  setSelectedDocument(null);
                }}
              >
                {name}
              </Button>
            ))}
          </div>

          {specDirectoryPath ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {kind === "bugfix"
                  ? "Bugfix spec"
                  : "Feature spec (including Quick Spec artifacts)"}
              </span>
              <span aria-hidden="true">·</span>
              {taskProgress.total > 0 ? (
                <span>
                  {taskProgress.checked} of {taskProgress.total} tasks checked
                </span>
              ) : (
                <span>No checklist tasks recorded</span>
              )}
            </div>
          ) : null}

          {documents.length === 0 ? (
            <p className="text-muted-foreground">
              This spec folder has no recognized artifacts yet.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5" aria-label="Spec phase and document">
                {documents.map((entry) => (
                  <Button
                    key={entry.id}
                    size="sm"
                    variant={entry.id === document?.id ? "secondary" : "ghost"}
                    aria-pressed={entry.id === document?.id}
                    disabled={editPath !== null}
                    onClick={() => setSelectedDocument(entry.id)}
                  >
                    {entry.label}
                  </Button>
                ))}
              </div>

              {document ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium">{document.fileName}</span>
                    <div className="flex shrink-0 gap-1.5">
                      {props.onOpenFile ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => props.onOpenFile?.(document.path)}
                        >
                          Open in Files
                        </Button>
                      ) : null}
                      {isEditing ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={saving}
                            onClick={cancelEditing}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            disabled={!canWrite || saving}
                            onClick={() => void save()}
                          >
                            {saving ? "Saving…" : "Save"}
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            !canWrite ||
                            content === null ||
                            readQuery.isPending ||
                            editPath !== null
                          }
                          onClick={startEditing}
                        >
                          Edit
                        </Button>
                      )}
                    </div>
                  </div>
                  {readQuery.isPending ? (
                    <p role="status" className="text-muted-foreground">
                      Reading {document.fileName}…
                    </p>
                  ) : readQuery.error ? (
                    <p role="alert" className="text-muted-foreground">
                      Could not read this spec file.
                    </p>
                  ) : content === null ? (
                    <p className="text-muted-foreground">
                      This artifact is not available in the workspace.
                    </p>
                  ) : isEditing ? (
                    <Textarea
                      aria-label={`Edit ${document.fileName}`}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={12}
                      spellCheck={false}
                    />
                  ) : (
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {content}
                    </pre>
                  )}
                  {saveError ? (
                    <p role="alert" className="text-destructive">
                      {saveError}
                    </p>
                  ) : null}
                  {props.onContinue && specName && document ? (
                    <div className="flex justify-end border-t border-border/60 pt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isEditing}
                        onClick={() =>
                          props.onContinue?.({
                            projectId: props.projectId,
                            specName,
                            kind,
                            documentPath: document.path,
                            prompt: buildKiroSpecContinuePrompt(specName, kind, document),
                          })
                        }
                      >
                        Continue in Kiro
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  );
}
