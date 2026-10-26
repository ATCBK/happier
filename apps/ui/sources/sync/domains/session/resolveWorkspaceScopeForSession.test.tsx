import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';

import { useWorkspaceScopeForSession } from './resolveWorkspaceScopeForSession';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
    getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://example.com', generation: 1 }),
}));

afterEach(() => {
    standardCleanup();
});

function buildSession(overrides?: Partial<Session>): Session {
    return {
        id: 'session-1',
        serverId: 'server-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: {
            host: 'localhost',
            machineId: 'machine-1',
            path: '/Users/alice/repo',
            homeDir: '/Users/alice',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('useWorkspaceScopeForSession', () => {
    it('resolves an explicitly scoped file preview from that Home\'s machines', async () => {
        const previousState = storage.getState();
        try {
            storage.setState({
                sessions: { 'session-1': buildSession({ serverId: 'background-home' }) },
                machines: {}, sessionListRowsByServerId: {},
                machineListByServerId: { 'background-home': [createMachineFixture({ id: 'machine-1', active: true })] },
                getProjectForSession: () => null,
            });
            const hook = await renderHook(() => useWorkspaceScopeForSession('session-1', 'background-home'));
            expect(hook.getCurrent()).toMatchObject({ serverId: 'background-home', machineId: 'machine-1', rootPath: '/Users/alice/repo' });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps workspace scope stable during unrelated session hot-path updates', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessions: { 'session-1': buildSession() },
                machines: {
                    'machine-1': {
                        id: 'machine-1',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: true,
                        activeAt: 1,
                        metadata: {
                            host: 'localhost',
                            platform: 'darwin',
                            happyCliVersion: '1',
                            happyHomeDir: '.happy',
                            homeDir: '/Users/alice',
                        },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                },
                sessionListRowsByServerId: {},
                ordinarySessionListMembershipByServerId: {},
                sessionListIndexByServerId: {},
                getProjectForSession: () => null,
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useWorkspaceScopeForSession('session-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            const initialScope = hook.getCurrent();
            expect(initialScope).toMatchObject({
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/Users/alice/repo',
            });

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        'session-1': {
                            ...state.sessions['session-1'],
                            thinking: true,
                            thinkingAt: 2,
                        } as Session,
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(initialScope);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
