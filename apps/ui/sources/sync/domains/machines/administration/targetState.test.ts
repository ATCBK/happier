import { beforeEach, describe, expect, it } from 'vitest';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { adoptHomeProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { resolveAllProfileMachineInventorySnapshots } from '../machineInventorySnapshots';
import { t } from '@/text';
import {
    clearMachineRequestReachabilityForTest,
    recordMachineRequestFailed,
} from '@/sync/domains/machines/reachability/machineReachability';

import {
    buildMachineAdministrationCandidateInventoryRowsFromSnapshots,
    buildMachineAdministrationCandidatesFromSnapshots,
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

describe('snapshot Administration candidates', () => {
    it('uses the canonical inventory names in snapshot candidate projections', () => {
        const machines = [
            { ...machine({ id: 'aaaa-machine' }), metadata: { ...machine({ id: 'aaaa-machine' }).metadata!, displayName: 'Studio' } },
            { ...machine({ id: 'bbbb-machine' }), metadata: { ...machine({ id: 'bbbb-machine' }).metadata!, displayName: 'Studio' } },
            machine({ id: 'locked-machine', locked: true }),
            { ...machine({ id: 'unnamed-machine' }), metadata: null, availability: { kind: 'available' as const } },
        ];
        const snapshots = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots: [{
            kind: 'resolved', profileId: profile.id, accountId: 'account-b', serverIdentityId: profile.serverIdentityId!, serverName: 'Server B',
            observation: 'live', machines,
        }], nowMs: 100 });
        expect(snapshots.map(row => row.candidate.displayName)).toEqual([
            'Studio · aaaa', 'Studio · bbbb', t('machine.lockedMachine'), t('machine.unnamedMachine'),
        ]);
        // The two parts a one-line chip needs: the name may shorten, the telling suffix is what separates the twins.
        expect(snapshots.map(row => row.candidate.displayNameParts)).toEqual([
            { name: 'Studio', hint: 'aaaa' }, { name: 'Studio', hint: 'bbbb' },
            { name: t('machine.lockedMachine'), hint: null }, { name: t('machine.unnamedMachine'), hint: null },
        ]);
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
    it('keeps routing and tombstone facts from the canonical snapshot producer', () => {
        const machines = [
            machine({ id: 'online', active: true }),
            machine({ id: 'offline' }),
            machine({ id: 'revoked', revokedAt: 30 }),
            machine({ id: 'replaced', replacedByMachineId: 'replacement' }),
            machine({ id: 'locked', active: true, locked: true }),
        ];
        const snapshots = resolveAllProfileMachineInventorySnapshots({
            profiles: [profile], activeServerId: 'local-profile-a', activeMachines: [],
            machineListByServerId: { [profile.serverIdentityId!]: machines },
            machineListStatusByServerId: { [profile.serverIdentityId!]: 'idle' },
            accountScopesByServerId: new Map([[profile.serverIdentityId!, {
                serverId: profile.serverIdentityId!, accountId: 'account-b',
            }]]),
            loadWarmEntries: () => ({}),
        });
        const rows = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots, nowMs: 100 });
        const candidates = buildMachineAdministrationCandidatesFromSnapshots({ snapshots, nowMs: 100 });
        expect(candidates).toEqual(rows.map(row => row.candidate));
        expect(candidates.map(candidate => [candidate.target.machineId, candidate.availability])).toEqual([
            ['locked', 'locked'], ['offline', 'offline'], ['online', 'online'],
            ['replaced', 'replaced'], ['revoked', 'revoked'],
        ]);
        expect(rows.every(row => row.serverId === profile.id
            && row.serverName === 'Server B'
            && row.candidate.target.serverIdentityId === 'srv_server_b'
            && row.machine.id === row.candidate.target.machineId)).toBe(true);
    });

    it('projects stale all-profile snapshots as non-authoritative tombstones with exact replacement identity', () => {
        const rows = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({
            snapshots: [{
                kind: 'resolved',
                profileId: 'local-profile-b',
                accountId: 'account-b',
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
                displayNameParts: { name: 'Old machine', hint: null },
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
