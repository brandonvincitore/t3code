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
import { T, useGT, Var } from "gt-react-native";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

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
  const gt = useGT();
  const [selectedSpec, setSelectedSpec] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<KiroSpecDocumentId | null>(null);
  const [editPath, setEditPath] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const canWrite = useAtomValue(projectEnvironment.writeFile.permissionAtom(props.environmentId));
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });

  const rootQuery = useEnvironmentQuery(
    projectEnvironment.listEntries({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, directoryPath: "" },
    }),
  );
  const hasKiro = rootQuery.data?.entries.some(
    (entry) => entry.path === ".kiro" && entry.kind === "directory",
  );
  const kiroQuery = useEnvironmentQuery(
    hasKiro
      ? projectEnvironment.listEntries({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, directoryPath: ".kiro" },
        })
      : null,
  );
  const hasSpecs = kiroQuery.data?.entries.some(
    (entry) => entry.path === ".kiro/specs" && entry.kind === "directory",
  );
  const specsQuery = useEnvironmentQuery(
    hasSpecs
      ? projectEnvironment.listEntries({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, directoryPath: ".kiro/specs" },
        })
      : null,
  );
  const specs = discoverKiroSpecFolders(specsQuery.data?.entries ?? []);
  const specName = specs.includes(selectedSpec ?? "") ? selectedSpec! : (specs[0] ?? null);
  const specPath = specName === null ? null : `.kiro/specs/${specName}`;
  const documentsQuery = useEnvironmentQuery(
    specPath
      ? projectEnvironment.listEntries({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, directoryPath: specPath },
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
  const tasksPath = specPath === null ? null : `${specPath}/tasks.md`;
  const tasksQuery = useEnvironmentQuery(
    tasksPath
      ? projectEnvironment.readFile({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, relativePath: tasksPath, allowMissing: true },
        })
      : null,
  );
  const tasks = editPath === tasksPath ? draft : (tasksQuery.data?.contents ?? "");
  const progress = parseKiroTaskProgress(tasks);
  const kind = kiroSpecKind(documents);
  const content = readQuery.data?.exists === false ? null : (readQuery.data?.contents ?? null);
  const editing = editPath !== null && editPath === document?.path;

  const save = async () => {
    if (!document || !canWrite || !editing || saving) return;
    setSaving(true);
    setSaveError(null);
    const result = await writeFile({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, relativePath: document.path, contents: draft },
    }).finally(() => setSaving(false));
    if (result._tag === "Success") {
      setEditPath(null);
      readQuery.refresh();
      tasksQuery.refresh();
    } else {
      setSaveError(
        gt("Could not save this spec file. Check workspace write access and try again."),
      );
    }
  };

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-1 gap-1">
          <AppText className="font-t3-medium">
            <T>Kiro Specs</T>
          </AppText>
          <AppText>
            <T>Native Kiro artifacts in this project</T>
          </AppText>
        </View>
        <Button
          label={gt("Refresh")}
          size="compact"
          onPress={() => {
            rootQuery.refresh();
            kiroQuery.refresh();
            specsQuery.refresh();
            documentsQuery.refresh();
            tasksQuery.refresh();
            readQuery.refresh();
          }}
        />
      </View>

      {rootQuery.error ? (
        <AppText>
          <T>Could not list project files.</T>
        </AppText>
      ) : rootQuery.isPending || (hasSpecs && specsQuery.isPending) ? (
        <AppText>
          <T>
            Looking for <Var>{".kiro/specs"}</Var>…
          </T>
        </AppText>
      ) : specs.length === 0 ? (
        <AppText>
          <T>
            No spec artifacts found under <Var>{".kiro/specs/"}</Var>. Start a Spec, Quick Spec, or
            Bug Fix session in Kiro to create them.
          </T>
        </AppText>
      ) : (
        <>
          <View className="flex-row flex-wrap gap-2">
            {specs.map((name) => (
              <Button
                key={name}
                label={name}
                size="compact"
                tone={name === specName ? "primary" : "secondary"}
                disabled={editPath !== null}
                onPress={() => {
                  setSelectedSpec(name);
                  setSelectedDocument(null);
                }}
              />
            ))}
          </View>

          {specPath ? (
            <AppText>
              {kind === "bugfix" ? (
                <T>
                  Bugfix spec · <Var>{String(progress.checked)}</Var> of{" "}
                  <Var>{String(progress.total)}</Var> tasks checked
                </T>
              ) : (
                <T>
                  Feature spec (including Quick Spec artifacts) ·{" "}
                  <Var>{String(progress.checked)}</Var> of <Var>{String(progress.total)}</Var> tasks
                  checked
                </T>
              )}
            </AppText>
          ) : null}

          {documents.length === 0 ? (
            <AppText>
              <T>This spec folder has no recognized artifacts yet.</T>
            </AppText>
          ) : (
            <>
              <View className="flex-row flex-wrap gap-2">
                {documents.map((entry) => (
                  <Button
                    key={entry.id}
                    label={entry.label}
                    size="compact"
                    tone={entry.id === document?.id ? "primary" : "secondary"}
                    disabled={editPath !== null}
                    onPress={() => setSelectedDocument(entry.id)}
                  />
                ))}
              </View>

              {document ? (
                <View className="gap-3 rounded-lg border border-divider p-3">
                  <View className="flex-row flex-wrap items-center justify-between gap-2">
                    <AppText className="font-t3-medium">{document.fileName}</AppText>
                    <View className="flex-row flex-wrap gap-2">
                      {props.onOpenFile ? (
                        <Button
                          label={gt("Open in Files")}
                          size="compact"
                          onPress={() => props.onOpenFile?.(document.path)}
                        />
                      ) : null}
                      {editing ? (
                        <>
                          <Button
                            label={gt("Cancel")}
                            size="compact"
                            disabled={saving}
                            onPress={() => {
                              setEditPath(null);
                              setSaveError(null);
                            }}
                          />
                          <Button
                            label={saving ? gt("Saving…") : gt("Save")}
                            size="compact"
                            disabled={!canWrite || saving}
                            onPress={() => void save()}
                          />
                        </>
                      ) : (
                        <Button
                          label={gt("Edit", { $context: "verb, edits a spec file" })}
                          size="compact"
                          disabled={
                            !canWrite ||
                            content === null ||
                            readQuery.isPending ||
                            editPath !== null
                          }
                          onPress={() => {
                            if (content === null) return;
                            setDraft(content);
                            setEditPath(document.path);
                            setSaveError(null);
                          }}
                        />
                      )}
                    </View>
                  </View>
                  {readQuery.isPending ? (
                    <AppText>
                      <T>
                        Reading <Var>{document.fileName}</Var>…
                      </T>
                    </AppText>
                  ) : readQuery.error ? (
                    <AppText>
                      <T>Could not read this spec file.</T>
                    </AppText>
                  ) : content === null ? (
                    <AppText>
                      <T>This artifact is not available in the workspace.</T>
                    </AppText>
                  ) : editing ? (
                    <TextInput
                      accessibilityLabel={gt("Edit {fileName}", { fileName: document.fileName })}
                      value={draft}
                      onChangeText={setDraft}
                      multiline
                      textAlignVertical="top"
                      className="min-h-40 rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
                    />
                  ) : (
                    <AppText selectable>{content}</AppText>
                  )}
                  {saveError ? <AppText>{saveError}</AppText> : null}
                  {props.onContinue && specName ? (
                    <Button
                      label={gt("Continue in Kiro")}
                      size="compact"
                      disabled={editing}
                      onPress={() =>
                        props.onContinue?.({
                          projectId: props.projectId,
                          specName,
                          kind,
                          documentPath: document.path,
                          prompt: buildKiroSpecContinuePrompt(specName, kind, document),
                        })
                      }
                    />
                  ) : null}
                </View>
              ) : null}
            </>
          )}
        </>
      )}
    </View>
  );
}
