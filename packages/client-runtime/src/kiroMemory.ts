import {
  KiroMemoryCreate,
  KiroMemoryUpdate,
  type KiroMemoryCreateResult,
  type KiroMemoryDeleteResult,
  type KiroMemoryDetail,
  type KiroMemoryGetResult,
  type KiroMemoryListOptions,
  type KiroMemoryListResult,
  type KiroMemorySyncStatus,
  type KiroMemoryUpdateResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

export interface KiroMemoryActions {
  readonly list: (input: KiroMemoryListOptions) => Promise<KiroMemoryListResult>;
  readonly get: (id: string) => Promise<KiroMemoryGetResult>;
  readonly create: (input: KiroMemoryCreate) => Promise<KiroMemoryCreateResult>;
  readonly update: (input: KiroMemoryUpdate) => Promise<KiroMemoryUpdateResult>;
  readonly delete: (id: string) => Promise<KiroMemoryDeleteResult>;
  readonly getSyncStatus: () => Promise<KiroMemorySyncStatus>;
  readonly sync: () => Promise<KiroMemorySyncStatus>;
}

interface Draft {
  readonly id: string | null;
  readonly title: string;
  readonly memoryType: KiroMemoryDetail["memoryType"];
  readonly scopes: string;
  readonly summary: string;
  readonly content: string;
}

const isCreate = Schema.is(KiroMemoryCreate);
const isUpdate = Schema.is(KiroMemoryUpdate);
const failedMessage =
  "Kiro could not complete this memory operation. Check that memory is enabled and your account has access. Refresh before trying again.";

// Remount for a different environment/provider/project; actions stays stable within that target.
export function useKiroMemory(actions: KiroMemoryActions, canManage: boolean) {
  const [page, setPage] = useState<KiroMemoryListResult | null>(null);
  const [syncStatus, setSyncStatus] = useState<KiroMemorySyncStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [pending, setPending] = useState<string | null>("Loading Kiro memory…");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(true);
  const generation = useRef(0);
  const criteria = useRef<KiroMemoryListOptions>({ limit: 50 });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetch memory from the selected environment and discard late replies when its transport changes or unmounts
  useEffect(() => {
    const token = ++generation.current;
    busy.current = true;
    void Promise.allSettled([actions.list({ limit: 50 }), actions.getSyncStatus()]).then(
      ([listed, synced]) => {
        if (generation.current !== token) return;
        if (listed.status === "fulfilled") setPage(listed.value);
        else setError(failedMessage);
        if (synced.status === "fulfilled") setSyncStatus(synced.value);
        busy.current = false;
        setPending(null);
      },
    );
    return () => {
      generation.current += 1;
    };
  }, [actions]);

  async function run<A>(label: string, operation: () => Promise<A>, commit: (result: A) => void) {
    if (busy.current) return;
    const token = generation.current;
    busy.current = true;
    setPending(label);
    setError(null);
    setNotice(null);
    try {
      const result = await operation();
      if (generation.current === token) commit(result);
    } catch {
      if (generation.current === token) setError(failedMessage);
    } finally {
      if (generation.current === token) {
        busy.current = false;
        setPending(null);
      }
    }
  }

  function refresh() {
    return run(
      "Refreshing Kiro memory…",
      () => Promise.allSettled([actions.list(criteria.current), actions.getSyncStatus()]),
      ([listed, synced]) => {
        if (listed.status === "fulfilled") setPage(listed.value);
        else setError(failedMessage);
        if (synced.status === "fulfilled") setSyncStatus(synced.value);
      },
    );
  }

  function search() {
    if (busy.current) return Promise.resolve();
    const filter: KiroMemoryListOptions = {
      limit: 50,
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(scopeFilter ? { scopes: [scopeFilter] } : {}),
    };
    return run(
      "Searching Kiro memory…",
      () => actions.list(filter),
      (listed) => {
        criteria.current = filter;
        setPage(listed);
      },
    );
  }

  function more() {
    const cursor = page?.nextCursor;
    if (!cursor) return Promise.resolve();
    return run(
      "Loading more memories…",
      () => actions.list({ ...criteria.current, cursor }),
      (listed) =>
        setPage((current) =>
          current
            ? {
                ...listed,
                memories: [
                  ...new Map(
                    [...current.memories, ...listed.memories].map((entry) => [entry.id, entry]),
                  ).values(),
                ],
              }
            : listed,
        ),
    );
  }

  function inspect(id: string) {
    return run(
      "Reading memory…",
      () => actions.get(id),
      ({ memory }) =>
        setDraft({
          id: memory.id,
          title: memory.title,
          memoryType: memory.memoryType,
          scopes: memory.scopes.join(", "),
          summary: memory.summary,
          content: memory.content,
        }),
    );
  }

  function add() {
    if (!canManage || busy.current) return;
    setDraft({
      id: null,
      title: "",
      memoryType: "SEMANTIC",
      scopes: "Global",
      summary: "",
      content: "",
    });
    setNotice(null);
    setError(null);
  }

  function change(patch: Partial<Omit<Draft, "id">>) {
    setDraft((current) => (current ? { ...current, ...patch } : null));
  }

  function save() {
    if (!canManage || !draft) return Promise.resolve();
    const input = {
      memoryType: draft.memoryType,
      title: draft.title.trim(),
      scopes: draft.scopes
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
      summary: draft.summary,
      content: draft.content,
    };
    const update = {
      id: draft.id ?? "",
      newTitle: input.title,
      ...(input.memoryType === "UNKNOWN" ? {} : { memoryType: input.memoryType }),
      summary: input.summary,
      content: input.content,
    };
    if (draft.id ? !isUpdate(update) : !isCreate(input)) {
      setError(
        "Use a title of letters, digits, and hyphens (up to 64 characters), a summary up to 250 characters, content up to 20,000 characters, and a valid Kiro scope.",
      );
      return Promise.resolve();
    }
    const id = draft.id;
    const token = generation.current;
    return run(
      "Saving memory…",
      async () => {
        if (id) await actions.update(update);
        else if (isCreate(input)) await actions.create(input);
        if (generation.current !== token) return null;
        setDraft(null);
        setNotice("Memory saved in Kiro.");
        try {
          return await actions.list(criteria.current);
        } catch {
          if (generation.current === token)
            setError("Memory was saved, but the list could not refresh. Refresh to see it.");
          return null;
        }
      },
      (listed) => {
        if (listed) setPage(listed);
      },
    );
  }

  function remove(id: string) {
    if (!canManage) return Promise.resolve();
    const token = generation.current;
    return run(
      "Deleting memory…",
      async () => {
        await actions.delete(id);
        if (generation.current !== token) return null;
        setDraft((current) => (current?.id === id ? null : current));
        setPage((current) =>
          current
            ? { ...current, memories: current.memories.filter((memory) => memory.id !== id) }
            : current,
        );
        setNotice("Memory deleted from Kiro.");
        try {
          return await actions.list(criteria.current);
        } catch {
          if (generation.current === token)
            setError("Memory was deleted, but the list could not refresh. Refresh to update it.");
          return null;
        }
      },
      (listed) => {
        if (listed) setPage(listed);
      },
    );
  }

  function sync() {
    if (!canManage) return Promise.resolve();
    return run(
      "Requesting Kiro memory sync…",
      () => actions.sync(),
      (synced) => {
        setSyncStatus(synced);
        setNotice("Kiro memory sync requested. Refresh to see its current state.");
      },
    );
  }

  return {
    page,
    syncStatus,
    draft,
    query,
    scopeFilter,
    pending,
    error,
    notice,
    setQuery,
    setScopeFilter,
    refresh,
    search,
    more,
    inspect,
    add,
    change,
    save,
    remove,
    sync,
    close: () => setDraft(null),
  };
}
