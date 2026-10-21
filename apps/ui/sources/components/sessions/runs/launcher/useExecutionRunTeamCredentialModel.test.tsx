import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

// The Team catalog and the confirmation owner are replaced by controllable stores so the one thing
// under test is visible: the Run's Team-model picker shows what the confirmation owner publishes
// (Ask-first approval wait, typed refusal and Retry), exactly as the ordinary exact-model picker does.
const owners = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = {
        confirm: { confirm: async () => false, pending: false, pendingModelName: null as string | null,
            pendingApproval: null as unknown, error: null as unknown, retry: null as unknown, clear: () => {} },
    };
    return { state, listeners, set(patch: Partial<typeof state>) { Object.assign(state, patch); for (const l of listeners) l(); } };
});
const useStore = <T,>(read: () => T): T => React.useSyncExternalStore((l) => { owners.listeners.add(l); return () => { owners.listeners.delete(l); }; }, read, read);
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/hooks/teams/useHomeTeamCredentialModelCatalog', () => ({
    useHomeTeamCredentialModelCatalog: () => ({ resources: [], teamNameById: {}, homeNameByTeamId: {},
        currentResourceKeys: new Set<string>(), current: true, condition: null, reload: async () => {} }),
}));
vi.mock('@/providers/hooks/useConfirmExperimentalProviderModel', () => ({ useConfirmExperimentalProviderModel: () => useStore(() => owners.state.confirm) }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const navigation = createExpoRouterMock();
vi.doMock('expo-router', () => navigation.module);

const { useExecutionRunTeamCredentialModel } = await import('./useExecutionRunTeamCredentialModel');

const agentTargetKey = 'agent:happier.agent.codex/codex';
const selection = { kind: 'team_credential_provider_model', resourceId: 'resource-a', teamId: 'team-a',
    expectedResourceRevision: 7, agentTargetKey, modelId: 'gpt-5.5', deliveryMode: 'brokered' } as const;

function Host() {
    const model = useExecutionRunTeamCredentialModel({
        sessionId: null, serverId: 's', machineId: 'm', hasBackendChoices: true,
        selectedBackendChoice: { backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } as never,
        actionInput: { teamCredentialModel: selection }, setActionInput: vi.fn(),
    });
    return <>{model.picker}</>;
}

describe('Run Team-model picker confirmation', () => {
    it('shows the approval a Team model waits on, its model name and a typed refusal with Retry', async () => {
        const screen = await renderScreen(<Host />);
        expect(screen.findByTestId('model-picker-experimental-approval')).toBeNull();
        await act(async () => { owners.set({ confirm: { ...owners.state.confirm, pending: true, pendingModelName: 'GPT 5.5',
            pendingApproval: { artifactId: 'a1', href: '/inbox/approvals/a1' } } }); });
        expect(screen.findByTestId('model-picker-experimental-approval')).not.toBeNull();
        expect(screen.findByTestId('model-picker-experimental-approval.subject')?.props.children).toBe('GPT 5.5');
        const retry = vi.fn(async () => true);
        await act(async () => { owners.set({ confirm: { ...owners.state.confirm, pending: false, pendingModelName: null,
            pendingApproval: null, error: createProviderErrorV1('provider_endpoint_unavailable'), retry } }); });
        expect(screen.findByTestId('model-picker-experimental-approval')).toBeNull();
        expect(screen.findByTestId('provider-error:provider_endpoint_unavailable')).not.toBeNull();
        await act(async () => { await screen.findByTestId('provider-error-action:provider_endpoint_unavailable')?.props.onPress?.(); });
        expect(retry).toHaveBeenCalledOnce();
    });
});
