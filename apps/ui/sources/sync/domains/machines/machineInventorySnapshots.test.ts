import { beforeEach, describe, expect, it } from 'vitest';

import type { MachineDisplayCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { resolveFleetMachineRejection } from './administration/fleetUnion';
import { isMachineInventorySettled, readMachineInventoryStatus, resolveAllProfileMachineInventorySnapshots } from './machineInventorySnapshots';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from './reachability/machineReachability';
import { readLiveMachineInventoryRows } from './resolveServerScopedMachines';

function machine(input: Readonly<{
    id: string;
    active?: boolean;
    revokedAt?: number | null;
    replacedByMachineId?: string | null;
}>): Machine {
    return {
        id: input.id,
        seq: 1,
        createdAt: 1,
        updatedAt: 20,
        active: input.active ?? false,
        activeAt: input.active ? 20 : 0,
        revokedAt: input.revokedAt ?? null,
        replacedByMachineId: input.replacedByMachineId ?? null,
        // Narrow owner fixture: the projection reads only displayName.
        metadata: { displayName: input.id } as Machine['metadata'],
        availability: { kind: 'available' },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

const profiles = [
    {
        id: 'local-a',
        name: 'Server A',
        serverUrl: 'https://a.example.test',
        serverIdentityId: 'srv_server_a',
        legacyServerIds: ['legacy-a'],
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
    },
    {
        id: 'local-b',
        name: 'Server B',
        serverUrl: 'https://b.example.test',
        serverIdentityId: 'srv_server_b',
        legacyServerIds: ['legacy-b'],
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
    },
] as const;

const accountScopesByServerId = new Map(profiles.map(profile => [profile.serverIdentityId, { serverId: profile.serverIdentityId, accountId: 'account-1' }]));

describe('resolveAllProfileMachineInventorySnapshots', () => {
    beforeEach(clearMachineRequestReachabilityForTest);
    it('retains Account provenance and refuses execution without an exact Home credential scope', () => {
        const row = { ...machine({ id: 'scoped-row', active: true }), activeAt: Date.now() };
        const scope = { serverId: 'srv_server_a', accountId: 'account-1' };
        const base = { profiles: [profiles[0]], activeServerId: 'local-a', activeMachines: [row],
            machineListByServerId: { 'local-a': [row] }, machineListStatusByServerId: { 'local-a': 'idle' as const },
            loadWarmEntries: () => ({}) };
        recordMachineRequestFailed({ ...scope, accountId: 'other-account', machineId: row.id });
        const bound = { ...base, accountScopesByServerId: new Map([[scope.serverId, scope]]) };
        expect(resolveAllProfileMachineInventorySnapshots(bound)[0]).toMatchObject({
            accountId: scope.accountId, executionEligibleMachineIds: [row.id],
        });
        expect(resolveAllProfileMachineInventorySnapshots({ ...base, accountScopesByServerId: new Map() })[0])
            .toMatchObject({ accountId: null, machines: [expect.objectContaining({ id: row.id })], executionEligibleMachineIds: [] });
    });
    it('carries the published Home name instead of a host into machine selectors', () => {
        const profile = { ...profiles[0], name: 'localhost:52753' };
        primeServerFeaturesSnapshot({ serverId: 'srv_server_a', snapshot: {
            status: 'ready', features: { ...createRootLayoutFeaturesResponse(), homePresentation: { v: 1, displayName: 'Studio Home' } },
        } });
        try {
            expect(resolveAllProfileMachineInventorySnapshots({
                profiles: [profile], activeServerId: profile.id,
                activeMachines: [], machineListByServerId: {}, machineListStatusByServerId: {},
                accountScopesByServerId,  loadWarmEntries: () => ({}),
            })[0]).toMatchObject({ serverName: 'Studio Home' });
        } finally {
            deleteServerFeaturesSnapshot({ serverId: 'srv_server_a' });
        }
    });
    it('projects execution eligibility only from exact live raw membership, never presentation presence alone', () => {
        const row = { ...machine({ id: 'live-row', active: true }), activeAt: Date.now() };
        const base = { profiles: [profiles[0]], activeServerId: 'local-a',
            activeMachines: [row], machineListByServerId: { 'local-a': [row] },
            machineListStatusByServerId: { 'local-a': 'idle' as const }, accountScopesByServerId,  loadWarmEntries: () => ({}) };
        expect(resolveAllProfileMachineInventorySnapshots(base)[0]).toMatchObject({ executionEligibleMachineIds: [row.id] });
        // The scoped inventory owns current membership even if the active map still has an older object.
        expect(resolveAllProfileMachineInventorySnapshots({ ...base, machineListByServerId: { 'local-a': [{ ...row }] } })[0])
            .toMatchObject({ machines: [expect.objectContaining({ id: row.id })], executionEligibleMachineIds: [row.id] });
        for (const status of [undefined, 'signedOut'] as const) {
            expect(resolveAllProfileMachineInventorySnapshots({ ...base,
                machineListStatusByServerId: { 'local-a': status } })[0])
                .toMatchObject({ machines: [expect.objectContaining({ id: row.id })], executionEligibleMachineIds: [] });
        }
        // A failed list read is not evidence the admitted row left: it stays execution-eligible.
        expect(resolveAllProfileMachineInventorySnapshots({ ...base,
            machineListStatusByServerId: { 'local-a': 'error' } })[0])
            .toMatchObject({ observation: 'live', executionEligibleMachineIds: [row.id] });
        expect(resolveAllProfileMachineInventorySnapshots({ ...base, activeServerId: 'other',
            machineListStatusByServerId: { 'local-a': 'loading' } })[0]).toMatchObject({ executionEligibleMachineIds: [row.id] });
        for (const status of ['idle', 'loading'] as const) {
            const pending = { ...row, availability: undefined };
            expect(resolveAllProfileMachineInventorySnapshots({ ...base, activeMachines: [pending],
                machineListByServerId: { 'local-a': [pending] }, machineListStatusByServerId: { 'local-a': status } })[0])
                .toMatchObject({ executionEligibleMachineIds: [] });
        }
        expect(resolveAllProfileMachineInventorySnapshots({ ...base, activeServerId: 'other' })[0])
            .toMatchObject({ executionEligibleMachineIds: [row.id] });
        const locked = { ...row, availability: { kind: 'locked' as const, reason: 'encryption_material_unavailable' as const } };
        expect(resolveAllProfileMachineInventorySnapshots({ ...base, activeMachines: [locked],
            machineListByServerId: { 'local-a': [locked] } })[0]).toMatchObject({ executionEligibleMachineIds: [] });
    });

    it.each(['idle', 'loading'] as const)('retains opened Machine eligibility through pending content while %s without admitting fresh execution', (status) => {
        const row = { ...machine({ id: 'opening-row', active: true }), activeAt: Date.now(), daemonStateVersion: 1,
            keyBasis: { dataEncryptionKey: 'same-key', metadataVersion: 1, daemonStateVersion: 2 } };
        const base = { profiles: [profiles[0]], activeServerId: 'local-a', activeMachines: [row],
            machineListByServerId: { 'local-a': [row] }, machineListStatusByServerId: { 'local-a': status },
            accountScopesByServerId, loadWarmEntries: () => ({}) };
        const target = { serverIdentityId: 'srv_server_a', machineId: row.id };
        const snapshots = resolveAllProfileMachineInventorySnapshots(base);
        expect(snapshots[0]).toMatchObject({ executionEligibleMachineIds: [row.id], executionPendingMachineIds: [row.id] });
        expect(resolveFleetMachineRejection({ ...target, machineSnapshots: snapshots })).toBeNull();
        expect(readLiveMachineInventoryRows({ ...base, profile: profiles[0], serverIdentityId: target.serverIdentityId }).size).toBe(0);
        // Pending content never masks a real loss of admission or presence.
        for (const refused of [
            { ...row, metadata: null },
            { ...row, availability: undefined },
            { ...row, availability: { kind: 'locked' as const, reason: 'decryption_failed' as const } },
            { ...row, active: false, activeAt: 0 },
            { ...row, revokedAt: 1 },
            { ...row, replacedByMachineId: 'replacement' },
        ]) {
            expect(resolveAllProfileMachineInventorySnapshots({ ...base, activeMachines: [refused],
                machineListByServerId: { 'local-a': [refused] } })[0]).toMatchObject({ executionEligibleMachineIds: [] });
        }
    });

    it('keeps a machine with current presence selectable while its list refresh is in flight or failed, and rejects it only on positive evidence', () => {
        const row = { ...machine({ id: 'refreshing-row', active: true }), activeAt: Date.now() };
        const base = { profiles: [profiles[0]], activeServerId: 'local-a', activeMachines: [row],
            machineListByServerId: { 'local-a': [row] }, accountScopesByServerId, loadWarmEntries: () => ({}) };
        const target = { serverIdentityId: 'srv_server_a', machineId: row.id };
        const rejectionWhen = (status: 'idle' | 'loading' | 'error' | 'signedOut') => resolveFleetMachineRejection({
            ...target,
            machineSnapshots: resolveAllProfileMachineInventorySnapshots({ ...base, machineListStatusByServerId: { 'local-a': status } }),
        });
        expect(rejectionWhen('idle')).toBeNull();
        expect(rejectionWhen('loading')).toBeNull();
        // A failed read never proves absence; only a signed-out Home (explicit refusal) or lapsed presence demotes.
        expect(rejectionWhen('error')).toBeNull();
        expect(rejectionWhen('signedOut')).toBe('stale');
        // The admitted row remains executable, but the rest of the list is not settled.
        expect(resolveAllProfileMachineInventorySnapshots({ ...base, machineListStatusByServerId: { 'local-a': 'loading' } })[0])
            .toMatchObject({ observation: 'live', executionEligibleMachineIds: [row.id] });
        expect(isMachineInventorySettled(resolveAllProfileMachineInventorySnapshots({ ...base, machineListStatusByServerId: { 'local-a': 'loading' } }), 'srv_server_a')).toBe(false);
        // A machine whose live presence lapsed is still rejected during the refresh, and after a failed read.
        const lapsed = { ...row, active: false, activeAt: 1 };
        expect(resolveFleetMachineRejection({ ...target, machineSnapshots: resolveAllProfileMachineInventorySnapshots({
            ...base, activeMachines: [lapsed], machineListByServerId: { 'local-a': [lapsed] },
            machineListStatusByServerId: { 'local-a': 'loading' } }) })).toBe('offline');
        expect(resolveFleetMachineRejection({ ...target, machineSnapshots: resolveAllProfileMachineInventorySnapshots({
            ...base, activeMachines: [lapsed], machineListByServerId: { 'local-a': [lapsed] },
            machineListStatusByServerId: { 'local-a': 'error' } }) })).toBe('offline');
    });

    it('projects request reachability for the exact Home and recovers after a successful retry', () => {
        const row = { ...machine({ id: 'inventory-reachability-row', active: true }), activeAt: Date.now() };
        const base = { profiles: [profiles[0]], activeServerId: 'local-a',
            activeMachines: [row], machineListByServerId: { 'local-a': [row] },
            machineListStatusByServerId: { 'local-a': 'idle' as const }, accountScopesByServerId,  loadWarmEntries: () => ({}) };
        recordMachineRequestFailed({ serverId: 'srv_server_b', accountId: 'account-1', machineId: row.id, observedAtMs: 1 });
        expect(resolveAllProfileMachineInventorySnapshots(base)[0]).toMatchObject({ executionEligibleMachineIds: [row.id] });
        recordMachineRequestFailed({ serverId: 'srv_server_a', accountId: 'account-1', machineId: row.id, observedAtMs: 2 });
        expect(resolveAllProfileMachineInventorySnapshots(base)[0]).toMatchObject({ executionEligibleMachineIds: [] });
        recordMachineRequestSucceeded({ serverId: 'srv_server_a', accountId: 'account-1', machineId: row.id, observedAtMs: 3 });
        expect(resolveAllProfileMachineInventorySnapshots(base)[0]).toMatchObject({ executionEligibleMachineIds: [row.id] });
    });

    it.each([true, false])('uses canonical settled rows even when an active or alias list disagrees, contains machine = %s', (containsMachine) => {
        const row = machine({ id: 'machine-conflict', active: true });
        const snapshots = resolveAllProfileMachineInventorySnapshots({
            profiles, activeServerId: 'local-a', activeMachines: [row],
            machineListByServerId: { srv_server_a: containsMachine ? [row] : [], 'local-a': containsMachine ? [] : [row] },
            machineListStatusByServerId: { srv_server_a: 'idle', 'local-a': 'idle' },
            accountScopesByServerId,  loadWarmEntries: () => ({}),
        });
        expect(snapshots[0]).toMatchObject({
            kind: 'resolved', observation: 'live', settled: true, inventoryStatus: 'idle',
            machines: containsMachine ? [expect.objectContaining({ id: row.id })] : [],
        });
    });

    it('preserves inventory loading, failure, and a settled empty list', () => {
        const base = {
            profiles,
            activeServerId: 'local-a',
            activeMachines: [],
            machineListByServerId: {},
            accountScopesByServerId,
            loadWarmEntries: () => ({}),
        };
        const loading = resolveAllProfileMachineInventorySnapshots({ ...base, machineListStatusByServerId: {} });
        expect(isMachineInventorySettled(loading, 'srv_server_a')).toBe(false);
        expect(loading[0]).toMatchObject({ inventoryStatus: 'loading' });
        expect(readMachineInventoryStatus(loading, 'srv_server_a')).toBe('loading');

        const read = resolveAllProfileMachineInventorySnapshots({
            ...base, machineListByServerId: { 'local-a': [] }, machineListStatusByServerId: { 'local-a': 'idle' },
        });
        expect(isMachineInventorySettled(read, 'srv_server_a')).toBe(true);
        expect(readMachineInventoryStatus(read, 'srv_server_a')).toBe('idle');

        const failed = resolveAllProfileMachineInventorySnapshots({ ...base, machineListStatusByServerId: { 'local-a': 'error' } });
        expect(isMachineInventorySettled(failed, 'srv_server_a')).toBe(false);
        expect(failed[0]).toMatchObject({ inventoryStatus: 'error' });
        expect(readMachineInventoryStatus(failed, 'srv_server_a')).toBe('error');
        const signedOut = resolveAllProfileMachineInventorySnapshots({ ...base, machineListStatusByServerId: { 'local-a': 'signedOut' } });
        expect(signedOut[0]).toMatchObject({ inventoryStatus: 'signedOut' });
        expect(readMachineInventoryStatus(signedOut, 'srv_server_a')).toBe('signedOut');
    });

    it('never settles a Home from its warm cache alone', () => {
        const snapshots = resolveAllProfileMachineInventorySnapshots({
            profiles,
            activeServerId: 'local-a',
            activeMachines: [],
            machineListByServerId: { 'local-b': [machine({ id: 'machine-b' })] },
            machineListStatusByServerId: { 'local-b': 'error' },
            accountScopesByServerId,
            loadWarmEntries: () => ({}),
        });
        expect(isMachineInventorySettled(snapshots, 'srv_server_b')).toBe(false);
    });

    it('projects active and non-active raw lists under canonical portable server identity', () => {
        const snapshots = resolveAllProfileMachineInventorySnapshots({
            profiles,
            activeServerId: 'local-a',
            activeMachines: [machine({ id: 'machine-a', active: true })],
            machineListByServerId: {
                'legacy-b': [machine({ id: 'machine-b', revokedAt: 30 })],
            },
            machineListStatusByServerId: { 'local-a': 'idle', 'legacy-b': 'idle' },
            accountScopesByServerId,
            loadWarmEntries: () => ({}),
        });

        expect(snapshots).toEqual([
            expect.objectContaining({
                kind: 'resolved',
                serverIdentityId: 'srv_server_a',
                observation: 'live',
                machines: [expect.objectContaining({ id: 'machine-a' })],
            }),
            expect.objectContaining({
                kind: 'resolved',
                serverIdentityId: 'srv_server_b',
                observation: 'live',
                machines: [expect.objectContaining({ id: 'machine-b', revokedAt: 30 })],
            }),
        ]);
    });

    it('rehydrates replacement tombstones from canonical, local-id, or legacy warm keys without treating them as live', () => {
        const requestedKeys: string[] = [];
        const cached: Record<string, Record<string, MachineDisplayCacheEntryV1>> = {
            'legacy-b': {
                'machine-old': {
                    machineId: 'machine-old',
                    metadataVersion: 1,
                    updatedAt: 40,
                    active: false,
                    activeAt: 20,
                    revokedAt: null,
                    replacedByMachineId: 'machine-new',
                    replacedAt: 35,
                    displayName: 'Old machine',
                },
            },
        };

        const snapshots = resolveAllProfileMachineInventorySnapshots({
            profiles: [profiles[1]],
            activeServerId: 'srv_server_a',
            activeMachines: [],
            machineListByServerId: {},
            machineListStatusByServerId: {},
            accountScopesByServerId,
            loadWarmEntries: (serverId) => {
                requestedKeys.push(serverId);
                return cached[serverId] ?? {};
            },
        });

        expect(requestedKeys).toEqual(['srv_server_b', 'local-b', 'legacy-b']);
        expect(snapshots).toEqual([
            expect.objectContaining({
                kind: 'resolved',
                serverIdentityId: 'srv_server_b',
                observation: 'stale',
                machines: [expect.objectContaining({
                    id: 'machine-old',
                    replacedByMachineId: 'machine-new',
                })],
            }),
        ]);
    });

    it('fails closed for ambiguous portable identity claims and reports uninventoried profiles as unknown', () => {
        const snapshots = resolveAllProfileMachineInventorySnapshots({
            profiles: [
                profiles[0],
                { ...profiles[1], legacyServerIds: ['srv_server_a'] },
            ],
            activeServerId: 'srv_other',
            activeMachines: [],
            machineListByServerId: {},
            machineListStatusByServerId: {},
            accountScopesByServerId,
            loadWarmEntries: () => ({}),
        });

        expect(snapshots).toEqual([
            expect.objectContaining({
                kind: 'ambiguousIdentity',
                serverIdentityId: 'srv_server_a',
            }),
            expect.objectContaining({
                kind: 'unknown',
                serverIdentityId: 'srv_server_b',
            }),
        ]);
    });
});
