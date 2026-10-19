import { describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook } from '@/dev/testkit';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { act } from 'react-test-renderer';

const capabilityBoundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(capabilityBoundary.rpc);
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The package owns Reanimated's native SDK fixture. Keep Sync and capability
// decisions real; these projection-only cases never request a machine refresh.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

type UseNewSessionMachineRefreshState = typeof import('./useNewSessionMachineRefreshState').useNewSessionMachineRefreshState;
type HookParams = Parameters<UseNewSessionMachineRefreshState>[0];

function makeMachine(input: Readonly<{
    id: string;
    metadata?: Partial<NonNullable<Machine['metadata']>>;
}>): Machine {
    const base = createMachineFixture({ id: input.id });
    return {
        ...base,
        metadata: {
            ...(base.metadata ?? {}),
            ...(input.metadata ?? {}),
        } as NonNullable<Machine['metadata']>,
    };
}

function createSession(input: Readonly<{
    id: string;
    machineId: string;
    path: string;
    updatedAt?: number;
}>): Session {
    return {
        id: input.id,
        seq: 1,
        createdAt: 1,
        updatedAt: input.updatedAt ?? 1,
        active: true,
        activeAt: 1,
        metadata: {
            machineId: input.machineId,
            path: input.path,
            homeDir: '/Users/test',
            host: 'host.local',
            flavor: 'claude',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

async function renderMachineRefreshState(initialProps: HookParams) {
    await import('@/sync/syncEngine');
    const { useNewSessionMachineRefreshState } = await import('./useNewSessionMachineRefreshState');
    return renderHook((props: HookParams) => useNewSessionMachineRefreshState(props), {
        initialProps,
    });
}

describe('useNewSessionMachineRefreshState', () => {
    it('cancels a manual refresh on target change and retries on the next target', async () => {
        let signal: AbortSignal | undefined;
        capabilityBoundary.rpc.mockImplementationOnce((args: { signal?: AbortSignal }) => {
            signal = args.signal;
            return new Promise(() => {});
        });
        const initialProps: HookParams = {
            capabilityServerId: 'refresh-cancel-home', selectedMachineId: 'refresh-old-machine',
            machines: [makeMachine({ id: 'refresh-old-machine' }), makeMachine({ id: 'refresh-next-machine' })],
            recentMachinePaths: [], favoriteMachines: [], useEnhancedSessionWizard: false,
            refreshMachineEnvPresence: () => {}, sessions: [],
        };
        const hook = await renderMachineRefreshState(initialProps);
        await act(async () => { hook.getCurrent().refreshMachineData(); });
        await vi.waitFor(() => expect(signal).toBeDefined());
        await hook.rerender({ ...initialProps, selectedMachineId: 'refresh-next-machine' });
        expect(signal?.aborted).toBe(true);
        const { getMachineCapabilitiesCacheState } = await import('@/hooks/server/useMachineCapabilitiesCache');
        expect(getMachineCapabilitiesCacheState('refresh-old-machine', initialProps.capabilityServerId, 0)?.status).toBe('idle');
        capabilityBoundary.rpc.mockResolvedValueOnce({ protocolVersion: 1, results: {
            'tool.tmux': { ok: true, checkedAt: 1, data: { available: true } },
        } });
        await act(async () => { hook.getCurrent().refreshMachineData(); });
        await vi.waitFor(() => expect(getMachineCapabilitiesCacheState('refresh-next-machine', initialProps.capabilityServerId, 0)?.status).toBe('loaded'));
        await hook.unmount();
    });

    it('keeps recent and favorite machine arrays stable when only heartbeat changes', async () => {
        const machine = makeMachine({ id: 'machine-1', metadata: { homeDir: '/Users/test' } });
        const initialProps: HookParams = {
            capabilityServerId: 'server-a',
            selectedMachineId: 'machine-1',
            machines: [{ ...machine, activeAt: 100 }],
            recentMachinePaths: [
                { machineId: 'machine-1', path: '/Users/test/Development/lantern' },
            ],
            favoriteMachines: ['machine-1'],
            useEnhancedSessionWizard: false,
            refreshMachineEnvPresence: vi.fn(),
            sessions: [],
        };

        const hook = await renderMachineRefreshState(initialProps);
        const firstRecentMachines = hook.getCurrent().recentMachines;
        const firstFavoriteMachineItems = hook.getCurrent().favoriteMachineItems;

        await hook.rerender({
            ...initialProps,
            machines: [{ ...machine, activeAt: 200 }],
        });

        expect(hook.getCurrent().recentMachines).toBe(firstRecentMachines);
        expect(hook.getCurrent().favoriteMachineItems).toBe(firstFavoriteMachineItems);

        await hook.unmount();
    });

    it('includes previous session paths in the selected machine path suggestions', async () => {
        const initialProps = {
            capabilityServerId: 'server-a',
            selectedMachineId: 'machine-1',
            machines: [makeMachine({ id: 'machine-1', metadata: { homeDir: '/Users/test' } })],
            recentMachinePaths: [],
            favoriteMachines: [],
            useEnhancedSessionWizard: false,
            refreshMachineEnvPresence: vi.fn(),
            sessions: [
                createSession({
                    id: 'session-1',
                    machineId: 'machine-1',
                    path: '/Users/test/Development/atlas',
                    updatedAt: 25,
                }),
            ],
        };

        const hook = await renderMachineRefreshState(initialProps);

        expect(hook.getCurrent().recentPaths).toEqual(['/Users/test/Development/atlas']);

        await hook.unmount();
    });

    it('keeps previous path suggestions visible while session data is refreshing', async () => {
        const initialProps: HookParams = {
            capabilityServerId: 'server-a',
            selectedMachineId: 'machine-1',
            machines: [makeMachine({ id: 'machine-1', metadata: { homeDir: '/Users/test' } })],
            recentMachinePaths: [
                { machineId: 'machine-1', path: '/Users/test/Development/lantern' },
            ],
            favoriteMachines: [],
            useEnhancedSessionWizard: false,
            refreshMachineEnvPresence: vi.fn(),
            sessions: [
                createSession({
                    id: 'session-1',
                    machineId: 'machine-1',
                    path: '/Users/test/Development/atlas',
                    updatedAt: 25,
                }),
            ],
        };

        const hook = await renderMachineRefreshState(initialProps);

        expect(hook.getCurrent().recentPaths).toEqual([
            '/Users/test/Development/lantern',
            '/Users/test/Development/atlas',
        ]);

        await hook.rerender({
            ...initialProps,
            sessions: null,
        });

        expect(hook.getCurrent().recentPaths).toEqual([
            '/Users/test/Development/lantern',
            '/Users/test/Development/atlas',
        ]);

        await hook.unmount();
    });
});
