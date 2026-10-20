import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { createProviderModelProjectionFixture, createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const transport = vi.hoisted(() => ({ call: vi.fn<(request: { method: string; payload: unknown }) => Promise<unknown>>() }));
// The real inventory Action, discovery/cache, projection and picker run below this machine RPC boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: (request: { method: string; payload: unknown }) => transport.call(request),
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const account = createProviderSettingsAccountHarness();
const { useExactModelChoice } = await import('./useExactModelChoice');
const { ModalProvider, Modal } = await import('@/modal');
await loadSyncSingletonForTests();

let serverId = '';
let enabled = false;
let open: ReturnType<typeof useExactModelChoice>['open'];
let choice: ReturnType<typeof useExactModelChoice>;
const agentTargetKey = 'agent:happier.agent.codex/codex';
const nativeRef = { agentTargetKey, providerConnectionId: null, modelId: 'machine-native-model' } as const;
const nativeOptionId = `model-picker-overlay-option:${JSON.stringify([agentTargetKey, null, nativeRef.modelId])}`;
function Host() {
  choice = useExactModelChoice({ agentTargetKey, agentId: 'codex', machineId: 'machine-a', serverId,
    selected: null, title: 'Model', fallbackLabel: 'Choose', enabled });
  open = choice.open;
  return null;
}

beforeEach(async () => {
  enabled = false;
  transport.call.mockReset();
  transport.call.mockImplementation(async ({ method }) => {
    if (method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION) return createProviderModelProjectionFixture({ agentTargetKey, groups: [] });
    if (method === RPC_METHODS.CAPABILITIES_INVOKE) return { ok: true, result: {
      availableModels: [{ id: nativeRef.modelId, name: 'Machine native model' }], supportsFreeform: false,
      source: 'dynamic', observedAt: Date.now(),
    } };
    return { errorCode: 'method_not_found', error: 'Method not found' };
  });
  serverId = (await account.restore({ waivedActions: ['providers.models.refresh'],
    settings: { experiments: true, featureToggles: { providers: true } } })).serverId;
});
afterEach(async () => { await act(async () => { Modal.hideAll(); }); await standardCleanup(); await account.reset(); });

describe('exact model choice uses machine catalogs and preserves failures', () => {
  it('loads the machine native catalog only on demand and commits its exact native choice', async () => {
    const screen = await renderScreen(<ModalProvider><Host /></ModalProvider>);
    const retainedOpen = open;
    expect(transport.call.mock.calls.some(([request]) => request.method === RPC_METHODS.CAPABILITIES_INVOKE)).toBe(false);
    enabled = true;
    await act(async () => { screen.update(<ModalProvider><Host /></ModalProvider>); });
    const selected = vi.fn();
    await act(async () => { open(selected); });
    await flushHookEffects();
    expect(screen.findByTestId(nativeOptionId)).not.toBeNull();
    await screen.pressByTestIdAsync(nativeOptionId);
    expect(selected).toHaveBeenCalledWith(nativeRef);
    // Route popovers can retain their opener while discovery settles elsewhere.
    await act(async () => { retainedOpen(vi.fn()); });
    expect(screen.findByTestId(nativeOptionId)).not.toBeNull();
  });

  it('keeps a typed projection failure and retry visible in the opened picker', async () => {
    enabled = true;
    transport.call.mockImplementation(async ({ method }) => method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION
      ? { status: 'error', error: createProviderErrorV1('provider_endpoint_unavailable') }
      : { errorCode: 'method_not_found', error: 'Method not found' });
    const screen = await renderScreen(<ModalProvider><Host /></ModalProvider>);
    await waitForHomeGovernance(() => expect(choice.error?.code).toBe('provider_endpoint_unavailable'));
    await act(async () => { open(vi.fn()); });
    expect(screen.findByTestId('provider-error:provider_endpoint_unavailable')).not.toBeNull();
    expect(screen.findByTestId('model-picker-overlay-refresh')).not.toBeNull();
    transport.call.mockImplementation(async ({ method }) => method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION
      ? createProviderModelProjectionFixture({ agentTargetKey, groups: [] })
      : { errorCode: 'method_not_found', error: 'Method not found' });
    await screen.pressByTestIdAsync('model-picker-overlay-refresh');
    await flushHookEffects();
    expect(screen.findByTestId('provider-error:provider_endpoint_unavailable')).toBeNull();
  });
});
