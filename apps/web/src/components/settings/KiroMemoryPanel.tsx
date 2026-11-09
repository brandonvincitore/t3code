import { useKiroMemory, type KiroMemoryActions } from "@t3tools/client-runtime/kiro-memory";
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
  const memory = useKiroMemory(actions, canManage);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const id = useId();
  const disabled = !canManage || memory.pending !== null;
  const draft = memory.draft;
  return (
    <section aria-label="Kiro memory" className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Kiro memory</h3>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              void memory.refresh();
            }}
          >
            Refresh
          </Button>
          <Button variant="outline" size="sm" disabled={disabled} onClick={memory.add}>
            Add memory
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground">
        Memories belong to your Kiro account on this environment. Kiro reports each memory’s scope;
        choosing a project does not hide memories from other scopes.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void memory.search();
        }}
      >
        <label className="flex min-w-40 flex-1 flex-col gap-1" htmlFor={`${id}-query`}>
          Search
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
            <SelectTrigger aria-label="Filter memory scope">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">All scopes</SelectItem>
              {Object.keys(memory.page?.counts.byScope ?? {}).map((scope) => (
                <SelectItem key={scope} value={scope}>
                  {scope}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <Button variant="outline" size="sm" type="submit" disabled={disabled}>
          Search
        </Button>
      </form>
      {memory.syncStatus ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            Memory sync: {memory.syncStatus.state}
            {memory.syncStatus.reason ? ` (${memory.syncStatus.reason})` : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              void memory.sync();
            }}
          >
            Sync now
          </Button>
        </div>
      ) : null}
      {memory.page ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground">
            {memory.page.total} {memory.page.total === 1 ? "memory" : "memories"} found.
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
                {entry.unresolvedConflict ? <p>Unresolved conflict</p> : null}
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
                Inspect
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
                Load more
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
          <h4 className="font-medium">{draft.id ? "Inspect / edit memory" : "Add memory"}</h4>
          <label className="flex flex-col gap-1" htmlFor={`${id}-title`}>
            Title
            <Input
              id={`${id}-title`}
              value={draft.title}
              maxLength={64}
              disabled={disabled}
              onChange={(event) => memory.change({ title: event.target.value })}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Letters, digits, and hyphens; up to 64 characters.
          </p>
          <Select
            value={draft.memoryType}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === "SEMANTIC" || value === "USER_PREFERENCE")
                memory.change({ memoryType: value });
            }}
          >
            <SelectTrigger aria-label="Memory type">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="SEMANTIC">Knowledge</SelectItem>
              <SelectItem value="USER_PREFERENCE">User preference</SelectItem>
              {draft.memoryType === "UNKNOWN" ? (
                <SelectItem value="UNKNOWN">Unknown native type</SelectItem>
              ) : null}
            </SelectPopup>
          </Select>
          <label className="flex flex-col gap-1" htmlFor={`${id}-scope`}>
            Scope
            <Input
              id={`${id}-scope`}
              value={draft.scopes}
              disabled={disabled || draft.id !== null}
              onChange={(event) => memory.change({ scopes: event.target.value })}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Global, workspace:name, or repo:provider/owner/name. Separate multiple scopes with
            commas. Existing scopes are preserved.
          </p>
          <label className="flex flex-col gap-1" htmlFor={`${id}-summary`}>
            Summary
            <Textarea
              id={`${id}-summary`}
              value={draft.summary}
              maxLength={250}
              disabled={disabled}
              onChange={(event) => memory.change({ summary: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${id}-content`}>
            Content
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
              Save memory
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
              Close
            </Button>
            {draft.id ? (
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => setConfirmDeleteId(draft.id)}
              >
                Delete…
              </Button>
            ) : null}
          </div>
          {confirmDeleteId === draft.id && draft.id !== null ? (
            <div role="alert" className="flex flex-col gap-2">
              <p>Delete this memory from Kiro? Kiro may sync the deletion to your account.</p>
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
                  Delete memory
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)}>
                  Keep memory
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
