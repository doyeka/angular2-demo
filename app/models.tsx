import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MODELS } from '../src/core/llm/models';
import { downloadModel, loadModel, pauseDownload, useApp } from '../src/ui/controller';
import { useTheme } from '../src/ui/theme';

const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`;

export default function Models() {
  const app = useApp();
  const t = useTheme();
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ color: t.muted }}>
        Models are downloaded once from Hugging Face and run entirely on-device with llama.cpp. After that, chat and analysis work in airplane mode.
      </Text>
      {MODELS.map((m) => {
        const s = app.modelStates[m.id] ?? { status: 'absent' };
        const loaded = app.modelLoaded === m.id;
        return (
          <View key={m.id} style={[styles.card, { borderColor: loaded ? t.accent : t.border, backgroundColor: t.surface }]}>
            <Text style={[styles.name, { color: t.text }]}>
              {m.label} {m.default ? '· default' : ''}
            </Text>
            <Text style={{ color: t.muted, fontSize: 12 }}>
              {gb(m.sizeBytes)} · ctx {m.nCtx} · needs ≥{m.minRamGb} GB RAM
            </Text>
            <Text style={{ color: t.muted, marginTop: 6 }}>{m.notes}</Text>
            {s.status === 'downloading' || s.status === 'paused' ? (
              <View style={[styles.bar, { backgroundColor: t.border }]}>
                <View style={{ width: `${(100 * s.written) / s.total}%`, height: '100%', backgroundColor: t.accent, borderRadius: 3 }} />
              </View>
            ) : null}
            {s.status === 'error' ? <Text style={{ color: t.danger, marginTop: 6 }}>{s.message}</Text> : null}
            <View style={styles.row}>
              {s.status === 'absent' || s.status === 'error' ? <Act label="Download" color={t.accent} onPress={() => downloadModel(m)} /> : null}
              {s.status === 'downloading' ? <Act label={`Pause (${gb(s.written)})`} color={t.muted} onPress={() => pauseDownload(m)} /> : null}
              {s.status === 'paused' ? <Act label={`Resume (${gb(s.written)})`} color={t.accent} onPress={() => downloadModel(m)} /> : null}
              {s.status === 'ready' && !loaded ? <Act label="Load" color={t.ok} onPress={() => loadModel(m)} /> : null}
              {loaded ? <Text style={{ color: t.ok, fontWeight: '600' }}>Loaded</Text> : null}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

function Act({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.btn, { borderColor: color }]}>
      <Text style={{ color, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1.5, borderRadius: 12, padding: 14 },
  name: { fontSize: 16, fontWeight: '700', marginBottom: 2 },
  bar: { height: 6, borderRadius: 3, marginTop: 10, overflow: 'hidden' },
  row: { flexDirection: 'row', gap: 10, marginTop: 12, alignItems: 'center' },
  btn: { borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
});
