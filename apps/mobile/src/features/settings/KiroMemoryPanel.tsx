import { useKiroMemory, type KiroMemoryActions } from "@t3tools/client-runtime/kiro-memory";
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
  const memory = useKiroMemory(actions, canManage);
  const disabled = !canManage || memory.pending !== null;
  const draft = memory.draft;
  return (
    <View className="gap-4">
      <AppText className="font-t3-medium">Kiro memory</AppText>
      <AppText>
        Memories belong to your Kiro account on this environment. Choosing a project does not hide
        memories from other scopes.
      </AppText>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Refresh"
          size="compact"
          disabled={disabled}
          onPress={() => {
            void memory.refresh();
          }}
        />
        <Button label="Add memory" size="compact" disabled={disabled} onPress={memory.add} />
      </View>
      <View className="gap-2">
        <AppText>Search</AppText>
        <TextInput
          accessibilityLabel="Search Kiro memory"
          value={memory.query}
          onChangeText={memory.setQuery}
          editable={!disabled}
          maxLength={200}
          className="rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
        />
        <AppText>Scope filter (empty for all scopes)</AppText>
        <TextInput
          accessibilityLabel="Filter Kiro memory scope"
          value={memory.scopeFilter}
          onChangeText={memory.setScopeFilter}
          editable={!disabled}
          className="rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
        />
        <Button
          label="Search"
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
            Memory sync: {memory.syncStatus.state}
            {memory.syncStatus.reason ? ` (${memory.syncStatus.reason})` : ""}
          </AppText>
          <Button
            label="Sync now"
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
          <AppText>{memory.page.total} memories found.</AppText>
          {memory.page.memories.map((entry) => (
            <View key={entry.id} className="gap-1 rounded-lg border border-divider p-3">
              <AppText className="font-t3-medium">{entry.title}</AppText>
              <AppText>{entry.summary}</AppText>
              <AppText>
                {entry.scopes.join(", ")} · {entry.memoryType}
              </AppText>
              {entry.unresolvedConflict ? <AppText>Unresolved conflict</AppText> : null}
              <Button
                label="Inspect"
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
              label="Load more"
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
            {draft.id ? "Inspect / edit memory" : "Add memory"}
          </AppText>
          <AppText>Title (letters, digits, and hyphens; up to 64 characters)</AppText>
          <TextInput
            accessibilityLabel="Memory title"
            value={draft.title}
            editable={!disabled}
            maxLength={64}
            autoCapitalize="none"
            onChangeText={(title) => memory.change({ title })}
            className="rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
          />
          <AppText>Type: {draft.memoryType}</AppText>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Knowledge"
              size="compact"
              tone={draft.memoryType === "SEMANTIC" ? "primary" : "secondary"}
              disabled={disabled}
              onPress={() => memory.change({ memoryType: "SEMANTIC" })}
            />
            <Button
              label="User preference"
              size="compact"
              tone={draft.memoryType === "USER_PREFERENCE" ? "primary" : "secondary"}
              disabled={disabled}
              onPress={() => memory.change({ memoryType: "USER_PREFERENCE" })}
            />
          </View>
          <AppText>
            Scope: Global, workspace:name, or repo:provider/owner/name; separate multiple scopes
            with commas.
          </AppText>
          <TextInput
            accessibilityLabel="Memory scope"
            value={draft.scopes}
            editable={!disabled && draft.id === null}
            autoCapitalize="none"
            onChangeText={(scopes) => memory.change({ scopes })}
            className="rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
          />
          <AppText>Summary</AppText>
          <TextInput
            accessibilityLabel="Memory summary"
            value={draft.summary}
            editable={!disabled}
            maxLength={250}
            multiline
            onChangeText={(summary) => memory.change({ summary })}
            className="rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
          />
          <AppText>Content</AppText>
          <TextInput
            accessibilityLabel="Memory content"
            value={draft.content}
            editable={!disabled}
            maxLength={20_000}
            multiline
            onChangeText={(content) => memory.change({ content })}
            className="min-h-40 rounded-lg border border-divider bg-field px-3 py-2 text-foreground"
          />
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Save memory"
              size="compact"
              disabled={disabled}
              onPress={() => {
                void memory.save();
              }}
            />
            <Button
              label="Close"
              size="compact"
              disabled={memory.pending !== null}
              onPress={memory.close}
            />
            {draft.id ? (
              <Button
                label="Delete…"
                size="compact"
                tone="danger"
                disabled={disabled}
                onPress={() => {
                  const id = draft.id;
                  Dialog.confirm({
                    title: "Delete memory?",
                    message:
                      "Delete this memory from Kiro? Kiro may sync the deletion to your account.",
                    confirmText: "Delete memory",
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
