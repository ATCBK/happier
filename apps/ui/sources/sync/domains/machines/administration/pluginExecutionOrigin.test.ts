import { afterEach, describe, expect, it } from 'vitest';

import {
    buildPluginMachineExecutionOriginCandidates,
    buildPluginMachineSourceExecutionOriginCandidates,
    combinePluginMachineExecutionOriginCandidates,
    composePluginMachineExecutionOriginV1,
    resolvePluginMachineExecutionOriginState,
    type PluginMachineExecutionOriginCandidateV1,
} from './pluginExecutionOrigin';
import { resolveFleetMachineRejection } from './fleetUnion';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/machineInventorySnapshots';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { parseToken } from '@/utils/auth/parseToken';

const accountId = parseToken(createAccountTokenForTests('plugin-owner'));
afterEach(clearMachineRequestReachabilityForTest);

function candidate(input: Readonly<{
    serverIdentityId: string;
    machineId: string;
    materializationId: string;
    pluginId?: string;
    version?: string;
    releaseContent?: PluginMachineExecutionOriginCandidateV1['releaseContent'];
    validation?: PluginMachineExecutionOriginCandidateV1['validation'];
    sourceClass?: PluginMachineExecutionOriginCandidateV1['materialization']['sourceClass'];
}>): PluginMachineExecutionOriginCandidateV1 {
    return {
        materialization: {
            serverIdentityId: input.serverIdentityId,
            machineId: input.machineId,
            materializationId: input.materializationId,
            pluginId: input.pluginId ?? 'acme.plugin',
            version: input.version ?? '1.0.0',
            sourceClass: input.sourceClass ?? 'registryPackage',
            portableRelease: input.sourceClass !== 'localPath',
            uiArtifacts: [],
            enabled: true,
            trustState: 'trusted',
            observedAt: 100,
        },
        releaseContent: input.releaseContent ?? 'matched',
        validation: input.validation ?? { kind: 'admitted' },
    };
}

describe('resolvePluginMachineExecutionOriginState', () => {
    it('uses only the local Home for an unpinned operation', () => {
        const local = candidate({ serverIdentityId: 'srv_one', machineId: 'local', materializationId: 'local-custody' });
        const foreign = candidate({ serverIdentityId: 'srv_two', machineId: 'foreign', materializationId: 'foreign-custody' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            homeServerIdentityId: 'srv_one', candidates: [foreign] })).toMatchObject({ kind: 'unavailable' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            homeServerIdentityId: 'srv_one', candidates: [foreign, local], declaredDefaultOrigins: [composePluginMachineExecutionOriginV1(foreign.materialization)] }))
            .toMatchObject({ kind: 'selected', origin: composePluginMachineExecutionOriginV1(local.materialization), selectionSource: 'soleCandidate' });
    });
    it('keeps an offline explicit Machine pinned while resolving replacement custody on that Machine', () => {
        const own = candidate({ serverIdentityId: 'srv_one', machineId: 'pinned-machine', materializationId: 'new-custody' });
        const other = candidate({ serverIdentityId: 'srv_one', machineId: 'online-machine', materializationId: 'other' });
        const storedTarget = { serverIdentityId: 'srv_one', machineId: 'pinned-machine' };
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null, storedTarget,
            candidates: [own, other] })).toMatchObject({ kind: 'selected', origin: composePluginMachineExecutionOriginV1(own.materialization) });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null, storedTarget,
            candidates: [{ ...own, validation: { kind: 'rejected', reason: 'offline' } }, other] }))
            .toMatchObject({ kind: 'unavailable', storedTarget, reasons: ['offline'] });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null, storedTarget,
            candidates: [other], storedOriginMachinePresence: 'offline' }))
            .toMatchObject({ kind: 'unavailable', storedTarget, reasons: ['offline'] });
    });
    it('defaults a contextual Session panel to its exact machine rather than an unrelated saved offline origin', () => {
        const own = candidate({ serverIdentityId: 'srv_one', machineId: 'session-machine', materializationId: 'own' });
        const other = candidate({ serverIdentityId: 'srv_one', machineId: 'unrelated-machine', materializationId: 'other',
            validation: { kind: 'rejected', reason: 'offline' } });
        const saved = { serverIdentityId: 'srv_one', materializationRef: { pluginId: 'acme.plugin', machineId: 'unrelated-machine', materializationId: 'other' } };
        const sameIdElsewhere = candidate({ serverIdentityId: 'srv_two', machineId: 'session-machine', materializationId: 'elsewhere' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: saved, candidates: [own, other, sameIdElsewhere],
            contextualTarget: { serverIdentityId: 'srv_one', machineId: 'session-machine' } })).toMatchObject({
            kind: 'selected', origin: { materializationRef: { machineId: 'session-machine' } },
        });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: saved, candidates: [other],
            contextualTarget: { serverIdentityId: 'srv_one', machineId: 'session-machine' } })).toMatchObject({ kind: 'unavailable' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null, candidates: [own],
            contextualTarget: null })).toMatchObject({ kind: 'unavailable' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: saved, candidates: [own, other] }))
            .toMatchObject({ kind: 'unavailable', storedOrigin: saved });
    });
    it('does not count a nonselectable machine-local census as a fleet version disagreement', () => {
        const current = candidate({ serverIdentityId: 'srv_one', machineId: 'current-machine', materializationId: 'current', version: '2.0.0' });
        const local = candidate({ serverIdentityId: 'srv_one', machineId: 'local-machine', materializationId: 'local',
            version: '1.0.0', sourceClass: 'localPath' });
        const state = resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [current, local] });
        // The Artifact/source-custody refusal remains diagnostic; it is not a
        // disagreement between two selectable execution origins.
        expect(state).toMatchObject({ kind: 'conflict', reasons: ['machine_local'] });
    });
    it('keeps source and release selection aligned with server-scoped reachability and retry recovery', () => {
        const machineId = 'plugin-reachability-machine';
        const serverId = 'plugin-reachability-home';
        const materialization = candidate({ serverIdentityId: 'srv_reachability', machineId, materializationId: 'reachability-mat' }).materialization;
        const source = { source: { origin: { serverIdentityId: 'srv_reachability', sourceRef: { machineId,
            pluginId: 'acme.plugin', sourceCustody: { kind: 'development', registeredRootId: 'reachability-root' } } },
            version: '1.0.0', occurrenceId: 'reachability-occurrence', serverId, generation: 1 },
            releaseContent: 'matched', validation: { kind: 'admitted' } } as const;
        const machineSnapshots = [{ kind: 'resolved', accountId, profileId: serverId, serverIdentityId: 'srv_reachability',
            serverName: 'Studio', observation: 'live', machines: [{ id: machineId, updatedAt: 1, active: true,
                activeAt: Date.now(), revokedAt: null, metadataVersion: 1, metadata: null }] }] as const;
        const readCandidates = () => [
            ...buildPluginMachineExecutionOriginCandidates({ pluginId: 'acme.plugin', materializations: [materialization],
                machineSnapshots, classifyRelease: () => ({ releaseContent: 'matched', validation: { kind: 'admitted' } }) }),
            ...buildPluginMachineSourceExecutionOriginCandidates({ pluginId: 'acme.plugin', sources: [source], machineSnapshots }),
        ];
        const readSelection = () => resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin',
            storedOrigin: source.source.origin, candidates: readCandidates() });
        const scope = { serverId: 'srv_reachability', accountId };
        recordMachineRequestFailed({ serverId: 'another-home', accountId, machineId, observedAtMs: 1 });
        recordMachineRequestFailed({ ...scope, accountId: 'another-account', machineId, observedAtMs: 1 });
        expect(readSelection()).toMatchObject({ kind: 'selected', origin: source.source.origin });
        recordMachineRequestFailed({ ...scope, machineId, observedAtMs: 2 });
        expect(readCandidates().map(entry => entry.validation)).toEqual([
            { kind: 'rejected', reason: 'home_unreachable' }, { kind: 'rejected', reason: 'home_unreachable' },
        ]);
        expect(readSelection()).toMatchObject({ kind: 'unavailable', storedOrigin: source.source.origin, reasons: ['home_unreachable'] });
        recordMachineRequestSucceeded({ ...scope, machineId, observedAtMs: 3 });
        expect(readSelection()).toMatchObject({ kind: 'selected', origin: source.source.origin });
    });
    it('coalesces only a machine-local census with its supplying source, not other Homes or exact sources', () => {
        const origin = { serverIdentityId: 'srv_one', sourceRef: { machineId: 'machine-a', pluginId: 'acme.plugin',
            sourceCustody: { kind: 'development', registeredRootId: 'source-a' } } } as const;
        const source = { source: { origin, version: '1.0.0', occurrenceId: 'source-a', serverId: 'local-one', generation: 1 },
            releaseContent: 'matched', validation: { kind: 'rejected', reason: 'offline' } } as const;
        const alternate = { ...source, source: { ...source.source, origin: { ...origin,
            sourceRef: { ...origin.sourceRef, sourceCustody: { kind: 'development', registeredRootId: 'source-b' } } } } } as const;
        const census = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'local-a', sourceClass: 'localPath' });
        const otherHome = candidate({ serverIdentityId: 'srv_two', machineId: 'machine-a', materializationId: 'local-a', sourceClass: 'localPath' });
        const portable = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'portable-a' });
        expect(combinePluginMachineExecutionOriginCandidates([census, otherHome, portable], [source, alternate]))
            .toEqual([otherHome, portable, source, alternate]);
        expect(combinePluginMachineExecutionOriginCandidates([census], [])).toEqual([census]);
    });
    it('selects an exact admitted source and preserves an unavailable saved source', () => {
        const origin = { serverIdentityId: 'srv_one', sourceRef: { machineId: 'machine-a', pluginId: 'acme.plugin',
            sourceCustody: { kind: 'development', registeredRootId: 'registered-source-a' } } } as const;
        const sourceCandidate = { source: { origin, version: '1.0.0', occurrenceId: 'occurrence-a',
            serverId: 'local-one', generation: 1 }, releaseContent: 'matched', validation: { kind: 'admitted' } } as const;
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [sourceCandidate] })).toMatchObject({ kind: 'selected', origin, selectionSource: 'soleCandidate' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin,
            candidates: [{ ...sourceCandidate, validation: { kind: 'rejected', reason: 'offline' } }] }))
            .toMatchObject({ kind: 'unavailable', storedOrigin: origin, reasons: ['offline'] });
        const replacement = { ...sourceCandidate, source: { ...sourceCandidate.source, origin: { ...origin,
            sourceRef: { ...origin.sourceRef, sourceCustody: { kind: 'development', registeredRootId: 'replacement-source' } } } } } as const;
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin,
            candidates: [replacement] })).toMatchObject({ kind: 'unavailable', reasons: ['missing'] });
    });
    it('uses an admitted plugin default after explicit preference and before sole selection', () => {
        const a = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });
        const b = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'mat-b' });
        const origin = (entry: typeof a) => ({ serverIdentityId: entry.materialization.serverIdentityId,
            materializationRef: { machineId: entry.materialization.machineId, materializationId: entry.materialization.materializationId, pluginId: 'acme.plugin' } });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [a, b], declaredDefaultOrigins: [origin(b)] })).toMatchObject({ kind: 'selected', origin: origin(b), selectionSource: 'pluginDefault' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [{ ...a, releaseContent: 'unknown' }, b], declaredDefaultOrigins: [origin(b)] }))
            .toMatchObject({ kind: 'selected', origin: origin(b), selectionSource: 'pluginDefault' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin(a),
            candidates: [a, b], declaredDefaultOrigins: [origin(b)] })).toMatchObject({ kind: 'selected', origin: origin(a), selectionSource: 'stored' });
        const offline = { ...a, validation: { kind: 'rejected', reason: 'offline' } } as const;
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin(a),
            candidates: [offline, b], declaredDefaultOrigins: [origin(b)] })).toMatchObject({ kind: 'unavailable', reasons: ['offline'] });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [a, b], declaredDefaultOrigins: [origin(a), origin(b)] }).kind).toBe('selectionRequired');
        const replacement = { ...b, materialization: { ...b.materialization, machineId: a.materialization.machineId } };
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            storedTarget: { serverIdentityId: 'srv_one', machineId: 'machine-a' },
            candidates: [a, replacement], declaredDefaultOrigins: [origin(replacement)] }))
            .toMatchObject({ kind: 'selected', origin: origin(replacement), selectionSource: 'stored' });
    });
    it('composes uncollapsed Availability rows with exact machine state and Artifact-owned release validation', () => {
        const materialization = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
        }).materialization;
        const candidates = buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [materialization],
            machineSnapshots: [{
                kind: 'resolved',
                accountId,
                profileId: 'local-one',
                serverIdentityId: 'srv_one',
                serverName: 'Server One',
                observation: 'live',
                machines: [{
                    id: 'machine-a',
                    updatedAt: 100,
                    active: true,
                    activeAt: Date.now(),
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: null,
                }],
            }],
            classifyRelease: () => ({
                releaseContent: 'matched',
                validation: { kind: 'admitted' },
            }),
        });

        expect(candidates).toEqual([{
            materialization,
            releaseContent: 'matched',
            validation: { kind: 'admitted' },
        }]);
    });

    it('keeps the candidate set scoped to the requested plugin before presentation', () => {
        const own = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-own',
        }).materialization;
        const foreign = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-foreign',
            pluginId: 'other.plugin',
        }).materialization;
        const input = {
            pluginId: 'acme.plugin',
            materializations: [foreign, own],
            machineSnapshots: [{
                kind: 'resolved' as const,
                accountId,
                profileId: 'local-one',
                serverIdentityId: 'srv_one',
                serverName: 'Server One',
                observation: 'live' as const,
                machines: [{
                    id: 'machine-a',
                    updatedAt: 100,
                    active: true,
                    activeAt: Date.now(),
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: null,
                }],
            }],
            classifyRelease: () => ({
                releaseContent: 'matched' as const,
                validation: { kind: 'admitted' as const },
            }),
        };

        expect(buildPluginMachineExecutionOriginCandidates(input).map((entry) => entry.materialization.pluginId))
            .toEqual(['acme.plugin']);
    });

    it('fails stale, replaced, revoked, disabled, and untrusted Availability rows closed before selection', () => {
        const base = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
        }).materialization;
        const classifyRelease = () => ({
            releaseContent: 'matched' as const,
            validation: { kind: 'admitted' as const },
        });
        const machineSnapshot = (machine: Readonly<{
            replacedByMachineId?: string;
            revokedAt?: number;
        }>, observation: 'live' | 'stale' = 'live') => [{
            kind: 'resolved' as const,
            accountId,
            profileId: 'local-one',
            serverIdentityId: 'srv_one',
            serverName: 'Server One',
            observation,
            machines: [{
                id: 'machine-a',
                updatedAt: 100,
                active: true,
                activeAt: Date.now(),
                revokedAt: machine.revokedAt ?? null,
                replacedByMachineId: machine.replacedByMachineId ?? null,
                metadataVersion: 1,
                metadata: null,
            }],
        }];

        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: machineSnapshot({}, 'stale'),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'stale' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: machineSnapshot({ replacedByMachineId: 'machine-b' }),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'replaced' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: machineSnapshot({ revokedAt: 100 }),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'revoked' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [{ ...base, enabled: false }],
            machineSnapshots: machineSnapshot({}),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'disabled' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [{ ...base, trustState: 'untrusted' }],
            machineSnapshots: machineSnapshot({}),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'untrusted' });
    });

    it('keeps a stored origin selected through its Home\'s machine-list refresh and fails it closed once the read failed', () => {
        const base = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' }).materialization;
        const stored = composePluginMachineExecutionOriginV1(base);
        const row: Machine = { id: 'machine-a', seq: 1, createdAt: 1, updatedAt: 20, active: true, activeAt: Date.now(), revokedAt: null,
            replacedByMachineId: null, metadata: null, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
        const profile = { id: 'local-one', name: 'Server One', serverUrl: 'https://one.example.test', serverIdentityId: 'srv_one',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
        const stateWhen = (status: 'idle' | 'loading' | 'error') => resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin', storedOrigin: stored,
            candidates: buildPluginMachineExecutionOriginCandidates({
                pluginId: 'acme.plugin', materializations: [base],
                classifyRelease: () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }),
                machineSnapshots: resolveAllProfileMachineInventorySnapshots({
                    profiles: [profile], activeServerId: 'local-one', activeMachines: [row],
                    machineListByServerId: { 'local-one': [row] }, machineListStatusByServerId: { 'local-one': status },
                    accountScopesByServerId: new Map([['srv_one', { serverId: 'srv_one', accountId }]]), loadWarmEntries: () => ({}),
                }),
            }),
        });
        expect(stateWhen('idle')).toMatchObject({ kind: 'selected' });
        expect(stateWhen('loading')).toMatchObject({ kind: 'selected' });
        expect(stateWhen('error')).toMatchObject({ kind: 'unavailable', reasons: ['stale'] });
    });

    it('does not call a materialization\'s machine missing while its Home\'s machine list is unread', () => {
        const base = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' }).materialization;
        const classifyRelease = () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } });
        const unread = [{ kind: 'unknown' as const, profileId: 'local-one', serverIdentityId: 'srv_one', serverName: 'Server One', machines: [] }];
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: unread,
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'unknown' });
        // A read list that lacks the machine: now it has really left.
        const read = [{ kind: 'resolved' as const, accountId, profileId: 'local-one', serverIdentityId: 'srv_one', serverName: 'Server One', observation: 'live' as const, settled: true as const, machines: [] }];
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: read,
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'missing' });
    });

    it('does not infer executable installation from a bundled plugin identity', () => {
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'happier.claude',
            storedOrigin: null,
            candidates: [],
        })).toEqual({ kind: 'unavailable', storedOrigin: null, candidates: [], reasons: ['no_materialization'] });
    });

    it('reports unavailable for zero candidates and structurally selects the sole admitted origin', () => {
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [],
        })).toEqual({ kind: 'unavailable', storedOrigin: null, candidates: [], reasons: ['no_materialization'] });

        const only = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [only],
        })).toEqual({
            kind: 'selected',
            origin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidate: only,
            selectionSource: 'soleCandidate',
        });
    });

    it('requires explicit choice between matching replicas and is stable under input permutation', () => {
        const machineA = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });
        const machineB = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'mat-b' });

        const first = resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [machineB, machineA],
        });
        const reordered = resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [machineA, machineB],
        });

        expect(first).toEqual({ kind: 'selectionRequired', candidates: [machineA, machineB] });
        expect(reordered).toEqual(first);
    });

    it('fails closed for divergent versions, conflicting content, and machine-local rows', () => {
        const base = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });
        const divergent = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
            version: '2.0.0',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [base, divergent],
        }).kind).toBe('conflict');

        const contentConflict = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
            releaseContent: 'conflict',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [base, contentConflict],
        }).kind).toBe('conflict');

        const local = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-local',
            sourceClass: 'localPath',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [base, local],
        }).kind).toBe('conflict');
    });

    it('retains an unavailable stored origin and never roams to another admitted replica', () => {
        const old = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            validation: { kind: 'rejected', reason: 'offline' },
        });
        const replacement = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [replacement, old],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [old, replacement],
            reasons: ['offline'],
        });
    });

    it('names an offline machine, not a missing source, when the stored source left with its machine', () => {
        // Live 2026-10-16 (PLUGVIS 2h): PRs & Issues pinned to an offline machine said "Its source isn't
        // available" — an offline machine stops advertising its sources, so the stored source had no candidate.
        const machineId = 'pinned-offline-machine';
        const origin = { serverIdentityId: 'srv_pinned', sourceRef: { machineId, pluginId: 'acme.plugin',
            sourceCustody: { kind: 'development', registeredRootId: 'pinned-root' } } } as const;
        const snapshotWith = (activeAt: number, machines = [{ id: machineId, updatedAt: 1, active: activeAt > 0,
            activeAt, revokedAt: null, metadataVersion: 1, metadata: null }]) => [{ kind: 'resolved', accountId,
            profileId: 'pinned-home', serverIdentityId: 'srv_pinned', serverName: 'Studio', observation: 'live',
            settled: true, machines }] as const;
        const stateWith = (machineSnapshots: ReturnType<typeof snapshotWith>) => resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin', storedOrigin: origin, candidates: [],
            storedOriginMachinePresence: resolveFleetMachineRejection({ serverIdentityId: 'srv_pinned', machineId, machineSnapshots }) });
        recordMachineRequestFailed({ serverId: 'srv_pinned', accountId, machineId, observedAtMs: 2 });
        expect(stateWith(snapshotWith(0))).toMatchObject({ kind: 'unavailable', storedOrigin: origin, reasons: ['home_unreachable'] });
        // The machine itself is gone from its Home: the source is missing, not offline.
        expect(stateWith(snapshotWith(0, []))).toMatchObject({ kind: 'unavailable', reasons: ['missing'] });
        // An online machine that no longer offers the stored source keeps blaming the source.
        recordMachineRequestSucceeded({ serverId: 'srv_pinned', accountId, machineId, observedAtMs: 3 });
        expect(stateWith(snapshotWith(Date.now()))).toMatchObject({ kind: 'unavailable', reasons: ['missing'] });
    });

    it('reports a vanished install epoch as missing instead of relocating to a healthy replica', () => {
        // Reinstalling mints a new installation epoch, so the stored epoch can
        // disappear while another admitted replica is present. Relocating there
        // silently would move execution to a machine the user never chose.
        const replacement = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
        });
        const storedOrigin = {
            serverIdentityId: 'srv_one',
            materializationRef: {
                machineId: 'machine-a',
                materializationId: 'mat-a-retired',
                pluginId: 'acme.plugin',
            },
        } as const;

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin,
            candidates: [replacement],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin,
            candidates: [replacement],
            reasons: ['missing'],
        });

        // Positive twin: once the stored epoch is reported again it is selected,
        // so the result above is the no-relocation rule and not a dead branch.
        const restored = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a-retired',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin,
            candidates: [replacement, restored],
        })).toMatchObject({
            kind: 'selected',
            origin: storedOrigin,
            selectionSource: 'stored',
        });
    });

    it('rejects a stored origin for another plugin instead of borrowing it', () => {
        const current = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'other.plugin',
                },
            },
            candidates: [current],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: expect.objectContaining({
                materializationRef: expect.objectContaining({ pluginId: 'other.plugin' }),
            }),
            candidates: [current],
            reasons: ['plugin_mismatch'],
        });
    });

    it('withholds a stored origin when release facts conflict even if a validator is accidentally permissive', () => {
        const conflicting = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            releaseContent: 'conflict',
            validation: { kind: 'admitted' },
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [conflicting],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: expect.any(Object),
            candidates: [conflicting],
            reasons: ['content_conflict'],
        });
    });

    it('does not misreport an unknown stored release fact as a proven content conflict', () => {
        const unknown = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            releaseContent: 'unknown',
            validation: { kind: 'admitted' },
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [unknown],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: expect.any(Object),
            candidates: [unknown],
            reasons: ['unknown'],
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [unknown],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: null,
            candidates: [unknown],
            reasons: ['unknown'],
        });
    });
});
