import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_PEER_MEDIATION_PREFERENCES_V1,
    PeerMediationFlowKindV1Schema,
    type FeatureDecision,
    type PeerMediationPreferencesV1,
} from '@happier-dev/protocol';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

const state = vi.hoisted(() => ({
    preferences: null as PeerMediationPreferencesV1 | null,
    written: [] as unknown[],
    /** Server feature decisions by feature id; absent means still loading. */
    decisions: {} as Record<string, 'enabled' | 'disabled'>,
}));

// Settings storage and server feature snapshots are the two boundaries this row stands on.
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSettingMutable: ((key: string) => {
                if (key === 'peerMediationPreferencesV1') {
                    return [state.preferences, (value: unknown) => { state.written.push(value); }];
                }
                return [null, vi.fn()];
            }) as never,
        },
    });
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string): FeatureDecision | null => {
        const decided = state.decisions[featureId];
        return decided ? ({ featureId, state: decided } as unknown as FeatureDecision) : null;
    },
}));

import { AccountDirectConnectionsSection } from './DirectConnectionSettings';

const DIRECT_FEATURES = [
    'machines.rpc.directPeer',
    'machines.transfer.directPeer',
    'machines.tunnel.directPeer',
    'machines.liveStream.directPeer',
];

function allowServer(stateValue: 'enabled' | 'disabled') {
    state.decisions = Object.fromEntries(DIRECT_FEATURES.map((id) => [id, stateValue]));
}

afterEach(() => {
    standardCleanup();
    state.preferences = DEFAULT_PEER_MEDIATION_PREFERENCES_V1;
    state.written = [];
    state.decisions = {};
});

function lastWrite(): PeerMediationPreferencesV1 {
    const value = state.written.at(-1);
    if (!value) throw new Error('nothing was written');
    return value as PeerMediationPreferencesV1;
}

describe('Account › Connections', () => {
    it('turns direct connections off for every flow when the switch is turned off', async () => {
        state.preferences = DEFAULT_PEER_MEDIATION_PREFERENCES_V1;
        allowServer('enabled');
        const screen = await renderSettingsView(<AccountDirectConnectionsSection />);

        const toggle = screen.findByTestId('settings-account-direct-connections-switch');
        expect(toggle?.props.value).toBe(true);
        await act(async () => { toggle?.props.onValueChange(false); });

        const written = lastWrite();
        for (const flow of PeerMediationFlowKindV1Schema.options) {
            expect(written.flows[flow]?.direct).toBe('disabled');
        }
    });

    it('says the server decides, and offers no switch that would do nothing, when the server allows no direct route', async () => {
        state.preferences = DEFAULT_PEER_MEDIATION_PREFERENCES_V1;
        allowServer('disabled');
        const screen = await renderSettingsView(<AccountDirectConnectionsSection />);

        expect(screen.getTextContent()).toContain(t('settingsConnections.serverDenied'));
        const toggle = screen.findByTestId('settings-account-direct-connections-switch');
        expect(toggle?.props.disabled).toBe(true);
    });

    it('does not claim the server forbids it while the server has not answered yet', async () => {
        state.preferences = DEFAULT_PEER_MEDIATION_PREFERENCES_V1;
        const screen = await renderSettingsView(<AccountDirectConnectionsSection />);

        expect(screen.getTextContent()).not.toContain(t('settingsConnections.serverDenied'));
    });
});
