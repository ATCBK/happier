import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// The daemon transport is the boundary; mounted Action admission, status and editors stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(boundary.rpc));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
const { Modal } = await import('@/modal');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { McpServerDetailPage } = await import('./McpServerDetailPage');
const { ValueRefEditorModal } = await import('@/components/ui/forms/valueRefs/ValueRefEditorModal');
const { McpServerWhereAndTools } = await import('./McpServerDetailBody');
const { McpSignInSection } = await import('../signIn/McpSignInSection');
const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');

const base = McpServerCatalogEntryV1Schema.parse({ id: 'linear', name: 'linear', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
  remote: { url: 'https://mcp.linear.app/mcp', headers: {} } });
const unavailable = { resolveReference: (ref: string) => resolveSavedSecretReference(null, [], ref) };
let catalogServer = base;
let disposeActionLoader: (() => void) | undefined;

async function page(server = base) {
  catalogServer = server;
  let draft = server;
  const commit = vi.fn();
  const tree = await renderScreen(<McpServerDetailPage server={server} draftServer={draft} catalogRevision={null} secrets={[]} secretAvailability={unavailable}
    scope={getStorage().getState().settingsScope} configurationSaveState="idle" onCommitConfiguration={commit} onRemove={() => {}} onDuplicate={() => {}} approvalNotice={null}
    onChangeServer={updater => { draft = updater(draft); }} />);
  return { tree, commit, draft: () => draft };
}
beforeEach(async () => {
  await harness.reset();
  const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
  resetScopedHomeActionExecutorsForTests();
  disposeActionLoader = await installRealActionExecutorModuleLoader();
  boundary.rpc.mockReset();
  vi.mocked(Modal.show).mockClear();
  const serverId = await harness.addHome({ name: 'MCP recovery', serverUrl: 'https://mcp-detail-recovery.test',
    serverIdentityId: 'srv_mcp_detail_recovery', accountId: 'owner', currentAccount: true });
  const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
  const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
  const machine = createMachineFixture({ id: 'mcp-machine', activeAt: Date.now() });
  const state = getStorage().getState();
  getStorage().setState({ settingsScope: scope, profileScope: scope, isDataReady: true,
    settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: {
      'mcp.servers.signIn.start': ['ui'],
    } }) } });
  getStorage().getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  observeMachinePresenceForTest(scope, [machine.id]);
  expect(getStorage().getState().machineDisplayById[machine.id]?.id).toBe(machine.id);
  harness.answer(serverId, '/v1/account/entity-rows/mcp', { select: () => ({ body: {
    status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, servers: [catalogServer], bindings: [] } },
  } }) });
});
afterEach(async () => { await standardCleanup(); disposeActionLoader?.(); disposeActionLoader = undefined; });

describe('saved MCP detail recovery wiring', () => {
  it('offers an inline own-app form with a masked optional secret and submits through sign-in', async () => {
    const start = vi.fn(async () => {});
    const clientSecret = crypto.randomUUID();
    const tree = await renderScreen(<McpSignInSection name="Docs" signIn={{ view: { state: 'client_refused' },
      start, busy: false, cancel: async () => {}, complete: async () => false, signOut: async () => false }} />);
    await tree.pressByTestIdAsync('mcp.server.signin:own-app');
    const clientId = tree.findAllByType(FieldTextInput).find(field => field.props.testID === 'mcp.server.signin:client-id');
    const secret = tree.findAllByType(FieldTextInput).find(field => field.props.testID === 'mcp.server.signin:client-secret');
    expect(secret?.props.secureTextEntry).toBe(true);
    await act(async () => { clientId?.props.onChangeText('person-app'); secret?.props.onChangeText(clientSecret); });
    await tree.pressByTestIdAsync('mcp.server.signin:own-app-sign-in');
    expect(start.mock.calls.length).toBe(1);
    expect(JSON.stringify(start.mock.calls[0]) === JSON.stringify([{ client: { clientId: 'person-app', clientSecret } }])).toBe(true);
    await tree.update(<McpSignInSection name="Docs" signIn={{ view: { state: 'connected', identity: null, scopes: [], lastUsedAt: null },
      start, busy: false, cancel: async () => {}, complete: async () => false, signOut: async () => false }} />);
    expect(tree.findAllByTestId('mcp.server.signin:own-app-form')).toHaveLength(0);
    expect(tree.findAllByTestId('mcp.server.signin:connected')).not.toHaveLength(0);
  });
  it('the real missing-key banner opens the ValueRef editor and saves the repaired reference', async () => {
    const server = McpServerCatalogEntryV1Schema.parse({ ...base, env: { TOKEN: { t: 'savedSecret', secretId: 'missing' } } });
    const current = await page(server);
    await current.tree.pressByTestIdAsync('mcp.server.banner.action');
    expect(Modal.show).toHaveBeenCalled();
    const opened = vi.mocked(Modal.show).mock.calls.at(-1)![0];
    expect(opened.component).toBe(ValueRefEditorModal);
    const props = opened.props as React.ComponentProps<typeof ValueRefEditorModal>;
    expect(props.initialKey).toBe('TOKEN');
    expect(props.onSubmit({ key: 'TOKEN', valueRef: { t: 'savedSecret', secretId: 'replacement' } })).toBe(true);
    expect(current.draft().env.TOKEN).toEqual({ t: 'savedSecret', secretId: 'replacement' });
    expect(current.commit).toHaveBeenCalled();
  });

  it('client refusal keeps the API-key alternative and saves through the existing header editor', async () => {
    const current = await page(McpServerCatalogEntryV1Schema.parse({ ...base, remote: { ...base.remote, auth: { kind: 'oauth' } } }));
    boundary.rpc.mockRejectedValue(Object.assign(new Error('client_refused'), { code: 'client_refused' }));
    await waitForHomeGovernance(() => {
      const detail = current.tree.findByType(McpServerWhereAndTools).props.detail;
      expect(detail.execution.ready).toBe(true);
      expect(detail.signIn.view).toMatchObject({ state: 'not_connected' });
    });
    await current.tree.pressByTestIdAsync('mcp.server.signin:not-connected:action');
    await waitForHomeGovernance(() => expect(current.tree.findByTestId('mcp.server.signin:client-refused:action')).not.toBeNull());
    await current.tree.pressByTestIdAsync('mcp.server.signin:client-refused:action');
    expect(Modal.show).toHaveBeenCalled();
    const opened = vi.mocked(Modal.show).mock.calls.at(-1)![0];
    expect(opened.component).toBe(ValueRefEditorModal);
    const props = opened.props as React.ComponentProps<typeof ValueRefEditorModal>;
    expect(props.kind).toBe('header');
    expect(props.onSubmit({ key: 'Authorization', valueRef: { t: 'savedSecret', secretId: 'api-key' } })).toBe(true);
    expect(current.draft().remote).toEqual({ url: base.remote!.url, headers: { Authorization: { t: 'template', template: 'Bearer {api_key}', vars: { api_key: { t: 'savedSecret', secretId: 'api-key' } } } } });
    expect(current.commit).toHaveBeenCalled();
  });
});
