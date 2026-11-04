import { Link, Stack } from 'expo-router';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { ApprovalSheet } from '../src/ui/ApprovalSheet';
import { init } from '../src/ui/controller';
import { useTheme } from '../src/ui/theme';

export default function RootLayout() {
  const t = useTheme();
  useEffect(() => {
    void init();
  }, []);
  return (
    <>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.bg },
          headerTintColor: t.text,
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: 'Pocket Agent',
            headerRight: () => (
              <View style={{ flexDirection: 'row', gap: 16 }}>
                <Link href="/reports"><Text style={{ color: t.accent }}>Reports</Text></Link>
                <Link href="/connections"><Text style={{ color: t.accent }}>Connect</Text></Link>
                <Link href="/models"><Text style={{ color: t.accent }}>Models</Text></Link>
              </View>
            ),
          }}
        />
        <Stack.Screen name="models" options={{ title: 'Models' }} />
        <Stack.Screen name="connections" options={{ title: 'Connections & memory' }} />
        <Stack.Screen name="reports" options={{ title: 'Reports & jobs' }} />
      </Stack>
      <ApprovalSheet />
    </>
  );
}
