/** @vitest-environment jsdom */
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const viewport = vi.hoisted(() => ({ dimensions: { width: 1440, height: 900, scale: 1, fontScale: 1 } }));
const transport = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => ({ params: { draftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45', machineId: 'machine', directory: '/repo' } }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
  pathname: '/new', params: () => route.params,
}).module);
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
vi.mock('react-native', async () => {
  const rnw = await vi.importActual<typeof import('react-native-web')>('react-native-web');
  return { ...rnw, useWindowDimensions: () => viewport.dimensions };
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport }));
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { default: NewSessionRoute } = await import('@/app/(app)/new');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { sync } = await import('@/sync/sync');
const { ensureSessionDraftRepositoryHydrated, resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { clearBrowserRecords } = await import('@/sync/domains/state/browserRecordStorage');
const { McpServerCatalogV1Schema } = await import('@happier-dev/protocol/mcp/servers/serverRowsV1');
const { applyMcpServerCatalogSnapshot } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { resolveSessionCapabilitiesV1 } = await import('@happier-dev/protocol/reach/resolveSessionCapabilitiesV1');
const { SpawnCapabilitiesPreviewOutputV1Schema } = await import('@happier-dev/protocol/actions/specs/sessionCapabilities');
const { createRequire } = getVitestNodeBuiltin<typeof import('node:module')>('node:module');
const { Drawer } = createRequire(import.meta.url)('vaul') as typeof import('vaul');
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await homes.reset(); resetSessionDraftRepositoryForTests(); });

type RenderFailure = Readonly<{ error: unknown; componentStack: string | null | undefined }>;
class CaptureRenderFailure extends React.Component<React.PropsWithChildren<{ onFailure: (failure: RenderFailure) => void }>, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    this.props.onFailure({ error, componentStack: info.componentStack });
  }
  render() { return this.state.failed ? null : this.props.children; }
}

it.each([390, 1440])('opens capabilities through the real /new route and recovers a failed preview at %s without nested updates', async width => {
  viewport.dimensions = { ...viewport.dimensions, width };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport.dimensions.height });
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Draft Home', serverUrl: 'https://draft-capabilities.test', accountId: 'owner' });
  homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
  const credentials = await TokenStorage.getCredentialsForServerUrl('https://draft-capabilities.test', { serverId });
  if (!credentials) throw new Error('Expected the Home boundary to save credentials');
  await restoreConnectionToActiveServer(credentials);
  const scope = { serverId, accountId: 'owner' };
  storage.getState().applyProfileForScope(scope, { ...profileDefaults, id: 'owner' });
  storage.getState().applySettingsLocal({ useEnhancedSessionWizard: false, useProfiles: false });
  storage.getState().applyMachines([createMachineFixture({ id: 'machine', active: true, activeAt: Date.now() })], true, { sourceServerId: serverId });
  await clearBrowserRecords();
  await prepareSessionDraftPersistenceStorage();
  sync.reconfigureSessionDraftRepositoryForAccountMode(credentials, 'plain');
  await ensureSessionDraftRepositoryHydrated(scope);
  const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'linear', name: 'linear', title: 'Linear',
    transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
    remote: { url: 'https://mcp.linear.test/mcp', headers: {}, auth: { kind: 'oauth' } },
    toolsSnapshot: { checkedAt: 1, machineId: 'machine', tools: [{ name: 'search', tokens: 1400 }] } }],
    bindings: [{ id: 'linear-on', serverId: 'linear', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] });
  applyMcpServerCatalogSnapshot(scope, { status: 'ready', revision: 1, catalog, authority: 'active', diagnostics: [] }, true);
  const resolved = resolveSessionCapabilitiesV1({ context: { machineId: 'machine', machinePlatform: 'posix',
    directory: '/repo', agentId: 'claude', projectKey: null }, mcp: { ...catalog, strictMode: false }, skills: null,
    selection: {}, agentAcceptsUserMcp: true });
  transport.mockReset();
  const preview = SpawnCapabilitiesPreviewOutputV1Schema.parse({ ok: true, machinePlatform: 'posix',
    mcp: { strictMode: resolved.mcp.strictMode, items: resolved.mcp.items.map(({ effectiveConfig: _config, ...item }) => item), detected: [] },
    skills: { items: [], plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] } },
    applyTiming: { mcp: { t: 'session_not_running' }, skills: { t: 'session_not_running' } } });
  let previewFails = true;
  transport.mockImplementation(async input => {
    if (input.method === RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW && previewFails) throw new Error('Preview failed');
    return preview;
  });
  const container = document.createElement('div');
  document.body.append(container);
  const errors: RenderFailure[] = [];
  const recordFailure = (failure: RenderFailure) => {
    errors.push(failure);
    console.error('Real /new render failure', failure.error, failure.componentStack);
  };
  const root = createRoot(container, { onUncaughtError: (error, info) => recordFailure({ error, componentStack: info.componentStack }) });
  const renderRoute = () => <CaptureRenderFailure onFailure={recordFailure}>
    <Drawer.Root open shouldScaleBackground autoFocus><Drawer.Portal container={document.body}>
      <Drawer.Overlay /><Drawer.Content>
      <Drawer.Title>New session</Drawer.Title><Drawer.Description>Configure a session</Drawer.Description>
      <AuthProvider initialCredentials={credentials}><NewSessionRoute /></AuthProvider>
    </Drawer.Content></Drawer.Portal></Drawer.Root>
  </CaptureRenderFailure>;
  try {
    await act(async () => root.render(renderRoute()));
    expect(errors).toEqual([]);
    expect(document.querySelector('[data-testid="new-session-composer-input"]')).not.toBeNull();
    const opener = document.querySelector<HTMLElement>('[data-testid="session-capabilities-chip"]');
    expect(opener).not.toBeNull();
    await act(async () => { opener!.focus(); opener!.click(); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(errors).toEqual([]);
      expect(document.querySelector('[data-testid="session-capabilities:error"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="session-capabilities:resolving"]')).toBeNull();
    });
    previewFails = false;
    const retry = document.querySelector<HTMLElement>('[data-testid="session-capabilities:error-action"]');
    expect(retry).not.toBeNull();
    await act(async () => { retry!.click(); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(errors).toEqual([]);
      expect(document.querySelector('[data-testid="session-capabilities"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="session-capabilities"]')?.textContent).toContain('Linear');
      expect(document.querySelector('[data-testid="session-capabilities:error"]')).toBeNull();
      expect(document.querySelector('[data-testid="session-capabilities:resolving"]')).toBeNull();
      expect(transport).toHaveBeenCalled();
    });
    // Equal platform measurement publications must settle while the detail read completes.
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(errors).toEqual([]);
    expect(document.querySelector('[data-testid="session-capabilities"]')).not.toBeNull();
    const composer = document.querySelector('[data-testid="new-session-composer-input"]');
    await act(async () => root.render(renderRoute()));
    expect(document.querySelector('[data-testid="new-session-composer-input"]')).toBe(composer);
    expect(document.querySelector('[data-testid="session-capabilities"]')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector('[data-testid="session-capabilities"]')).toBeNull();
    });
    expect(document.querySelector('[data-testid="new-session-composer-input"]')).toBe(composer);
    await act(async () => { opener!.focus(); opener!.click(); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector('[data-testid="session-capabilities"]')?.textContent).toContain('Linear');
      expect(errors).toEqual([]);
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
