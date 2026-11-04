import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { resolveApproval, useApp } from './controller';
import { useTheme } from './theme';

/** Human-in-the-loop gate for network / destructive MCP tools. */
export function ApprovalSheet() {
  const { pendingApproval: p } = useApp();
  const t = useTheme();
  if (!p) return null;
  return (
    <Modal transparent animationType="slide" visible onRequestClose={() => resolveApproval('deny')}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: t.bg, borderColor: t.border }]}>
          <Text style={[styles.title, { color: t.text }]}>Allow {p.tool.annotations.title ?? p.tool.qualifiedName}?</Text>
          <Text style={{ color: t.muted, marginBottom: 8 }}>{p.reason}</Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            Server: {p.tool.server} · Tool: {p.tool.name}
          </Text>
          <ScrollView style={[styles.args, { backgroundColor: t.surface }]}>
            <Text style={{ color: t.text, fontFamily: 'Menlo', fontSize: 12 }}>{JSON.stringify(p.args, null, 2)}</Text>
          </ScrollView>
          <View style={styles.row}>
            <Btn label="Deny" color={t.danger} onPress={() => resolveApproval('deny')} />
            <Btn label="Allow once" color={t.accent} onPress={() => resolveApproval('allow-once')} />
            <Btn label="Always" color={t.ok} onPress={() => resolveApproval('allow-always')} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Btn({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.btn, { borderColor: color, opacity: pressed ? 0.6 : 1 }]}>
      <Text style={{ color, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { padding: 20, paddingBottom: 36, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 17, fontWeight: '700', marginBottom: 6 },
  args: { maxHeight: 180, borderRadius: 8, padding: 10, marginVertical: 12 },
  row: { flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
  btn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10, borderWidth: 1.5 },
});
