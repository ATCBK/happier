import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { useSessionWorkspaceTarget } from './useSessionWorkspaceTarget';

function hydrateHomeSession(serverId: string): void {
    const session = createSessionFixture({
        id: 's1', serverId,
        metadata: { machineId: 'machine-1', path: '/repo', host: 'machine.local', homeDir: '/Users/tester' },
    });
    const machine = createMachineFixture({
        id: 'machine-1', active: true,
        metadata: { host: 'machine.local', platform: 'darwin', happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happy-dev', homeDir: '/Users/tester' },
    });
    storage.setState({
        sessions: { s1: session },
        machines: { 'machine-1': machine },
        // Selection can change before hydration; keep each Home's Machine facts
        // available without attributing the old Session to the new Home.
        machineListByServerId: { 'server-a': [machine], 'server-b': [machine] },
        sessionListRowsByServerId: {}, sessionListIndexByServerId: {},
        ordinarySessionListMembershipByServerId: {}, concurrentSessionListCacheByServerId: {},
    });
}

describe('useSessionWorkspaceTarget', () => {
    let previousState: ReturnType<typeof storage.getState>;

    beforeEach(async () => {
        previousState = storage.getState();
        for (const serverId of ['server-a', 'server-b']) {
            await upsertServerProfile({ serverUrl: `https://${serverId}`, name: serverId });
        }
        await setActiveServerId('server-a');
        hydrateHomeSession('server-a');
    });

    afterEach(() => {
        standardCleanup();
        storage.setState(previousState, true);
    });

    it('keeps the qualified Home until the newly active Home hydrates its Session', async () => {
        const hook = await renderHook(() => useSessionWorkspaceTarget('  s1  '));

        const homeATarget = {
            workspaceCacheKey: 'server-a:machine-1:/repo',
            machineId: 'machine-1',
            rootPath: '/repo',
            serverId: 'server-a',
        };
        expect(hook.getCurrent()).toEqual(homeATarget);

        await act(async () => {
            await setActiveServerId('server-b');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(hook.getCurrent()).toEqual(homeATarget);

        await act(async () => { hydrateHomeSession('server-b'); });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(hook.getCurrent()).toEqual({
            workspaceCacheKey: 'server-b:machine-1:/repo',
            machineId: 'machine-1',
            rootPath: '/repo',
            serverId: 'server-b',
        });

        await hook.unmount();
    });

    it('keeps mounted workspace readers quiet for unrelated Machine and Session changes', async () => {
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useSessionWorkspaceTarget('s1');
        });
        const target = hook.getCurrent();
        expect(target?.rootPath).toBe('/repo');
        const before = renders;
        for (let index = 0; index < 5; index++) {
            await act(async () => {
                storage.setState(state => ({
                    machines: { ...state.machines, other: createMachineFixture({ id: 'other', activeAt: index }) },
                    sessions: { ...state.sessions, other: createSessionFixture({ id: 'other', seq: index }) },
                }));
            });
        }
        expect({ renders: renders - before, stableTarget: hook.getCurrent() === target }).toEqual({
            renders: 0, stableTarget: true,
        });

        await act(async () => {
            storage.setState(state => ({ sessions: { ...state.sessions, s1: createSessionFixture({
                ...state.sessions.s1,
                metadata: { ...state.sessions.s1.metadata!, path: '/changed' },
            }) } }));
        });
        expect(hook.getCurrent()?.rootPath).toBe('/changed');
        expect(renders).toBeGreaterThan(before);
        await hook.unmount();
    });
});
