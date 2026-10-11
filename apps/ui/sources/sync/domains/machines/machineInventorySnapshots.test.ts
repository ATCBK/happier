import { describe, expect, it } from 'vitest';

import type { MachineDisplayCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { isMachineInventorySettled, readMachineInventoryStatus, resolveAllProfileMachineInventorySnapshots } from './machineInventorySnapshots';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

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

describe('resolveAllProfileMachineInventorySnapshots', () => {
    it('carries the published Home name instead of a host into machine selectors', () => {
        const profile = { ...profiles[0], name: 'localhost:52753' };
        primeServerFeaturesSnapshot({ serverId: 'srv_server_a', snapshot: {
            status: 'ready', features: { ...createRootLayoutFeaturesResponse(), homePresentation: { v: 1, displayName: 'Studio Home' } },
        } });
        try {
            expect(resolveAllProfileMachineInventorySnapshots({
                profiles: [profile], activeServerId: profile.id, activeInventoryLoaded: true,
                activeMachines: [], machineListByServerId: {}, machineListStatusByServerId: {},
                accountId: 'account-1', loadWarmEntries: () => ({}),
            })[0]).toMatchObject({ serverName: 'Studio Home' });
        } finally {
            deleteServerFeaturesSnapshot({ serverId: 'srv_server_a' });
        }
    });
    it('projects execution eligibility only from exact live raw membership, never presentation presence alone', () => {
        const row = { ...machine({ id: 'live-row', active: true }), activeAt: Date.now() };
        const base = { profiles: [profiles[0]], activeServerId: 'local-a', activeInventoryLoaded: true,
            activeMachines: [row], machineListByServerId: { 'local-a': [row] },
            machineListStatusByServerId: { 'local-a': 'idle' as const }, accountId: 'account-1', loadWarmEntries: () => ({}) };
        expect(resolveAllProfileMachineInventorySnapshots(base)[0]).toMatchObject({ executionEligibleMachineIds: [row.id] });
        // An equal-looking scoped row is not the raw active row admitted by the invocation owner.
        expect(resolveAllProfileMachineInventorySnapshots({ ...base, machineListByServerId: { 'local-a': [{ ...row }] } })[0])
            .toMatchObject({ machines: [expect.objectContaining({ id: row.id })], executionEligibleMachineIds: [] });
        expect(resolveAllProfileMachineInventorySnapshots({ ...base, activeInventoryLoaded: false })[0])
            .toMatchObject({ executionEligibleMachineIds: [] });
        expect(resolveAllProfileMachineInventorySnapshots({ ...base, activeServerId: 'other',
            machineListStatusByServerId: { 'local-a': 'loading' } })[0]).toMatchObject({ executionEligibleMachineIds: [] });
        expect(resolveAllProfileMachineInventorySnapshots({ ...base, activeServerId: 'other' })[0])
            .toMatchObject({ executionEligibleMachineIds: [row.id] });
        const locked = { ...row, availability: { kind: 'locked' as const, reason: 'encryption_material_unavailable' as const } };
        expect(resolveAllProfileMachineInventorySnapshots({ ...base, activeMachines: [locked],
            machineListByServerId: { 'local-a': [locked] } })[0]).toMatchObject({ executionEligibleMachineIds: [] });
    });

    it.each([true, false])('uses canonical settled rows even when an active or alias list disagrees, contains machine = %s', (containsMachine) => {
        const row = machine({ id: 'machine-conflict', active: true });
        const snapshots = resolveAllProfileMachineInventorySnapshots({
            profiles, activeServerId: 'local-a', activeInventoryLoaded: true, activeMachines: [row],
            machineListByServerId: { srv_server_a: containsMachine ? [row] : [], 'local-a': containsMachine ? [] : [row] },
            machineListStatusByServerId: { srv_server_a: 'idle', 'local-a': 'idle' },
            accountId: 'account-1', loadWarmEntries: () => ({}),
        });
        expect(snapshots[0]).toMatchObject({
            kind: 'resolved', observation: 'live', settled: true, inventoryStatus: 'idle',
            machines: containsMachine ? [expect.objectContaining({ id: row.id })] : [],
        });
    });

    it.each([true, false])('preserves inventory loading and failure with app data ready = %s', (activeInventoryLoaded) => {
        const base = {
            profiles,
            activeServerId: 'local-a',
            // Sessions arrived (the app is "data ready") before this Home's machine list did.
            activeInventoryLoaded,
            activeMachines: [],
            machineListByServerId: {},
            accountId: 'account-1',
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
            activeInventoryLoaded: false,
            activeMachines: [],
            machineListByServerId: { 'local-b': [machine({ id: 'machine-b' })] },
            machineListStatusByServerId: { 'local-b': 'error' },
            accountId: 'account-1',
            loadWarmEntries: () => ({}),
        });
        expect(isMachineInventorySettled(snapshots, 'srv_server_b')).toBe(false);
    });

    it('projects active and non-active raw lists under canonical portable server identity', () => {
        const snapshots = resolveAllProfileMachineInventorySnapshots({
            profiles,
            activeServerId: 'local-a',
            activeInventoryLoaded: true,
            activeMachines: [machine({ id: 'machine-a', active: true })],
            machineListByServerId: {
                'legacy-b': [machine({ id: 'machine-b', revokedAt: 30 })],
            },
            machineListStatusByServerId: { 'local-a': 'idle', 'legacy-b': 'idle' },
            accountId: 'account-1',
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
            activeInventoryLoaded: true,
            activeMachines: [],
            machineListByServerId: {},
            machineListStatusByServerId: {},
            accountId: 'account-1',
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
            activeInventoryLoaded: true,
            activeMachines: [],
            machineListByServerId: {},
            machineListStatusByServerId: {},
            accountId: 'account-1',
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
