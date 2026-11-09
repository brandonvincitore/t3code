import type { ProjectEntry } from "@t3tools/contracts";

export type KiroSpecDocumentId = "bugfix" | "requirements" | "design" | "tasks";

export interface KiroSpecDocument {
  readonly id: KiroSpecDocumentId;
  readonly fileName: `${KiroSpecDocumentId}.md`;
  readonly label: string;
  readonly path: string;
}

export interface KiroSpec {
  readonly name: string;
  readonly path: string;
  readonly kind: "bugfix" | "feature";
  readonly documents: readonly KiroSpecDocument[];
}

const DOCUMENTS = [
  { id: "bugfix", label: "Bugfix" },
  { id: "requirements", label: "Requirements" },
  { id: "design", label: "Design" },
  { id: "tasks", label: "Tasks" },
] as const satisfies ReadonlyArray<Pick<KiroSpecDocument, "id" | "label">>;

const SPECS_PATH = ".kiro/specs";

function directChildName(path: string, parentPath: string): string | null {
  const prefix = `${parentPath}/`;
  if (!path.startsWith(prefix)) return null;
  const remainder = path.slice(prefix.length);
  return remainder.length > 0 && !remainder.includes("/") ? remainder : null;
}

export function discoverKiroSpecFolders(entries: readonly ProjectEntry[]): readonly string[] {
  return entries
    .flatMap((entry) => {
      const name = entry.kind === "directory" ? directChildName(entry.path, SPECS_PATH) : null;
      return name === null ? [] : [name];
    })
    .sort((a, b) => a.localeCompare(b));
}

export function discoverKiroSpecDocuments(
  entries: readonly ProjectEntry[],
  specName: string,
): readonly KiroSpecDocument[] {
  const specPath = `${SPECS_PATH}/${specName}`;
  const files = new Set(
    entries.flatMap((entry) => {
      const name = entry.kind === "file" ? directChildName(entry.path, specPath) : null;
      return name === null ? [] : [name];
    }),
  );
  return DOCUMENTS.flatMap(({ id, label }) => {
    const fileName = `${id}.md` as const;
    return files.has(fileName) ? [{ id, fileName, label, path: `${specPath}/${fileName}` }] : [];
  });
}

export function kiroSpecKind(documents: readonly KiroSpecDocument[]): KiroSpec["kind"] {
  return documents.some((document) => document.id === "bugfix") ? "bugfix" : "feature";
}

export interface KiroTaskProgress {
  readonly checked: number;
  readonly total: number;
}

const TASK_CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s+\S/;

export function parseKiroTaskProgress(markdown: string): KiroTaskProgress {
  let checked = 0;
  let total = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const match = TASK_CHECKBOX.exec(line);
    if (match === null) continue;
    total += 1;
    if (match[1]?.toLowerCase() === "x") checked += 1;
  }
  return { checked, total };
}

export function buildKiroSpecContinuePrompt(
  specName: string,
  kind: KiroSpec["kind"],
  document: KiroSpecDocument,
): string {
  const specPath = `${SPECS_PATH}/${specName}`;
  return [
    `Continue the existing Kiro ${kind} spec “${specName}” from its ${document.label.toLowerCase()} artifact.`,
    `Read the available documents in ${specPath}/ and continue the native workflow from there.`,
    "Keep the existing spec artifacts and update them only when the workflow calls for it.",
  ].join("\n");
}
