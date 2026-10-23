import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { useServerScopedMachine } from './hooks';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('useServerScopedMachine demand', () => {
    let previousState: ReturnType<typeof storage.getState>;
    let telemetryEnabled: boolean;

    beforeEach(() => {
        previousState = storage.getState();
        telemetryEnabled = syncPerformanceTelemetry.isEnabled();
    });

    afterEach(() => {
        standardCleanup();
        vi.restoreAllMocks();
        syncPerformanceTelemetry.configure({ enabled: telemetryEnabled });
        syncPerformanceTelemetry.reset();
        storage.setState(previousState, true);
    });

    it('installs no Machine subscriptions for 200 mounted approval rows without a Machine id', async () => {
        syncPerformanceTelemetry.configure({ enabled: true });
        const subscribe = vi.spyOn(storage, 'subscribe'); // Instrument the real store; no replacement logic.
        function ApprovalMachineReader() {
            expect(useServerScopedMachine('home', '')).toBeNull();
            return null;
        }
        await renderHook(() => null, {
            wrapper: ({ children }) => React.createElement(React.Fragment, null, children,
                Array.from({ length: 200 }, (_, index) => React.createElement(ApprovalMachineReader, { key: index }))),
        });
        syncPerformanceTelemetry.reset();
        for (let publication = 0; publication < 10; publication += 1) {
            await act(async () => storage.setState({ isDataReady: publication % 2 === 0 }));
        }
        const evaluations = syncPerformanceTelemetry.snapshot().events
            .filter(event => event.name.startsWith('sync.store.storage.selector.'))
            .reduce((count, event) => count + event.count, 0);
        expect(evaluations).toBe(0);
        expect(subscribe).not.toHaveBeenCalled();
    });

    it('enables on demand, observes the exact Home row changing or disappearing, and disables again', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const machine = createMachineFixture();
        storage.setState({ machines: { [machine.id]: machine },
            machineListByServerId: { [serverId]: [machine], foreign: [] },
            machineListStatusByServerId: { [serverId]: 'idle', foreign: 'idle' } });
        const subscribe = vi.spyOn(storage, 'subscribe');
        const hook = await renderHook(({ home, id }: { home: string; id: string }) => useServerScopedMachine(home, id),
            { initialProps: { home: serverId, id: '' } });
        expect(hook.getCurrent()).toBeNull();
        expect(subscribe).not.toHaveBeenCalled();
        await hook.rerender({ home: serverId, id: ` ${machine.id} ` });
        expect(hook.getCurrent()).toBe(machine);
        expect(subscribe).toHaveBeenCalledTimes(1);
        const replacement = createMachineFixture({ id: machine.id, metadata: { ...machine.metadata!, host: 'renamed' } });
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: [replacement], foreign: [] } }));
        expect(hook.getCurrent()).toBe(replacement);
        await hook.rerender({ home: 'foreign', id: machine.id });
        expect(hook.getCurrent()).toBeNull();
        await hook.rerender({ home: serverId, id: machine.id });
        expect(hook.getCurrent()).toBe(replacement);
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: [], foreign: [] } }));
        expect(hook.getCurrent()).toBeNull();
        await hook.rerender({ home: serverId, id: ' ' });
        const subscriptions = subscribe.mock.calls.length;
        await act(async () => storage.setState({ isDataReady: false }));
        expect(hook.getCurrent()).toBeNull();
        expect(subscribe).toHaveBeenCalledTimes(subscriptions);
    });

    it('does not search a 100-Machine inventory for 200 sessionless rows on unrelated root publications', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        let comparisons = 0;
        const machines = Array.from({ length: 100 }, (_, index) => {
            const machine = createMachineFixture({ id: `machine-${index}` });
            Object.defineProperty(machine, 'id', { get: () => { comparisons += 1; return `machine-${index}`; } });
            return machine;
        });
        storage.setState({ machines: {}, machineListByServerId: { [serverId]: machines },
            machineListStatusByServerId: { [serverId]: 'idle' } });
        function ApprovalOriginReader() {
            expect(useServerScopedMachine(serverId, 'machine-99')).toBe(machines[99]);
            return null;
        }
        await renderHook(() => null, {
            wrapper: ({ children }) => React.createElement(React.Fragment, null, children,
                Array.from({ length: 200 }, (_, index) => React.createElement(ApprovalOriginReader, { key: index }))),
        });
        comparisons = 0;
        for (let publication = 0; publication < 10; publication += 1) {
            await act(async () => storage.setState({ isDataReady: publication % 2 === 0 }));
        }
        expect(comparisons).toBe(0);
    });

    it('withdraws the active fallback when the exact Home inventory settles empty', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const machine = createMachineFixture();
        storage.setState({ machines: { [machine.id]: machine },
            machineListByServerId: { [serverId]: [] },
            machineListStatusByServerId: { [serverId]: 'loading' } });
        const hook = await renderHook(() => useServerScopedMachine(serverId, machine.id));
        expect(hook.getCurrent()).toBe(machine);
        await act(async () => storage.setState({ machineListStatusByServerId: { [serverId]: 'idle' } }));
        expect(hook.getCurrent()).toBeNull();
    });
});
