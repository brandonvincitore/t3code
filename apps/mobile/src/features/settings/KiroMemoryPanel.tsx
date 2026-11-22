import { useKiroMemory, type KiroMemoryActions } from "@t3tools/client-runtime/kiro-memory";
import { Plural, T, useGT, useMessages, Var } from "gt-react-native";
import { TextInput, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";

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
  const disabled = !canManage || memory.pending !== null;
  const draft = memory.draft;
  return (
    <View className="gap-4">
      <AppText className="font-t3-medium">
        <T>Kiro memory</T>
      </AppText>
      <AppText>
        <T>
          Memories belong to your Kiro account on this environment. Choosing a project does not hide
          memories from other scopes.
        </T>
      </AppText>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={gt("Refresh")}
          size="compact"
          disabled={disabled}
          onPress={() => {
            void memory.refresh();
          }}
        />
        <Button label={gt("Add memory")} size="compact" disabled={disabled} onPress={memory.add} />
      </View>
      <View className="gap-2">
        <AppText>
          <T context="noun, heading for searching memories">Search</T>
        </AppText>
        <TextInput
          accessibilityLabel={gt("Search Kiro memory")}
          value={memory.query}
          onChangeText={memory.setQuery}
          editable={!disabled}
          maxLength={200}
          className="rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
        />
        <AppText>
          <T>Scope filter (empty for all scopes)</T>
        </AppText>
        <TextInput
          accessibilityLabel={gt("Filter Kiro memory scope")}
          value={memory.scopeFilter}
          onChangeText={memory.setScopeFilter}
          editable={!disabled}
          className="rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
        />
        <Button
          label={gt("Search", { $context: "verb, searches memories" })}
          size="compact"
          disabled={disabled}
          onPress={() => {
            void memory.search();
          }}
        />
      </View>
      {memory.syncStatus ? (
        <View className="gap-2">
          <AppText>
            {memory.syncStatus.reason ? (
              <T>
                Memory sync: <Var>{memory.syncStatus.state}</Var> (
                <Var>{memory.syncStatus.reason}</Var>)
              </T>
            ) : (
              <T>
                Memory sync: <Var>{memory.syncStatus.state}</Var>
              </T>
            )}
          </AppText>
          <Button
            label={gt("Sync now")}
            size="compact"
            disabled={disabled}
            onPress={() => {
              void memory.sync();
            }}
          />
        </View>
      ) : null}
      {memory.page ? (
        <View className="gap-3">
          <AppText>
            <T>
              <Plural
                n={memory.page.total}
                one={
                  <>
                    <Var>{String(memory.page.total)}</Var> memories found.
                  </>
                }
                other={
                  <>
                    <Var>{String(memory.page.total)}</Var> memories found.
                  </>
                }
              />
            </T>
          </AppText>
          {memory.page.memories.map((entry) => (
            <View key={entry.id} className="gap-1 rounded-lg border border-divider p-3">
              <AppText className="font-t3-medium">{entry.title}</AppText>
              <AppText>{entry.summary}</AppText>
              <AppText>
                {entry.scopes.join(", ")} · {entry.memoryType}
              </AppText>
              {entry.unresolvedConflict ? (
                <AppText>
                  <T>Unresolved conflict</T>
                </AppText>
              ) : null}
              <Button
                label={gt("Inspect")}
                size="compact"
                disabled={disabled}
                onPress={() => {
                  void memory.inspect(entry.id);
                }}
              />
            </View>
          ))}
          {memory.page.nextCursor ? (
            <Button
              label={gt("Load more")}
              size="compact"
              disabled={disabled}
              onPress={() => {
                void memory.more();
              }}
            />
          ) : null}
        </View>
      ) : null}
      {draft ? (
        <View className="gap-3 rounded-lg border border-divider p-3">
          <AppText className="font-t3-medium">
            {draft.id ? gt("Inspect / edit memory") : gt("Add memory")}
          </AppText>
          <AppText>
            <T>Title (letters, digits, and hyphens; up to 64 characters)</T>
          </AppText>
          <TextInput
            accessibilityLabel={gt("Memory title")}
            value={draft.title}
            editable={!disabled}
            maxLength={64}
            autoCapitalize="none"
            onChangeText={(title) => memory.change({ title })}
            className="rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
          />
          <AppText>
            <T>
              Type: <Var>{draft.memoryType}</Var>
            </T>
          </AppText>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={gt("Knowledge")}
              size="compact"
              tone={draft.memoryType === "SEMANTIC" ? "primary" : "secondary"}
              disabled={disabled}
              onPress={() => memory.change({ memoryType: "SEMANTIC" })}
            />
            <Button
              label={gt("User preference")}
              size="compact"
              tone={draft.memoryType === "USER_PREFERENCE" ? "primary" : "secondary"}
              disabled={disabled}
              onPress={() => memory.change({ memoryType: "USER_PREFERENCE" })}
            />
          </View>
          <AppText>
            <T>
              Scope: <Var>{"Global"}</Var>, <Var>{"workspace:name"}</Var>, or{" "}
              <Var>{"repo:provider/owner/name"}</Var>; separate multiple scopes with commas.
            </T>
          </AppText>
          <TextInput
            accessibilityLabel={gt("Memory scope")}
            value={draft.scopes}
            editable={!disabled && draft.id === null}
            autoCapitalize="none"
            onChangeText={(scopes) => memory.change({ scopes })}
            className="rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
          />
          <AppText>
            <T>Summary</T>
          </AppText>
          <TextInput
            accessibilityLabel={gt("Memory summary")}
            value={draft.summary}
            editable={!disabled}
            maxLength={250}
            multiline
            onChangeText={(summary) => memory.change({ summary })}
            className="rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
          />
          <AppText>
            <T>Content</T>
          </AppText>
          <TextInput
            accessibilityLabel={gt("Memory content")}
            value={draft.content}
            editable={!disabled}
            maxLength={20_000}
            multiline
            onChangeText={(content) => memory.change({ content })}
            className="min-h-40 rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
          />
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={gt("Save memory")}
              size="compact"
              disabled={disabled}
              onPress={() => {
                void memory.save();
              }}
            />
            <Button
              label={gt("Close", { $context: "verb, closes the memory editor" })}
              size="compact"
              disabled={memory.pending !== null}
              onPress={memory.close}
            />
            {draft.id ? (
              <Button
                label={gt("Delete…")}
                size="compact"
                tone="danger"
                disabled={disabled}
                onPress={() => {
                  const id = draft.id;
                  Dialog.confirm({
                    title: gt("Delete memory?"),
                    message: gt(
                      "Delete this memory from Kiro? Kiro may sync the deletion to your account.",
                    ),
                    confirmText: gt("Delete memory"),
                    destructive: true,
                    onConfirm: () => {
                      if (id) void memory.remove(id);
                    },
                  });
                }}
              />
            ) : null}
          </View>
        </View>
      ) : null}
      {memory.pending ? <AppText accessibilityLiveRegion="polite">{memory.pending}</AppText> : null}
      {memory.error ? <AppText accessibilityRole="alert">{memory.error}</AppText> : null}
      {memory.notice ? <AppText accessibilityLiveRegion="polite">{memory.notice}</AppText> : null}
    </View>
  );
}
