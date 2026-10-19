import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createProviderModelProjectionGroupFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

// The Provider projection and the experimental-confirmation owners are replaced by controllable
// stores so the one thing under test is visible: the dialog opened from `open` keeps following what
// they publish, in the real modal host and the real picker.
const owners = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    projection: { data: null as unknown, status: 'pending', loading: true, error: null, refresh: async () => {}, refreshFailures: [] as unknown[] },
    confirm: { confirm: async () => false, pending: false, pendingModelName: null as string | null, pendingApproval: null as unknown, error: null, retry: null, clear: () => {} },
  };
  return { state, listeners, set(patch: Partial<typeof state>) { Object.assign(state, patch); for (const l of listeners) l(); } };
});
const useStore = <T,>(read: () => T): T => React.useSyncExternalStore((l) => { owners.listeners.add(l); return () => { owners.listeners.delete(l); }; }, read, read);
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/providers/hooks/useProviderSettings', () => ({ useProviderSettingsForServer: () => ({ modelVisibilityByRef: {} }) }));
vi.mock('@/providers/hooks/useProviderModelProjection', () => ({ useProviderModelProjection: () => useStore(() => owners.state.projection) }));
vi.mock('@/providers/hooks/useConfirmExperimentalProviderModel', () => ({ useConfirmExperimentalProviderModel: () => useStore(() => owners.state.confirm) }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const navigation = createExpoRouterMock();
vi.doMock('expo-router', () => navigation.module);

const { useExactModelChoice } = await import('./useExactModelChoice');
const { ModalProvider, Modal } = await import('@/modal');

const agentTargetKey = 'agent:happier.agent.codex/codex';
const ref = { agentTargetKey, providerConnectionId: 'pc_x', modelId: 'v4-flash' } as const;
const optionTestId = `model-picker-overlay-option:${JSON.stringify([agentTargetKey, ref.providerConnectionId, ref.modelId])}`;
const group = createProviderModelProjectionGroupFixture({ connectionId: 'pc_x', connectionRevision: 3, providerName: 'DeepSeek', connectionName: 'DeepSeek', rows: [{
  ref, descriptor: { id: ref.modelId, name: 'V4 Flash' }, confidence: 'account_unverified', loadState: 'unknown', visibility: 'visible',
  sources: { manual: true, static: false, probe: false }, endpointHealth: 'not_checked', catalog: { stale: false },
  compatibility: { compatibilityFingerprint: 'compatibility:v1:x', confirmed: false, result: { status: 'experimental' as const, selectedProtocol: 'openai-responses' as const,
    reasons: ['compatibility_evidence_missing' as const], confirmationScope: { kind: 'model' as const, modelId: ref.modelId } } },
}] });

let open: ((onSelect: (selection: unknown) => void) => void) | null = null;
function Host() {
  open = useExactModelChoice({ agentTargetKey, agentId: null, machineId: 'm', serverId: 's', selected: null, title: 'Model', fallbackLabel: 'Choose' }).open as typeof open;
  return null;
}

describe('exact model dialog follows its owners (controlled)', () => {
  it('shows rows of a projection that settles after the dialog opened, and the approval it waits on, in the same dialog', async () => {
    const screen = await renderScreen(<ModalProvider><Host /></ModalProvider>);
    await act(async () => { open!(vi.fn()); });
    expect(screen.findByTestId(optionTestId)).toBeNull();
    await act(async () => { owners.set({ projection: { ...owners.state.projection, data: { status: 'success', groups: [group], currentSelectionRecovery: null }, status: 'success', loading: false } }); });
    expect(screen.findByTestId(optionTestId)).not.toBeNull();
    expect(vi.mocked(Modal.show)).toHaveBeenCalledTimes(1);
    await act(async () => { owners.set({ confirm: { ...owners.state.confirm, pending: true, pendingModelName: 'V4 Flash', pendingApproval: { artifactId: 'a1', href: '/inbox/approvals/a1' } } }); });
    expect(screen.findByTestId('model-picker-experimental-approval')).not.toBeNull();
  });
});
