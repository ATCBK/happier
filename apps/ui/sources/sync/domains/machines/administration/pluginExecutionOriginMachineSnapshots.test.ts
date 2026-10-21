import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import * as inventory from '@/sync/domains/machines/machineInventorySnapshots';
import * as origins from './pluginExecutionOrigin';
import { readExecutionOriginMachineSnapshots } from './pluginExecutionOriginMachineSnapshots';

afterEach(() => vi.restoreAllMocks());

describe('execution-origin Machine snapshot producer', () => {
    it('shares unchanged Machine facts across independent consumers, publications and declaration refreshes', () => {
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now);
        // Spies forward the real inventory/Fleet/serialization path, never mock it.
        const serialize = vi.spyOn(origins, 'serializePluginMachineExecutionOriginMachineFacts');
        const project = vi.spyOn(inventory, 'resolveAllProfileMachineInventorySnapshots');
        const stringify = vi.spyOn(JSON, 'stringify');
        const machine = createMachineFixture({ id: 'origin-count-machine', activeAt: now });
        const home = { id: 'origin-count-home', serverIdentityId: 'srv_origin_count', name: 'Home',
            serverUrl: 'https://origin-count.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
        const source = { source: { origin: { serverIdentityId: home.serverIdentityId,
            sourceRef: { machineId: machine.id, pluginId: 'acme.count',
                sourceCustody: { kind: 'development' as const, registeredRootId: 'root' } } },
            version: '1.0.0', occurrenceId: 'occurrence', serverId: home.id, generation: 1 },
            releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } };
        const base = { pluginId: 'acme.count', profiles: [home], activeServerId: home.id,
            reachabilityRevision: 0, readinessServerIdentityId: home.serverIdentityId,
            accountScopesByServerId: new Map([[home.serverIdentityId, { serverId: home.serverIdentityId, accountId: 'account-count' }]]),
            materializations: [], sources: [source],
            state: { machines: {}, machineListByServerId: { [home.id]: [machine] },
                machineListStatusByServerId: { [home.id]: 'idle' as const }, settings: { machineAdministrationTargetsLocalV1: {} } } };
        // Pass only the inventory fields the production reader consumes.
        const read = (input: typeof base) => readExecutionOriginMachineSnapshots(input);
        const first = read(base);
        expect(first.readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }))
            .toMatchObject({ rejection: null, eligible: true });
        const independent = { ...base, sources: [{ ...source, source: { ...source.source } }] };
        const before = serialize.mock.calls.length;
        const beforeJson = stringify.mock.calls.length;
        const beforeSnapshots = project.mock.calls.length;
        for (let index = 0; index < 100; index += 1) {
            expect(read({ ...base, state: { ...base.state } })).toBe(first);
            expect(read(independent)).toBe(first);
        }
        console.info('R-C equal-input producer counts', { publications: 100, consumers: 2,
            factCalls: serialize.mock.calls.length - before, jsonCalls: stringify.mock.calls.length - beforeJson });
        expect(serialize.mock.calls.length - before).toBe(0);
        expect(project.mock.calls.length - beforeSnapshots).toBe(0);

        // Release/custody changes are still handled by candidate admission; they
        // do not change which Home/Machine inventory facts these readers need.
        const refreshedDeclaration = { ...base, sources: [{ ...source, source: { ...source.source, generation: 2 } }] };
        expect(read(refreshedDeclaration)).toBe(first);
        expect(serialize.mock.calls.length - before).toBe(0);

        const otherTarget = { ...base, sources: [{ ...source, source: { ...source.source,
            origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef, machineId: 'missing-machine' } } } }] };
        const changedTarget = read(otherTarget);
        expect(changedTarget.key).not.toBe(first.key);
        expect(serialize.mock.calls.length - before).toBe(1);
        expect(changedTarget.readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: 'missing-machine' }).rejection).not.toBeNull();
        read(base);
        const beforeFactsChanged = serialize.mock.calls.length;

        // New raw presentation rows must be read, but same eligibility/order
        // does not require another plugin fact serialization.
        const heartbeat = read({ ...base, state: { ...base.state,
            machineListByServerId: { [home.id]: [{ ...machine, activeAt: now + 100 }] } } });
        expect(heartbeat.key).toBe(first.key);
        expect(heartbeat.readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }).activeAt).toBe(now + 100);
        expect(project.mock.calls.length - beforeSnapshots).toBe(1);
        expect(serialize.mock.calls.length).toBe(beforeFactsChanged);

        const revoked = read({ ...base, state: { ...base.state,
            machineListByServerId: { [home.id]: [{ ...machine, revokedAt: now }] } } });
        expect(revoked).not.toBe(first);
        expect(revoked.readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }).rejection).toBe('revoked');
        expect(serialize.mock.calls.length - beforeFactsChanged).toBe(1);

        const second = createMachineFixture({ id: 'second-origin-machine', activeAt: now + 1 });
        const pair = { ...base, sources: [source, { ...source, source: { ...source.source,
            origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef, machineId: second.id } } } }] };
        const refusedPair = { ...pair, state: { ...base.state, machineListByServerId: { [home.id]: [
            { ...machine, revokedAt: now }, { ...second, revokedAt: now },
        ] } } };
        const refused = read(refusedPair);
        const refusedCalls = serialize.mock.calls.length;
        const refusedHeartbeat = read({ ...refusedPair, state: { ...refusedPair.state, machineListByServerId: { [home.id]: [
            { ...machine, revokedAt: now, activeAt: now + 2 }, { ...second, revokedAt: now },
        ] } } });
        expect(refusedHeartbeat.key).toBe(refused.key);
        expect(serialize.mock.calls.length - refusedCalls).toBe(0);
        // Activity ordering among executable targets is a real selection input.
        const admittedPair = { ...pair, state: { ...base.state, machineListByServerId: { [home.id]: [machine, second] } } };
        const admitted = read(admittedPair);
        const ordered = read({ ...admittedPair, state: { ...admittedPair.state, machineListByServerId: { [home.id]: [
            { ...machine, activeAt: now + 2 }, second,
        ] } } });
        expect(ordered.key).not.toBe(admitted.key);
        expect(ordered.eligibilityKey).toBe(admitted.eligibilityKey);

        // The existing presence deadline is authoritative, even with the same raw rows.
        read(base);
        const expires = readMachineStatusNextRefreshAtMs(machine, now)!;
        expect(expires).not.toBeNull();
        vi.mocked(Date.now).mockReturnValue(expires);
        const expired = read(base);
        expect(expired.readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }).rejection).toBe('offline');
    });
});
