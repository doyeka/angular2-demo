import { useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sharePdf } from '../src/native/pdf';
import { type ChatItem, send, stop, useApp } from '../src/ui/controller';
import { useTheme } from '../src/ui/theme';

const SUGGESTION =
  "Go through my emails and pull in all employment opportunities I've gotten in the last 90 days besides from Anthropic. Organize by salary, company size, funding round and other benefits / level.";

export default function Chat() {
  const app = useApp();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const list = useRef<FlatList<ChatItem>>(null);

  const status = !app.ready
    ? 'Starting…'
    : app.loadProgress !== null
      ? `Loading model ${Math.round(app.loadProgress)}%`
      : app.modelLoaded
        ? `${app.model.label} · on-device${app.gmail ? ` · ${app.gmail}` : ' · no mail connected'}`
        : 'No model loaded — open Models';

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <Text style={[styles.status, { color: t.muted, borderColor: t.border }]}>{status}</Text>
      {app.error ? <Text style={[styles.error, { color: t.danger }]}>{app.error}</Text> : null}
      <FlatList
        ref={list}
        data={app.items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <Pressable onPress={() => setText(SUGGESTION)} style={[styles.suggest, { borderColor: t.border }]}>
            <Text style={{ color: t.muted, fontSize: 12, marginBottom: 4 }}>Try</Text>
            <Text style={{ color: t.text }}>{SUGGESTION}</Text>
          </Pressable>
        }
        renderItem={({ item }) => <Bubble item={item} />}
      />
      <View style={[styles.composer, { borderColor: t.border, paddingBottom: insets.bottom + 8 }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Ask anything — runs on your phone"
          placeholderTextColor={t.muted}
          multiline
          style={[styles.input, { color: t.text, backgroundColor: t.surface }]}
        />
        <Pressable
          onPress={() => {
            if (app.busy) return stop();
            const v = text;
            setText('');
            void send(v);
          }}
          style={[styles.send, { backgroundColor: app.busy ? t.danger : t.accent }]}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>{app.busy ? 'Stop' : 'Send'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ item }: { item: ChatItem }) {
  const t = useTheme();
  if (item.role === 'tool' || item.role === 'progress') {
    return <Text style={{ color: t.muted, fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) }}>{item.text}</Text>;
  }
  if (item.role === 'artifact') {
    return (
      <Pressable onPress={() => item.path && sharePdf(item.path)} style={[styles.artifact, { borderColor: t.accent }]}>
        <Text style={{ color: t.accent, fontWeight: '600' }}>📄 {item.text}</Text>
        <Text style={{ color: t.muted, fontSize: 12 }}>Tap to open / share PDF</Text>
      </Pressable>
    );
  }
  const mine = item.role === 'user';
  return (
    <View style={[styles.bubble, mine ? { alignSelf: 'flex-end', backgroundColor: t.accent } : { alignSelf: 'flex-start', backgroundColor: t.surface }]}>
      <Text style={{ color: mine ? '#fff' : t.text }}>{item.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  status: { fontSize: 12, paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  error: { paddingHorizontal: 16, paddingVertical: 6, fontSize: 13 },
  suggest: { borderWidth: 1, borderRadius: 12, padding: 14, marginTop: 24 },
  bubble: { maxWidth: '88%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  artifact: { borderWidth: 1.5, borderRadius: 12, padding: 12 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 40, maxHeight: 140, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  send: { borderRadius: 12, paddingHorizontal: 16, paddingVertical: 11 },
});
