import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { adoptHomeProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';

installApprovalCommonModuleMocks({ storage: original => original() });
const { storage } = await import('@/sync/domains/state/storage');
const { resolveUiAccountActionFallbackMachineId } = await import('./accountActionDeps');
const initialState = storage.getState();
let scope: { serverId: string; accountId: string };

beforeEach(async () => {
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_account_carrier', canonicalServerUrl: 'https://account-carrier.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://account-carrier.test' }] } });
    await setActiveServerId(home.id);
    scope = { serverId: home.id, accountId: 'carrier-owner' };
    const machines = [createMachineFixture({ id: 'general', activeAt: Date.now(), createdAt: 3 }),
        createMachineFixture({ id: 'supplier', activeAt: Date.now(), createdAt: 2 }),
        createMachineFixture({ id: 'offline', active: false, activeAt: 0 })];
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [home.id]: machines }, machineListStatusByServerId: { [home.id]: 'idle' } });
});
afterEach(() => storage.setState(initialState, true));

describe('Account Action carrier selection', () => {
    it('constrains automatic selection to the caller candidates without falling back to an offline carrier', () => {
        expect(resolveUiAccountActionFallbackMachineId(scope)).toBe('general');
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: ['supplier'] })).toBe('supplier');
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: ['offline'] })).toBeNull();
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: [] })).toBeNull();
    });

    it('honors an explicit visible target, including recovery, but never escapes the candidate set', () => {
        expect(resolveUiAccountActionFallbackMachineId(scope, { target: { kind: 'machine', machineId: 'supplier' } })).toBe('supplier');
        expect(resolveUiAccountActionFallbackMachineId(scope, { target: { kind: 'machine', machineId: 'offline' } })).toBe('offline');
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: ['supplier'],
            target: { kind: 'machine', machineId: 'general' } })).toBeNull();
        expect(resolveUiAccountActionFallbackMachineId(scope, { target: { kind: 'machine', machineId: 'missing' } })).toBeNull();
    });

    it('allows Registry manual retry, without leaking a carrier across Homes', () => {
        expect(resolveUiAccountActionFallbackMachineId(scope, { candidateMachineIds: ['offline'], allowUnreachableFallback: true })).toBe('offline');
        expect(resolveUiAccountActionFallbackMachineId({ ...scope, serverId: 'other-home' }, {
            target: { kind: 'machine', machineId: 'general' }, allowUnreachableFallback: true })).toBeNull();
    });
});
