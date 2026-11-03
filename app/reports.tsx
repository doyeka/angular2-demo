import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { sharePdf } from '../src/native/pdf';
import { artifacts, resumeJob, useApp } from '../src/ui/controller';
import { useTheme } from '../src/ui/theme';

type Row = { id: string; title: string; variant: string; path: string; created_at: number };

export default function Reports() {
  const app = useApp();
  const t = useTheme();
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    void artifacts().then(setRows);
  }, [app.items.length, app.busy]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      {app.resumable.length ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: t.text, fontWeight: '700' }}>Interrupted jobs</Text>
          {app.resumable.map((j) => (
            <View key={j.id} style={[styles.card, { borderColor: t.border, backgroundColor: t.surface }]}>
              <Text style={{ color: t.text }}>{j.skill}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>
                {j.status} at {j.stage ?? 'start'} ({j.progressDone}/{j.progressTotal}) — finished items are kept
              </Text>
              <Pressable disabled={app.busy} onPress={() => resumeJob(j)} style={[styles.btn, { borderColor: t.accent }]}>
                <Text style={{ color: t.accent, fontWeight: '600' }}>Resume</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <Text style={{ color: t.text, fontWeight: '700' }}>Generated PDFs</Text>
      {rows.length ? (
        rows.map((r) => (
          <Pressable key={r.id} onPress={() => sharePdf(r.path)} style={[styles.card, { borderColor: r.variant === 'peer' ? t.ok : t.border, backgroundColor: t.surface }]}>
            <Text style={{ color: t.text, fontWeight: '600' }}>{r.title}</Text>
            <Text style={{ color: t.muted, fontSize: 12 }}>
              {new Date(r.created_at).toLocaleString()} · {r.variant === 'peer' ? 'safe to share' : 'private — contains contacts'}
            </Text>
          </Pressable>
        ))
      ) : (
        <Text style={{ color: t.muted }}>No reports yet.</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1.5, borderRadius: 12, padding: 14, gap: 4 },
  btn: { borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, alignSelf: 'flex-start', marginTop: 6 },
});
