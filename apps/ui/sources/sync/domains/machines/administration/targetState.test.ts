import { beforeEach, describe, expect, it } from 'vitest';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { adoptHomeProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { t } from '@/text';
import {
    clearMachineRequestReachabilityForTest,
    recordMachineRequestFailed,
} from '@/sync/domains/machines/reachability/machineReachability';

import {
    buildMachineAdministrationCandidateInventoryRows,
    buildMachineAdministrationCandidateInventoryRowsFromSnapshots,
    buildMachineAdministrationCandidates,
} from './targetState';

function machine(input: Readonly<{
    id: string;
    active?: boolean;
    revokedAt?: number | null;
    replacedByMachineId?: string | null;
    locked?: boolean;
}>): Machine {
    return {
        id: input.id,
        seq: 1,
        createdAt: 10,
        updatedAt: 20,
        active: input.active ?? false,
        activeAt: input.active ? 100 : 0,
        revokedAt: input.revokedAt ?? null,
        replacedByMachineId: input.replacedByMachineId ?? null,
        // Narrow owner fixture: the projection reads only displayName.
        metadata: { displayName: input.id } as Machine['metadata'],
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        ...(input.locked ? { availability: { kind: 'locked' as const, reason: 'decryption_failed' as const } } : {}),
    };
}

let profile: ServerProfile;
beforeEach(async () => {
    clearMachineRequestReachabilityForTest();
    const url = 'https://b.example.test';
    profile = await adoptHomeProfile({ descriptor: {
        v: 1, homeServerIdentityId: 'srv_server_b', canonicalServerUrl: url,
        revision: 1, endpoints: [{ kind: 'https', url }],
    }, source: 'manual', suggestedName: 'Server B' });
});

describe('buildMachineAdministrationCandidates', () => {
    it('uses the canonical inventory names in both raw and snapshot candidate projections', () => {
        const machines = [
            { ...machine({ id: 'aaaa-machine' }), metadata: { ...machine({ id: 'aaaa-machine' }).metadata!, displayName: 'Studio' } },
            { ...machine({ id: 'bbbb-machine' }), metadata: { ...machine({ id: 'bbbb-machine' }).metadata!, displayName: 'Studio' } },
            machine({ id: 'locked-machine', locked: true }),
            { ...machine({ id: 'unnamed-machine' }), metadata: null, availability: { kind: 'available' as const } },
        ];
        const raw = buildMachineAdministrationCandidateInventoryRows({ profiles: [profile], activeServerId: profile.id,
            activeMachineRecords: machines, machineRecordListsByServerId: {}, nowMs: 100 });
        const snapshots = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots: [{
            kind: 'resolved', profileId: profile.id, accountId: 'account-b', serverIdentityId: profile.serverIdentityId!, serverName: 'Server B',
            observation: 'live', machines,
        }], nowMs: 100 });
        for (const rows of [raw, snapshots]) {
            expect(rows.map(row => row.candidate.displayName)).toEqual([
                'Studio · aaaa', 'Studio · bbbb', t('machine.lockedMachine'), t('machine.unnamedMachine'),
            ]);
        }
    });
    it('projects a failed server-scoped request as unreachable despite fresh pushed presence', () => {
        recordMachineRequestFailed({ serverId: 'srv_server_b', accountId: 'account-b', machineId: 'machine-b', observedAtMs: 100 });

        const rows = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({
            snapshots: [{
                kind: 'resolved',
                profileId: 'local-profile-b',
                accountId: 'account-b',
                serverIdentityId: 'srv_server_b',
                serverName: 'Server B',
                observation: 'live',
                machines: [machine({ id: 'machine-b', active: true })],
            }],
            nowMs: 100,
        });

        expect(rows[0]?.candidate.availability).toBe('offline');
    });
    it('carries the published Home name into administration targets', () => {
        primeServerFeaturesSnapshot({ serverId: 'srv_server_b', snapshot: {
            status: 'ready', features: { ...createRootLayoutFeaturesResponse(), homePresentation: { v: 1, displayName: 'Studio Home' } },
        } });
        try {
            expect(buildMachineAdministrationCandidateInventoryRows({
                profiles: [{ ...profile, name: 'localhost:52753' }], activeServerId: profile.id,
                activeMachineRecords: [machine({ id: 'machine-b' })], machineRecordListsByServerId: {}, nowMs: 100,
            })[0]).toMatchObject({ serverName: 'Studio Home', candidate: { serverLabel: 'Studio Home' } });
        } finally {
            deleteServerFeaturesSnapshot({ serverId: 'srv_server_b' });
        }
    });
    it('keeps the device-local routing row attached to its portable candidate without exposing it as preference data', () => {
        const rawMachine = machine({ id: 'machine-b', active: true });

        expect(buildMachineAdministrationCandidateInventoryRows({
            profiles: [profile],
            activeServerId: 'local-profile-a',
            activeMachineRecords: [],
            machineRecordListsByServerId: {
                srv_server_b: [rawMachine],
            },
            nowMs: 100,
        })).toEqual([{
            candidate: expect.objectContaining({
                target: {
                    serverIdentityId: 'srv_server_b',
                    machineId: 'machine-b',
                },
            }),
            serverId: profile.id,
            serverName: 'Server B',
            machine: rawMachine,
        }]);
    });

    it('uses raw canonical-scope inventory and retains revoked, replaced, offline, and locked facts', () => {
        const candidates = buildMachineAdministrationCandidates({
            profiles: [profile],
            accountScopesByServerId: new Map([[profile.serverIdentityId!, { serverId: profile.serverIdentityId!, accountId: 'account-b' }]]),
            activeServerId: 'local-profile-a',
            activeMachineRecords: [],
            machineRecordListsByServerId: {
                srv_server_b: [
                    machine({ id: 'online', active: true }),
                    machine({ id: 'offline' }),
                    machine({ id: 'revoked', revokedAt: 30 }),
                    machine({ id: 'replaced', replacedByMachineId: 'replacement' }),
                    machine({ id: 'locked', active: true, locked: true }),
                ],
            },
            nowMs: 100,
        });

        expect(candidates.map((candidate) => [candidate.target.machineId, candidate.availability])).toEqual([
            ['locked', 'locked'],
            ['offline', 'offline'],
            ['online', 'online'],
            ['replaced', 'replaced'],
            ['revoked', 'revoked'],
        ]);
        expect(candidates.every((candidate) => candidate.target.serverIdentityId === 'srv_server_b')).toBe(true);
    });

    it('never promotes a device-local profile without canonical server identity into Account candidates', () => {
        expect(buildMachineAdministrationCandidates({
            profiles: [{ ...profile, id: 'local-only', serverIdentityId: null }],
            activeServerId: 'local-only',
            activeMachineRecords: [machine({ id: 'machine-a', active: true })],
            machineRecordListsByServerId: {},
            nowMs: 100,
        })).toEqual([]);
    });

    it('does not project an ambiguous portable identity or merge duplicate machine ids across servers', () => {
        const otherProfile = {
            ...profile,
            id: 'local-profile-c',
            name: 'Server C',
            serverIdentityId: 'srv_server_c',
            legacyServerIds: [],
        };
        const candidates = buildMachineAdministrationCandidates({
            profiles: [profile, { ...profile, id: 'local-profile-b-duplicate' }, otherProfile],
            activeServerId: 'local-profile-a',
            activeMachineRecords: [],
            machineRecordListsByServerId: {
                srv_server_b: [machine({ id: 'machine-shared', active: true })],
                srv_server_c: [machine({ id: 'machine-shared', active: true })],
            },
            nowMs: 100,
        });

        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.target).toEqual({
            serverIdentityId: 'srv_server_c',
            machineId: 'machine-shared',
        });
    });

    it('treats a canonical identity claimed by another profile legacy alias as ambiguous', () => {
        const candidates = buildMachineAdministrationCandidates({
            profiles: [
                profile,
                {
                    ...profile,
                    id: 'local-profile-c',
                    name: 'Server C',
                    serverIdentityId: 'srv_server_c',
                    legacyServerIds: ['srv_server_b'],
                },
            ],
            activeServerId: 'local-profile-a',
            activeMachineRecords: [],
            machineRecordListsByServerId: {
                srv_server_b: [machine({ id: 'machine-b', active: true })],
                srv_server_c: [machine({ id: 'machine-c', active: true })],
            },
            nowMs: 100,
        });

        expect(candidates.map((candidate) => candidate.target.serverIdentityId)).toEqual(['srv_server_c']);
    });

    it('projects stale all-profile snapshots as non-authoritative tombstones with exact replacement identity', () => {
        const rows = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({
            snapshots: [{
                kind: 'resolved',
                profileId: 'local-profile-b',
                serverIdentityId: 'srv_server_b',
                serverName: 'Server B',
                observation: 'stale',
                machines: [{
                    id: 'machine-old',
                    updatedAt: 50,
                    active: true,
                    activeAt: 50,
                    revokedAt: null,
                    replacedByMachineId: 'machine-new',
                    replacedAt: 51,
                    metadataVersion: 1,
                    metadata: { displayName: 'Old machine' },
                }],
            }],
            nowMs: 50,
        });

        expect(rows).toEqual([expect.objectContaining({
            candidate: {
                target: { serverIdentityId: 'srv_server_b', machineId: 'machine-old' },
                displayName: 'Old machine',
                serverLabel: 'Server B',
                availability: 'replaced',
                observation: 'stale',
                observedAt: 50,
                replacementTarget: { serverIdentityId: 'srv_server_b', machineId: 'machine-new' },
            },
            serverId: 'local-profile-b',
        })]);
    });
});
