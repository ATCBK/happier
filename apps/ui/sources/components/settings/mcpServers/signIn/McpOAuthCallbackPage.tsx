import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MCP_OAUTH_CALLBACK_URL_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';

import { useAuth } from '@/auth/context/AuthContext';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { storage } from '@/sync/domains/state/storageStore';
import {
  completeMcpOAuthCallback,
  type McpOAuthCallbackInput,
  type McpOAuthCallbackOutcome,
} from '@/sync/ops/connectedAccounts/mcpOAuthCallback';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

const RESPONSE_PARAMS = [
  'code',
  'state',
  'iss',
  'error',
  'error_description',
  'error_uri',
] as const;

/**
 * The provider's answer, as the canonical callback address. The route *is* that address (the web app at
 * app.happier.dev, or the same path opened in the app by its universal link), so only the query is read
 * here; parsing and validation stay with the callback controller and the daemon.
 */
function readCallbackUrl(
  params: Readonly<Record<string, string | string[] | undefined>>,
): string {
  const search =
    Platform.OS === 'web'
      ? (globalThis as { location?: { search?: string } }).location?.search
      : undefined;
  if (search)
    return `${MCP_OAUTH_CALLBACK_URL_V1}${search.startsWith('?') ? search : `?${search}`}`;
  const query = new URLSearchParams();
  for (const key of RESPONSE_PARAMS) {
    const value = params[key];
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') query.set(key, first);
  }
  const encoded = query.toString();
  return encoded
    ? `${MCP_OAUTH_CALLBACK_URL_V1}?${encoded}`
    : MCP_OAUTH_CALLBACK_URL_V1;
}

function readBrowser(): McpOAuthCallbackInput['browser'] {
  if (Platform.OS !== 'web') return undefined;
  const browser = globalThis as unknown as {
    history?: {
      replaceState(data: unknown, unused: string, url: string): void;
    };
    close?: () => void;
    opener?: { location?: { origin?: string }; postMessage(message: unknown, origin: string): void } | null;
    self?: unknown;
  };
  const opener =
    browser.opener && browser.opener !== browser.self
      ? browser.opener
      : undefined;
  let openerOrigin: string | undefined;
  try {
    openerOrigin = opener?.location?.origin;
  } catch {
    // Cross-origin WindowProxy access is denied; preserve paste recovery.
  }
  return {
    replaceUrl: (path) => browser.history?.replaceState(null, '', path),
    close: () => browser.close?.(),
    ...(opener
      ? {
          opener: {
            origin: openerOrigin,
            postMessage: (message, origin) =>
              opener.postMessage(message, origin),
          },
        }
      : {}),
  };
}

type CallbackView = Readonly<{ kind: 'working' }> | McpOAuthCallbackOutcome;

/**
 * `/oauth/mcp/callback` (C34): the MCP sign-in's return. It hands the answer to the page that opened it,
 * finishes it for a signed-in Account, or, signed out or on another device, offers the code to copy into
 * the page where the sign-in started. The URL loses its code and state before anything else happens.
 */
export function McpOAuthCallbackPage() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const auth = useAuth();
  const settingsScope = useAccountSettingsScope();
  const scope = auth.isAuthenticated && settingsScope ? settingsScope : null;
  const execution = useMountedActionExecution(scope);
  const [view, setView] = React.useState<CallbackView>({ kind: 'working' });
  const [copied, setCopied] = React.useState(false);
  const started = React.useRef(false);
  // Read once, before the controller strips the address.
  const callbackUrl = React.useMemo(
    () =>
      readCallbackUrl(params as Record<string, string | string[] | undefined>),
    [],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (started.current) return;
    // Signed in: wait for the Account binding so the completion runs under its custody.
    if (scope && !execution.ready) return;
    started.current = true;
    const account: McpOAuthCallbackInput['account'] = scope
      ? {
          serverId: scope.serverId,
          expectedAccountId: scope.accountId,
          assertCurrent: () => {
            if (!execution.isCurrent())
              throw Object.assign(new Error('Account changed'), {
                code: 'action_account_scope_changed',
              });
          },
          readMachines: async () =>
            resolveVisibleMachinesForActiveServerFromState(storage.getState()),
          executeAction: execution.execute,
        }
      : undefined;
    void completeMcpOAuthCallback({
      callbackUrl,
      browser: readBrowser(),
      ...(account ? { account } : {}),
    })
      .then((outcome) => {
        setView(outcome);
        if (outcome.kind === 'connected')
          router.replace(outcome.returnTo as never);
      })
      // Anything that stops the completion here leaves the answer with the person, to paste.
      .catch(() => setView({ kind: 'paste', callbackUrl }));
  }, [callbackUrl, execution, router, scope]);

  const openServers = React.useCallback(
    () => router.replace('/settings/mcp' as never),
    [router],
  );
  const copy = React.useCallback(async () => {
    if (view.kind !== 'paste') return;
    setCopied(await setClipboardStringSafe(view.callbackUrl));
  }, [view]);

  let content: React.ReactNode;
  switch (view.kind) {
    case 'working':
      content = (
        <View style={styles.working} testID="mcp-oauth-callback:working">
          <ActivitySpinner size="small" />
          <Text variant="body" style={styles.workingText}>
            {t('capabilities.mcpSignIn.callback.finishing')}
          </Text>
        </View>
      );
      break;
    case 'opener':
      content = (
        <SurfaceStateCard
          testID="mcp-oauth-callback:opener"
          kind="success"
          title={t('capabilities.mcpSignIn.callback.closeTitle')}
          reason={t('capabilities.mcpSignIn.callback.closeBody')}
        />
      );
      break;
    case 'connected':
      content = (
        <SurfaceStateCard
          testID="mcp-oauth-callback:connected"
          kind="success"
          title={t('capabilities.mcpSignIn.callback.connectedTitle')}
          reason={t('capabilities.mcpSignIn.callback.connectedBody')}
        />
      );
      break;
    case 'paste':
      content = (
        <SurfaceStateCard
          testID="mcp-oauth-callback:paste"
          kind="empty"
          title={t('capabilities.mcpSignIn.callback.pasteTitle')}
          reason={t('capabilities.mcpSignIn.callback.pasteBody')}
          action={{
            testID: 'mcp-oauth-callback:copy',
            label: copied
              ? t('capabilities.mcpSignIn.callback.copied')
              : t('capabilities.mcpSignIn.callback.copyCode'),
            onPress: copy,
          }}
        />
      );
      break;
    case 'invalid':
      content = (
        <SurfaceStateCard
          testID="mcp-oauth-callback:invalid"
          kind="warning"
          title={t('capabilities.mcpSignIn.callback.invalidTitle')}
          reason={t('capabilities.mcpSignIn.callback.invalidBody')}
          action={
            auth.isAuthenticated
              ? {
                  label: t('capabilities.mcpSignIn.callback.openServers'),
                  onPress: openServers,
                }
              : undefined
          }
        />
      );
      break;
    case 'unfinished': {
      const invalidClient = view.response.status === 'rejected' && view.response.code === 'invalid_client';
      content = (
        <SurfaceStateCard
          testID={invalidClient ? 'mcp-oauth-callback:invalid-client' : 'mcp-oauth-callback:unfinished'}
          kind="warning"
          title={t(invalidClient ? 'capabilities.mcpSignIn.invalidClientTitle' : 'capabilities.mcpSignIn.callback.unfinishedTitle')}
          reason={t(invalidClient ? 'capabilities.mcpSignIn.invalidClientBody' : 'capabilities.mcpSignIn.callback.unfinishedBody')}
          action={{
            label: t('capabilities.mcpSignIn.callback.openServers'),
            onPress: openServers,
          }}
        />
      );
      break;
    }
  }
  return <View style={styles.page}>{content}</View>;
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.space.s16,
    backgroundColor: theme.colors.surface.base,
  },
  working: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  workingText: { color: theme.colors.text.secondary },
}));
