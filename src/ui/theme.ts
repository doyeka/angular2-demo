import { useColorScheme } from 'react-native';

const light = { bg: '#ffffff', surface: '#f4f4f6', border: '#e2e2e6', text: '#16161a', muted: '#6b6b76', accent: '#2f5bea', danger: '#c62828', ok: '#1a7f37' };
const dark = { bg: '#0f0f12', surface: '#1a1a1f', border: '#2a2a31', text: '#f2f2f5', muted: '#9a9aa6', accent: '#7b9bff', danger: '#ff6b6b', ok: '#4cc38a' };

export type Theme = typeof light;
export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);
