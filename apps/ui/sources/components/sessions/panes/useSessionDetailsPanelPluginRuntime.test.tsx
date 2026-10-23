import { describe, expect, it } from 'vitest';

import { act, renderHook } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { useSessionDetailsPanelPluginRuntime } from './useSessionDetailsPanelPluginRuntime';

installSessionDetailsPanelCommonModuleMocks();

describe('useSessionDetailsPanelPluginRuntime', () => {
    it('keeps mounted details quiet when unrelated Profile fields change and observes a new Account id', async () => {
        const previous = storage.getState();
        storage.setState({ profile: { ...previous.profile, id: 'details-account' } });
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useSessionDetailsPanelPluginRuntime({
                sessionId: 'details-session', routeServerId: 'details-home', pluginUiProjection: null,
                paneSurfaceScope: {
                    targetKind: 'session', sessionId: 'details-session', serverId: 'details-home', machineId: 'details-machine',
                    pluginUiProjection: null, pluginBrowserProjection: null, projectionPhase: 'unavailable',
                    interactionEnabled: false, platform: 'web',
                },
            });
        });
        try {
            expect(hook.getCurrent().peerMediationObservabilityScope).toEqual({
                kind: 'machine', accountId: 'details-account', machineId: 'details-machine',
            });
            const before = renders;
            for (let tick = 0; tick < 5; tick++) {
                await act(async () => storage.setState(state => ({ profile: { ...state.profile, timestamp: tick + 1 } })));
            }
            expect(renders - before).toBe(0);
            await act(async () => storage.setState(state => ({ profile: { ...state.profile, id: 'replacement-account' } })));
            expect(hook.getCurrent().peerMediationObservabilityScope).toMatchObject({ kind: 'machine', accountId: 'replacement-account' });
        } finally {
            await hook.unmount();
            storage.setState(previous, true);
        }
    });

    it('qualifies direct details with its route Home instead of the locally visible Session Home', async () => {
        const sessions = storage.getState().sessions;
        storage.setState({ sessions: {
            ...sessions,
            'same-session': createSessionFixture({ id: 'same-session', serverId: 'visible-home', metadata: null }),
        } });
        try {
            const hook = await renderHook(() => useSessionDetailsPanelPluginRuntime({
                sessionId: 'same-session',
                routeServerId: 'destination-home',
                pluginUiProjection: null,
            }));
            expect(hook.getCurrent().serverId).toBe('destination-home');
            expect(hook.getCurrent().machineId).toBeNull();
            await hook.unmount();
        } finally {
            storage.setState({ sessions });
        }
    });
});
