import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const network = await installSessionOpsNetworkBoundary();
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { storage } = await import('@/sync/domains/state/storage');
const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { ensureSessionRuntimeForPendingInput, resumeSession } = await import('./sessions');

describe('session resume terminal settings', () => {
    const originalState = storage.getState();
    let serverId: string;
    beforeEach(async () => {
        network.resetRequests();
        network.respond(RPC_METHODS.SPAWN_HAPPY_SESSION, { type: 'success', sessionId: 'session-1' });
        network.respond(RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, { type: 'success', sessionId: 'session-1' });
        serverId = (await network.addHome('https://terminal-settings.example.test', 'terminal-account')).id;
        const machine = createMachineFixture();
        storage.setState({
            sessions: { 'session-1': createSessionFixture({ serverId }) },
            machines: { 'machine-1': machine },
            machineListByServerId: { [serverId]: [machine] },
            settings: { ...settingsDefaults, sessionUseTmux: true, sessionTmuxSessionName: '', sessionTmuxIsolated: true },
        });
    });
    afterAll(async () => { await network.dispose(); });
    afterEach(async () => {
        await serverScopedRpcSocketPool.stopAll();
        storage.getState().clearSessionResuming('session-1');
        storage.setState(originalState);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    const options = {
        sessionId: 'session-1',
        machineId: 'requested-machine',
        directory: '/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        accountSettingsVersionHint: 0,
    } as const;

    it.each([
        ['explicit resume', resumeSession],
        ['pending input', ensureSessionRuntimeForPendingInput],
    ] as const)('honors account tmux settings for %s', async (_label, resume) => {
        expect(await resume({ ...options, serverId })).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(network.requests).toContainEqual(expect.objectContaining({
            targetId: 'machine-1',
            method: RPC_METHODS.SPAWN_HAPPY_SESSION,
            payload: expect.objectContaining({
                type: 'resume-session',
                terminal: { mode: 'tmux', tmux: { sessionName: '', isolated: true, tmpDir: null } },
            }),
        }));
    });

    it('uses the resolved machine override instead of the stale requested machine', async () => {
        storage.setState({ settings: {
            ...storage.getState().settings,
            sessionTmuxByMachineId: {
                'machine-1': { useTmux: true, sessionName: ' work ', isolated: false, tmpDir: ' /tmp/work ' },
                'requested-machine': { useTmux: false, sessionName: '', isolated: true, tmpDir: null },
            },
        } });
        expect(await resumeSession({ ...options, serverId })).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(network.requests[0]?.payload).toMatchObject({ terminal: {
            mode: 'tmux', tmux: { sessionName: 'work', isolated: false, tmpDir: '/tmp/work' },
        } });
    });

    it('omits terminal when the resolved machine disables tmux', async () => {
        storage.setState({ settings: {
            ...storage.getState().settings,
            sessionTmuxByMachineId: {
                'machine-1': { useTmux: false, sessionName: '', isolated: true, tmpDir: null },
            },
        } });
        expect(await resumeSession({ ...options, serverId })).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(network.requests[0]?.payload).not.toHaveProperty('terminal');
    });

    it('uses the exact Account settings when another Account is focused', async () => {
        const { captureLazyActionAccountContext } = await import('./actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const scope = account.accountLifetime.scope;
        saveAccountSettings(scope, { ...settingsDefaults, sessionUseTmux: true, sessionTmuxSessionName: 'scoped-account' }, 1);
        storage.setState({
            settingsScope: { serverId, accountId: 'focused-account' },
            settings: { ...settingsDefaults, sessionUseTmux: true, sessionTmuxSessionName: 'focused-account' },
        });
        try {
            expect(await ensureSessionRuntimeForPendingInput({
                ...options, serverId, machineId: 'machine-1', accountLifetime: account.accountLifetime,
            })).toEqual({ type: 'success', sessionId: 'session-1' });
            expect(network.requests[0]?.payload).toMatchObject({ terminal: {
                mode: 'tmux', tmux: { sessionName: 'scoped-account', isolated: true, tmpDir: null },
            } });
            expect(storage.getState().sessions['session-1']?.resumingAt ?? null).toBeNull();
        } finally { account.dispose(); }
    });
});
