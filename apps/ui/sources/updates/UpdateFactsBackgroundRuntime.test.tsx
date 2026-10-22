import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createDeferred, createMachineFixture, renderScreen } from '@/dev/testkit';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});

import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { UpdateFactsBackgroundRuntime } from './UpdateFactsBackgroundRuntime';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';

afterEach(() => boundary.rpc.mockReset());

describe('Updates cold fleet capability demand', () => {
    it('does not commit the mounted background runtime for unrelated Machine details', async () => {
        const previous = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        let machine = createMachineFixture({ id: 'updates-membership', activeAt: Date.now() });
        const publish = () => storage.setState({ profileScope: null,
            machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        let commits = 0;
        publish();
        const screen = await renderScreen(<React.Profiler id="update-facts" onRender={() => { commits++; }}>
            <UpdateFactsBackgroundRuntime enabled />
        </React.Profiler>);
        try {
            const before = commits;
            for (let tick = 1; tick <= 5; tick++) {
                machine = { ...machine, daemonStateVersion: tick, updatedAt: machine.updatedAt + 1 };
                await act(async () => publish());
            }
            expect(commits - before).toBe(0);
        } finally {
            await screen.unmount();
            storage.setState(previous, true);
        }
    });

    it('preserves each pending machine probe while other machines arrive or leave', async () => {
        const previous = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        const reply = createDeferred<unknown>();
        const signals: AbortSignal[] = [];
        boundary.rpc.mockImplementation(({ signal }: { signal: AbortSignal }) => {
            signals.push(signal);
            return reply.promise;
        });
        const machines = ['perf8-first', 'perf8-second', 'perf8-third'].map(id => createMachineFixture({
            id, active: true, activeAt: Date.now(),
        }));
        const publish = (rows: typeof machines) => storage.setState({
            profileScope: { serverId, accountId: 'perf8' },
            machines: Object.fromEntries(rows.map(machine => [machine.id, machine])),
            machineListByServerId: { [serverId]: rows },
        });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            publish(machines.slice(0, 1));
            screen = await renderScreen(<><UpdateFactsBackgroundRuntime enabled /><UpdateFactsBackgroundRuntime enabled /></>);
            await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(1));
            await act(async () => publish(machines.slice(0, 2)));
            await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(2));
            expect(signals[0]?.aborted).toBe(false);
            await act(async () => publish(machines));
            await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(3));
            await act(async () => publish(machines.slice(0, 2)));
            expect(signals[0]?.aborted).toBe(false);
            expect(signals[1]?.aborted).toBe(false);
            expect(signals[2]?.aborted).toBe(true);
            await act(async () => reply.resolve({ protocolVersion: 1, results: {} }));
            await screen.unmount();
            screen = await renderScreen(<UpdateFactsBackgroundRuntime enabled />);
            expect(boundary.rpc).toHaveBeenCalledTimes(3);
            await act(async () => publishMachineContributionRegistryProjectionInvalidation({ serverId, machineId: machines[0]!.id }));
            await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(4));
        } finally {
            reply.resolve({ protocolVersion: 1, results: {} });
            await screen?.unmount();
            storage.setState(previous);
        }
    });
});
