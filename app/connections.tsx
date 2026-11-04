import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { Memory } from '../src/core/memory/store';
import { addRemoteServer, linkGmail, memories, servers, setEnrichment, unlinkGmail, useApp } from '../src/ui/controller';
import { useTheme } from '../src/ui/theme';

export default function Connections() {
  const app = useApp();
  const t = useTheme();
  const [mems, setMems] = useState<Memory[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    void memories().then(setMems);
  }, [app.items.length]);

  const input = [styles.input, { color: t.text, backgroundColor: t.surface, borderColor: t.border }];

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 18 }}>
      <Section title="Email (in-process MCP server)">
        <Text style={{ color: t.muted }}>
          Gmail, read-only scope. Mail is synced into an on-device full-text index; the model only ever reads the local copy.
        </Text>
        {app.gmail ? (
          <Row>
            <Text style={{ color: t.text, flex: 1 }}>Connected: {app.gmail}</Text>
            <Btn label="Disconnect" color={t.danger} onPress={unlinkGmail} />
          </Row>
        ) : (
          <Btn label="Connect Gmail" color={t.accent} onPress={linkGmail} />
        )}
      </Section>

      <Section title="Company enrichment (network)">
        <Row>
          <Text style={{ color: t.text, flex: 1 }}>Look up headcount / funding from public sources (Wikidata). Asks before each use.</Text>
          <Switch value={app.enrichEnabled} onValueChange={(v) => void setEnrichment(v)} />
        </Row>
      </Section>

      <Section title="MCP servers">
        {servers().map((s) => (
          <Text key={s.name} style={{ color: t.text }}>
            • {s.name} <Text style={{ color: t.muted }}>({s.kind}, {s.toolCount} tools)</Text>
          </Text>
        ))}
        <Text style={{ color: t.muted, marginTop: 8 }}>Add a remote server (Streamable HTTP). Remote tools always require approval.</Text>
        <TextInput placeholder="name (e.g. calendar)" placeholderTextColor={t.muted} value={name} onChangeText={setName} style={input} autoCapitalize="none" />
        <TextInput placeholder="https://…/mcp" placeholderTextColor={t.muted} value={url} onChangeText={setUrl} style={input} autoCapitalize="none" keyboardType="url" />
        <TextInput placeholder="bearer token (optional)" placeholderTextColor={t.muted} value={token} onChangeText={setToken} style={input} autoCapitalize="none" secureTextEntry />
        <Btn
          label="Add server"
          color={t.accent}
          onPress={async () => {
            try {
              await addRemoteServer(name.trim(), url.trim(), token.trim() || undefined);
              setMsg(`Connected ${name}`);
              force((x) => x + 1);
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}
        />
        {msg ? <Text style={{ color: t.muted }}>{msg}</Text> : null}
      </Section>

      <Section title={`Memory (${mems.length})`}>
        {mems.length ? (
          mems.map((m) => (
            <Text key={m.id} style={{ color: t.text }}>
              • {m.content} <Text style={{ color: t.muted }}>[{m.kind}]</Text>
            </Text>
          ))
        ) : (
          <Text style={{ color: t.muted }}>Nothing saved yet. The assistant saves durable facts you share (ask it to forget anything).</Text>
        )}
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }}>{title}</Text>
      {children}
    </View>
  );
}
const Row = ({ children }: { children: React.ReactNode }) => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>{children}</View>;
function Btn({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.btn, { borderColor: color }]}>
      <Text style={{ color, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  btn: { borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9, alignSelf: 'flex-start' },
});
