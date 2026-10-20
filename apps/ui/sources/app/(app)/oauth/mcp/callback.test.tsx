import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_OAUTH_CALLBACK_URL_V1,
  MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1,
} from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';

import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readMcpOAuthOpenerMessage } from '@/sync/ops/connectedAccounts/mcpOAuthCallback';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const boundary = vi.hoisted(() => ({
  signedIn: false,
  execute: vi.fn(),
  replace: vi.fn(),
  clipboard: vi.fn(async (_value: string) => true),
}));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('expo-router', async () => {
  const router = (
    await import('@/dev/testkit/mocks/router')
  ).createExpoRouterMock();
  return {
    ...router.module,
    useRouter: () => ({
      ...router.module.useRouter(),
      replace: boundary.replace,
    }),
    useLocalSearchParams: () => ({}),
  };
});
// Credentials and the mounted Action front door are the boundaries; the callback controller runs for real.
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: boundary.signedIn }),
}));
vi.mock('@/components/approvals/useMountedActionExecution', () => ({
  useMountedActionExecution: (scope: unknown) => ({
    execute: boundary.execute,
    ready: Boolean(scope),
    isCurrent: () => true,
    approval: {},
  }),
}));
vi.mock('@/utils/ui/clipboard', () => ({
  setClipboardStringSafe: boundary.clipboard,
}));

const { default: McpOAuthCallbackRoute } = await import('./callback');

const query =
  '?code=code-1&state=attempt-1.nonce&iss=https%3A%2F%2Fissuer.example';
const browser = globalThis as unknown as Record<string, unknown>;
let replaced: string[];
let posted: Array<{ message: unknown; origin: string }>;

function install(openerOrigin?: string) {
  replaced = [];
  posted = [];
  browser.location = { search: query };
  browser.history = {
    replaceState: (_d: unknown, _u: string, url: string) => replaced.push(url),
  };
  browser.close = vi.fn();
  browser.opener = openerOrigin
    ? {
        get location() {
          if (openerOrigin === 'inaccessible') throw new DOMException('Cross-origin access denied', 'SecurityError');
          return { origin: openerOrigin };
        },
        postMessage: (message: unknown, origin: string) =>
          posted.push({ message, origin }),
      }
    : null;
}

beforeEach(() => {
  boundary.signedIn = false;
  boundary.execute.mockReset();
  boundary.replace.mockReset();
  boundary.clipboard.mockClear();
  getStorage().setState({ settingsScope: null });
});
afterEach(async () => {
  await standardCleanup();
  for (const key of ['location', 'history', 'close', 'opener'])
    delete browser[key];
});

async function settle(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    for (let i = 0; i < 40; i += 1) {
        if (screen.findAllByTestId(testID).length > 0) return;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    throw new Error(`never showed ${testID}: ${screen.getTextContent()}`);
}

describe('/oauth/mcp/callback', () => {
  it('hands the answer to an opener on app.happier.dev only, strips the address and calls no Action', async () => {
    install('https://app.happier.dev');
    const screen = await renderScreen(<McpOAuthCallbackRoute />);
    await settle(screen, 'mcp-oauth-callback:opener');
    expect(replaced).toEqual(['/oauth/mcp/callback']);
    expect(posted).toEqual([
      {
        origin: 'https://app.happier.dev',
        message: {
          type: 'happier.mcp.oauth',
          code: 'code-1',
          state: 'attempt-1.nonce',
          iss: 'https://issuer.example',
        },
      },
    ]);
    expect(browser.close).toHaveBeenCalled();
    expect(posted.map(({ message, origin }) => readMcpOAuthOpenerMessage({ origin, data: message }))).toEqual([
      { type: 'happier.mcp.oauth', code: 'code-1', state: 'attempt-1.nonce', iss: 'https://issuer.example' },
    ]);
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  it.each(['https://self-hosted.example', 'inaccessible', 'https://app.happier.dev.evil.example'])('retains the callback for Copy code without closing an untrusted opener: %s', async (origin) => {
    install(origin);
    boundary.signedIn = true;
    getStorage().setState({ settingsScope: { serverId: 'home', accountId: 'account' } });
    const screen = await renderScreen(<McpOAuthCallbackRoute />);
    await settle(screen, 'mcp-oauth-callback:paste');
    expect(screen.findAllByTestId('mcp-oauth-callback:copy').length).toBeGreaterThan(0);
    expect(replaced).toEqual(['/oauth/mcp/callback']);
    expect(posted).toEqual([]);
    expect(browser.close).not.toHaveBeenCalled();
    expect(boundary.execute).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('mcp-oauth-callback:copy');
    expect(boundary.clipboard).toHaveBeenCalledWith(`${MCP_OAUTH_CALLBACK_URL_V1}${query}`);
  });

  it('signed out, strips the address and offers the full callback to copy', async () => {
    install();
    const screen = await renderScreen(<McpOAuthCallbackRoute />);
    await settle(screen, 'mcp-oauth-callback:paste');
    expect(replaced).toEqual(['/oauth/mcp/callback']);
    expect(boundary.execute).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('mcp-oauth-callback:copy');
    expect(boundary.clipboard).toHaveBeenCalledWith(
      `${MCP_OAUTH_CALLBACK_URL_V1}${query}`,
    );
  });

  it.each([false, true])('signed in, completes with the issuer and retains an editable app refusal (invalidClient=%s)', async invalidClient => {
    install();
    boundary.signedIn = true;
    getStorage().setState({
      settingsScope: { serverId: 'home', accountId: 'account' },
      machines: {
        m1: {
          id: 'm1',
          active: true,
          activeAt: Date.now(),
          createdAt: 1,
          updatedAt: 1,
          seq: 1,
          metadata: null,
          metadataVersion: 0,
          daemonState: null,
          daemonStateVersion: 0,
        } as never,
      },
    } as never);
    const account = {
      service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1,
      accountId: 'server-1',
    };
    boundary.execute.mockImplementation(
      async (actionId: string, input: Record<string, unknown>) => {
        if (actionId === 'connectedServices.authentication.pending.list')
          return {
            ok: true,
            result: {
              status: 'pendingAttempts',
              attempts: [
                {
                  attemptId: 'attempt-1',
                  kind: 'oauth',
                  modeId: 'oauth',
                  intent: 'connect',
                  phase: 'awaitingOAuth',
                  createdAtMs: 1,
                  expiresAtMs: Date.now() + 60_000,
                },
              ],
            },
          };
        if (actionId === 'connectedServices.authentication.read')
          return {
            ok: true,
            result: {
              status: 'awaitingOAuth',
              attemptId: 'attempt-1',
              authorizationUrl: 'https://issuer.example/authorize',
              callbackUrl: MCP_OAUTH_CALLBACK_URL_V1,
              expiresAtMs: Date.now() + 60_000,
            },
          };
        if (actionId === 'connectedServices.authentication.completeOAuth') {
          expect(input).toMatchObject({
            machineId: 'm1',
            attemptId: 'attempt-1',
            completion: {
              code: 'code-1',
              state: 'attempt-1.nonce',
              iss: 'https://issuer.example',
            },
          });
          return {
            ok: true,
            result: invalidClient ? { status: 'rejected', attemptId: 'attempt-1', code: 'invalid_client',
              diagnostic: { code: 'invalid_client', severity: 'error' } } : { status: 'connected', attemptId: 'attempt-1', account },
          };
        }
        throw new Error(`unexpected ${actionId}`);
      },
    );
    const screen = await renderScreen(<McpOAuthCallbackRoute />);
    await settle(screen, invalidClient ? 'mcp-oauth-callback:invalid-client' : 'mcp-oauth-callback:connected');
    expect(replaced).toEqual(['/oauth/mcp/callback']);
    expect(boundary.execute).toHaveBeenCalledWith(
      'connectedServices.authentication.completeOAuth',
      expect.anything(),
      expect.anything(),
    );
    if (invalidClient) expect(boundary.replace).not.toHaveBeenCalled();
    else expect(boundary.replace).toHaveBeenCalledWith('/settings/mcp/server-1');
  });
});
