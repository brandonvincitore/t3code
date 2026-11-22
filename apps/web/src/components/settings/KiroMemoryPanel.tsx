import { useKiroMemory, type KiroMemoryActions } from "@t3tools/client-runtime/kiro-memory";
import { Plural, T, useGT, useMessages, Var } from "gt-react";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

export function KiroMemoryPanel({
  actions,
  canManage,
}: {
  readonly actions: KiroMemoryActions;
  readonly canManage: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const memory = useKiroMemory(actions, canManage, resolve);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const id = useId();
  const disabled = !canManage || memory.pending !== null;
  const draft = memory.draft;
  return (
    <section aria-label={gt("Kiro memory")} className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">
          <T>Kiro memory</T>
        </h3>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              void memory.refresh();
            }}
          >
            <T>Refresh</T>
          </Button>
          <Button variant="outline" size="sm" disabled={disabled} onClick={memory.add}>
            <T>Add memory</T>
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground">
        <T>
          Memories belong to your Kiro account on this environment. Kiro reports each memory’s
          scope; choosing a project does not hide memories from other scopes.
        </T>
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void memory.search();
        }}
      >
        <label className="flex min-w-40 flex-1 flex-col gap-1" htmlFor={`${id}-query`}>
          <T>Search</T>
          <Input
            id={`${id}-query`}
            type="search"
            maxLength={200}
            value={memory.query}
            disabled={disabled}
            onChange={(event) => memory.setQuery(event.target.value)}
          />
        </label>
        <div className="min-w-40">
          <Select
            value={memory.scopeFilter}
            disabled={disabled}
            onValueChange={(value) => memory.setScopeFilter(value ?? "")}
          >
            <SelectTrigger aria-label={gt("Filter memory scope")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">{gt("All scopes")}</SelectItem>
              {Object.keys(memory.page?.counts.byScope ?? {}).map((scope) => (
                <SelectItem key={scope} value={scope}>
                  {scope}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <Button variant="outline" size="sm" type="submit" disabled={disabled}>
          <T>Search</T>
        </Button>
      </form>
      {memory.syncStatus ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {memory.syncStatus.reason
              ? gt("Memory sync: {state} ({reason})", {
                  state: memory.syncStatus.state,
                  reason: memory.syncStatus.reason,
                })
              : gt("Memory sync: {state}", { state: memory.syncStatus.state })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              void memory.sync();
            }}
          >
            <T>Sync now</T>
          </Button>
        </div>
      ) : null}
      {memory.page ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground">
            <T>
              <Plural
                n={memory.page.total}
                one={
                  <>
                    <Var>{memory.page.total}</Var> memory found.
                  </>
                }
                other={
                  <>
                    <Var>{memory.page.total}</Var> memories found.
                  </>
                }
              />
            </T>
          </p>
          {memory.page.memories.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <p className="break-words font-medium">{entry.title}</p>
                <p className="break-words text-muted-foreground">{entry.summary}</p>
                <p className="text-xs text-muted-foreground">
                  {entry.scopes.join(", ")} · {entry.memoryType}
                </p>
                {entry.unresolvedConflict ? (
                  <p>
                    <T>Unresolved conflict</T>
                  </p>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  setConfirmDeleteId(null);
                  void memory.inspect(entry.id);
                }}
              >
                <T>Inspect</T>
              </Button>
            </div>
          ))}
          {memory.page.nextCursor ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  void memory.more();
                }}
              >
                <T>Load more</T>
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {draft ? (
        <form
          className="flex flex-col gap-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void memory.save();
          }}
        >
          <h4 className="font-medium">
            {draft.id ? gt("Inspect / edit memory") : gt("Add memory")}
          </h4>
          <label className="flex flex-col gap-1" htmlFor={`${id}-title`}>
            <T>Title</T>
            <Input
              id={`${id}-title`}
              value={draft.title}
              maxLength={64}
              disabled={disabled}
              onChange={(event) => memory.change({ title: event.target.value })}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            <T>Letters, digits, and hyphens; up to 64 characters.</T>
          </p>
          <Select
            value={draft.memoryType}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === "SEMANTIC" || value === "USER_PREFERENCE")
                memory.change({ memoryType: value });
            }}
          >
            <SelectTrigger aria-label={gt("Memory type")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="SEMANTIC">{gt("Knowledge")}</SelectItem>
              <SelectItem value="USER_PREFERENCE">{gt("User preference")}</SelectItem>
              {draft.memoryType === "UNKNOWN" ? (
                <SelectItem value="UNKNOWN">{gt("Unknown native type")}</SelectItem>
              ) : null}
            </SelectPopup>
          </Select>
          <label className="flex flex-col gap-1" htmlFor={`${id}-scope`}>
            <T>Scope</T>
            <Input
              id={`${id}-scope`}
              value={draft.scopes}
              disabled={disabled || draft.id !== null}
              onChange={(event) => memory.change({ scopes: event.target.value })}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            <T>
              Global, <Var>workspace:name</Var>, or <Var>repo:provider/owner/name</Var>. Separate
              multiple scopes with commas. Existing scopes are preserved.
            </T>
          </p>
          <label className="flex flex-col gap-1" htmlFor={`${id}-summary`}>
            <T>Summary</T>
            <Textarea
              id={`${id}-summary`}
              value={draft.summary}
              maxLength={250}
              disabled={disabled}
              onChange={(event) => memory.change({ summary: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${id}-content`}>
            <T>Content</T>
            <Textarea
              id={`${id}-content`}
              rows={6}
              value={draft.content}
              maxLength={20_000}
              disabled={disabled}
              onChange={(event) => memory.change({ content: event.target.value })}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={disabled}>
              <T>Save memory</T>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={memory.pending !== null}
              onClick={() => {
                setConfirmDeleteId(null);
                memory.close();
              }}
            >
              <T $context="button, closes the memory editor">Close</T>
            </Button>
            {draft.id ? (
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => setConfirmDeleteId(draft.id)}
              >
                <T>Delete…</T>
              </Button>
            ) : null}
          </div>
          {confirmDeleteId === draft.id && draft.id !== null ? (
            <div role="alert" className="flex flex-col gap-2">
              <p>
                <T>Delete this memory from Kiro? Kiro may sync the deletion to your account.</T>
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    const current = draft.id;
                    setConfirmDeleteId(null);
                    if (current) void memory.remove(current);
                  }}
                >
                  <T>Delete memory</T>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)}>
                  <T>Keep memory</T>
                </Button>
              </div>
            </div>
          ) : null}
        </form>
      ) : null}
      {memory.pending ? <p role="status">{memory.pending}</p> : null}
      {memory.error ? <p role="alert">{memory.error}</p> : null}
      {memory.notice ? <p role="status">{memory.notice}</p> : null}
    </section>
  );
}
