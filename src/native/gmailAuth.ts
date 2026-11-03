import {
  AuthRequest,
  CodeChallengeMethod,
  exchangeCodeAsync,
  makeRedirectUri,
  refreshAsync,
  ResponseType,
} from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { GmailProvider } from '../core/mail/gmail';

WebBrowser.maybeCompleteAuthSession();

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

/** Read-only: the app never sends, deletes or labels mail. */
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];
const KEY = 'gmail.tokens.v1';

interface Stored {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email: string;
}

function clientId(): string {
  const id = Platform.select({
    ios: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    android: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
  });
  if (!id) throw new Error('Set EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID / EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID (see README).');
  return id;
}

/** Google native-app clients use the reversed client id as the redirect scheme. */
function redirectUri(): string {
  const reversed = clientId().split('.').reverse().join('.');
  return makeRedirectUri({ native: `${reversed}:/oauthredirect` });
}

/** OAuth 2.0 auth-code + PKCE (no client secret on device). */
export async function connectGmail(): Promise<string> {
  const req = new AuthRequest({
    clientId: clientId(),
    scopes: SCOPES,
    redirectUri: redirectUri(),
    responseType: ResponseType.Code,
    usePKCE: true,
    codeChallengeMethod: CodeChallengeMethod.S256,
    extraParams: { access_type: 'offline', prompt: 'consent' },
  });
  const result = await req.promptAsync(discovery);
  if (result.type !== 'success') throw new Error(`Google sign-in ${result.type}`);
  const tok = await exchangeCodeAsync(
    { clientId: clientId(), code: result.params.code, redirectUri: redirectUri(), extraParams: { code_verifier: req.codeVerifier! } },
    discovery,
  );
  const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${tok.accessToken}` },
  }).then((r) => r.json());
  const stored: Stored = {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAt: Date.now() + (tok.expiresIn ?? 3600) * 1000,
    email: profile.emailAddress,
  };
  await SecureStore.setItemAsync(KEY, JSON.stringify(stored));
  return stored.email;
}

export async function disconnectGmail(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

async function load(): Promise<Stored | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  return raw ? JSON.parse(raw) : null;
}

async function freshToken(): Promise<string> {
  const s = await load();
  if (!s) throw new Error('Gmail not connected');
  if (Date.now() < s.expiresAt - 60_000) return s.accessToken;
  if (!s.refreshToken) throw new Error('Gmail session expired — reconnect');
  const tok = await refreshAsync({ clientId: clientId(), refreshToken: s.refreshToken }, discovery);
  const next: Stored = { ...s, accessToken: tok.accessToken, expiresAt: Date.now() + (tok.expiresIn ?? 3600) * 1000, refreshToken: tok.refreshToken ?? s.refreshToken };
  await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  return next.accessToken;
}

export async function restoreGmail(): Promise<GmailProvider | null> {
  const s = await load();
  return s ? new GmailProvider(s.email, freshToken) : null;
}
