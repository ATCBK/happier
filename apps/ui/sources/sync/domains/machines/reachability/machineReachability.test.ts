import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    clearMachineRequestReachabilityForTest,
    isMachineRequestReachabilityFailure,
    readMachineRequestReachabilityObservation,
    recordMachineRequestFailed,
    recordMachineRequestSucceeded,
    resolveMachineReachable,
    subscribeMachineRequestReachability,
} from './machineReachability';

afterEach(() => clearMachineRequestReachabilityForTest());

describe('machine reachability', () => {
    it('keeps a request failure unreachable across newer heartbeats until a request succeeds', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeMachineRequestReachability(listener);
        recordMachineRequestFailed({ serverId: 'home', machineId: 'machine', observedAtMs: 20 });
        const failure = readMachineRequestReachabilityObservation('home', 'machine');
        expect(resolveMachineReachable({
            presenceReachable: true,
            presenceObservedAtMs: 10,
            requestObservation: failure,
        })).toBe(false);
        expect(resolveMachineReachable({
            presenceReachable: true,
            presenceObservedAtMs: 21,
            requestObservation: failure,
        })).toBe(false);

        recordMachineRequestSucceeded({ serverId: 'home', machineId: 'machine', observedAtMs: 22 });
        expect(resolveMachineReachable({
            presenceReachable: true,
            presenceObservedAtMs: 10,
            requestObservation: readMachineRequestReachabilityObservation('home', 'machine'),
        })).toBe(true);
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });

    it('classifies transport unavailability without treating capability or encryption errors as offline', () => {
        expect(isMachineRequestReachabilityFailure({ code: 'MACHINE_RPC_TIMEOUT' })).toBe(true);
        expect(isMachineRequestReachabilityFailure({ code: 'target_unavailable' })).toBe(true);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'machine_offline' })).toBe(true);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' })).toBe(false);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' })).toBe(false);
    });

    it('reads a missing host method as the daemon not answering, and a missing plugin method as a capability gap', () => {
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' },
            'daemon.filesystem.listDirectory')).toBe(true);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' },
            'plugin.example.readThing')).toBe(false);
    });
});
