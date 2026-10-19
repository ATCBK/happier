import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

import {
    clearMachineRequestReachabilityForTest,
    clearMachineRequestReachabilityForScope,
    clearMachineRequestReachabilityForMachine,
    isMachineReachable,
    isMachineRequestReachabilityFailure,
    readMachineRequestReachabilityObservation,
    recordMachineRequestFailed,
    recordMachineRequestSucceeded,
    subscribeMachineRequestReachability,
} from './machineReachability';

afterEach(() => clearMachineRequestReachabilityForTest());

describe('machine reachability', () => {
    it('retains a failed direct route across relay success and clears it at the exact reconnect edge', () => {
        const scope = { serverId: 'home', accountId: 'account-a' };
        const route = 'loopback_direct' as const;
        recordMachineRequestFailed({ ...scope, machineId: 'machine', route, observedAtMs: 20 });
        recordMachineRequestSucceeded({ ...scope, machineId: 'machine', observedAtMs: 30 });
        expect(isMachineReachable(scope, { id: 'machine', active: true }, 30)).toBe(true);
        expect(readMachineRequestReachabilityObservation(scope, 'machine', route)?.outcome).toBe('failed');
        expect(readMachineRequestReachabilityObservation({ ...scope, accountId: 'account-b' }, 'machine', route)).toBeNull();
        expect(readMachineRequestReachabilityObservation({ ...scope, serverId: 'other-home' }, 'machine', route)).toBeNull();
        recordMachineRequestFailed({ ...scope, machineId: 'machine2', route, observedAtMs: 20 });
        clearMachineRequestReachabilityForMachine(scope, 'machine');
        expect(readMachineRequestReachabilityObservation(scope, 'machine', route)).toBeNull();
        expect(readMachineRequestReachabilityObservation(scope, 'machine2', route)?.outcome).toBe('failed');
        recordMachineRequestSucceeded({ ...scope, machineId: 'machine2', route, observedAtMs: 40 });
        expect(readMachineRequestReachabilityObservation(scope, 'machine2', route)?.outcome).toBe('succeeded');
        clearMachineRequestReachabilityForScope(scope);
        expect(readMachineRequestReachabilityObservation(scope, 'machine2', route)).toBeNull();
    });

    it('publishes admission changes without retriggering readers for repeated successful replies', () => {
        const scope = { serverId: 'home', accountId: 'account-a' };
        const listener = vi.fn();
        const unsubscribe = subscribeMachineRequestReachability(listener);
        recordMachineRequestSucceeded({ ...scope, machineId: 'machine', observedAtMs: 20 });
        recordMachineRequestSucceeded({ ...scope, machineId: 'machine', observedAtMs: 30 });
        recordMachineRequestSucceeded({ ...scope, machineId: 'machine', observedAtMs: 40 });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(readMachineRequestReachabilityObservation(scope, 'machine')).toEqual({ outcome: 'succeeded', observedAtMs: 40 });
        recordMachineRequestFailed({ ...scope, machineId: 'machine', observedAtMs: 35 });
        expect(listener).toHaveBeenCalledTimes(1);
        recordMachineRequestFailed({ ...scope, machineId: 'machine', observedAtMs: 45 });
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });

    it('keeps a request failure unreachable across newer heartbeats until a request succeeds', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeMachineRequestReachability(listener);
        const scope = { serverId: 'home', accountId: 'account-a' };
        const machine = { id: 'machine', active: true, activeAt: 10 };
        recordMachineRequestFailed({ ...scope, machineId: machine.id, observedAtMs: 20 });
        for (const activeAt of [10, 20, 21, null]) {
            expect(isMachineReachable(scope, { ...machine, activeAt }, 21)).toBe(false);
        }
        expect(isMachineReachable(scope, { ...machine, active: false, activeAt: 21 }, 21)).toBe(false);

        recordMachineRequestSucceeded({ ...scope, machineId: machine.id, observedAtMs: 22 });
        expect(isMachineReachable(scope, machine, 22)).toBe(true);
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });

    it('isolates observations by Home and Account, including a late completion from another Account', () => {
        const accountA = { serverId: 'home', accountId: 'account-a' };
        const accountB = { serverId: 'home', accountId: 'account-b' };
        const machine = { id: 'machine', active: true, activeAt: 100 };
        recordMachineRequestFailed({ ...accountA, machineId: machine.id, observedAtMs: 20 });
        expect(isMachineReachable(accountA, machine, 100)).toBe(false);
        expect(isMachineReachable(accountB, machine, 100)).toBe(true);
        expect(isMachineReachable({ ...accountA, serverId: 'other-home' }, machine, 100)).toBe(true);
        recordMachineRequestFailed({ ...accountB, machineId: machine.id, observedAtMs: 30 });
        recordMachineRequestSucceeded({ ...accountA, machineId: machine.id, observedAtMs: 40 });
        expect(isMachineReachable(accountA, machine, 100)).toBe(true);
        expect(isMachineReachable(accountB, machine, 100)).toBe(false);
    });

    it('classifies transport unavailability without treating capability or encryption errors as offline', () => {
        // A dispatched operation can exceed its response budget while the daemon remains online.
        expect(isMachineRequestReachabilityFailure({ code: 'MACHINE_RPC_TIMEOUT' })).toBe(false);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' })).toBe(false);
        expect(isMachineRequestReachabilityFailure({ code: 'target_unavailable' })).toBe(true);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'machine_offline' })).toBe(true);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' })).toBe(false);
        expect(isMachineRequestReachabilityFailure({ rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' })).toBe(false);
        // Both the decoded daemon refusal and its transport Error are request-scoped facts.
        expect(isMachineRequestReachabilityFailure({ errorCode: RPC_ERROR_CODES.FORBIDDEN, admissionPredicate: 'machine_currentness' })).toBe(false);
        expect(isMachineRequestReachabilityFailure(new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN))).toBe(false);
    });

    it('clears reconnect failures only for the reconnected Machine or exact Account socket', () => {
        const scope = { serverId: 'home', accountId: 'account-a' };
        const anotherAccount = { ...scope, accountId: 'account-b' };
        const anotherHome = { ...scope, serverId: 'other-home' };
        for (const identity of [scope, anotherAccount, anotherHome]) {
            for (const machineId of ['first', 'second']) recordMachineRequestFailed({ ...identity, machineId });
        }
        clearMachineRequestReachabilityForMachine(scope, 'first');
        expect(readMachineRequestReachabilityObservation(scope, 'first')).toBeNull();
        expect(readMachineRequestReachabilityObservation(scope, 'second')?.outcome).toBe('failed');
        clearMachineRequestReachabilityForScope(scope);
        expect(readMachineRequestReachabilityObservation(scope, 'second')).toBeNull();
        expect(readMachineRequestReachabilityObservation(anotherAccount, 'first')?.outcome).toBe('failed');
        expect(readMachineRequestReachabilityObservation(anotherHome, 'first')?.outcome).toBe('failed');
    });

});
