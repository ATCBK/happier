import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';

import { getPluginMachineExecutionOriginRef, type PluginMachineMaterializationV1 } from '@happier-dev/protocol';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary, type SessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import {
    clearPluginAccountAvailabilityProjection,
    replacePluginAccountAvailabilityProjection,
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { useIsMachineListSettled, useMachineListStatusForServer } from '@/sync/store/hooks';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';

import { usePluginMachineExecutionOriginSelection } from './usePluginExecutionOriginSelection';
import { getPluginExecutionOriginCandidateOrigin } from './pluginExecutionOrigin';
import * as executionOrigin from './pluginExecutionOrigin';
import { resolveFreshMachineAdministrationExecutionTarget } from './useTargetSelection';

// React is the third-party SDK boundary. Spy-only instrumentation runs its real hooks.
vi.mock('react', { spy: true });
// Keep the SDK, Sync and Account owners real; this fixture opens no external socket.
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const FIXTURE_ACCOUNT_ID = 'account-machine-origin-fixture';
let network: SessionOpsNetworkBoundary;

describe('execution-origin plugin identity with real Account and machine owners', () => {
    beforeEach(async () => {
        network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://inventory-readiness.example.test', FIXTURE_ACCOUNT_ID);
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        storage.setState({ ...storage.getInitialState(), profileScope: scope, settingsScope: scope }, true);
    });
    afterEach(async () => {
        await standardCleanup();
        clearPluginAccountAvailabilityProjection();
        await network.dispose();
        publishAppliedActiveServerRuntimeAvailability(false);
        vi.restoreAllMocks();
    });

    it('does not let an older settled Home alias replace the canonical pending Machine read', async () => {
        const serverIdentityId = 'srv_pending_inventory_alias';
        const url = 'https://pending-inventory-alias.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        const machine = createMachineFixture({ id: 'pending-alias-machine' });
        const previous = storage.getState();
        try {
            storage.setState({ machineListByServerId: { [serverIdentityId]: [machine], [home.id]: [machine] },
                machineListStatusByServerId: { [serverIdentityId]: 'loading', [home.id]: 'idle' } });
            const hook = await renderHook(() => ({ settled: useIsMachineListSettled(home.id), status: useMachineListStatusForServer(home.id) }));
            expect(hook.getCurrent()).toEqual({ settled: false, status: 'loading' });
            await act(async () => { storage.setState({ machineListStatusByServerId: {
                [serverIdentityId]: 'error', [home.id]: 'idle',
            } }); });
            expect(hook.getCurrent()).toEqual({ settled: false, status: 'error' });
            await act(async () => { storage.setState({ machineListStatusByServerId: {
                [serverIdentityId]: 'idle', [home.id]: 'idle',
            } }); });
            expect(hook.getCurrent()).toEqual({ settled: true, status: 'idle' });
            await act(async () => { storage.setState({ machineListByServerId: {}, machineListStatusByServerId: {} }); });
            expect(hook.getCurrent()).toEqual({ settled: false, status: 'loading' });
            await hook.unmount();
        } finally { storage.setState(previous); }
    });

    it('admits active machine inventory from its own read status independently of core readiness', async () => {
        const serverIdentityId = 'srv_inventory_readiness';
        const url = 'https://inventory-readiness.example.test';
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'inventory-readiness-machine', active: true, activeAt: Date.now() });
        storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
        const hook = await renderHook(() => useAllProfileMachineInventorySnapshots());
        const snapshot = () => hook.getCurrent().find(row => row.kind !== 'missingIdentity' && row.serverIdentityId === serverIdentityId);
        expect(snapshot()).toMatchObject({ kind: 'unknown', inventoryStatus: 'loading' });
        await act(async () => { storage.setState({ machineListByServerId: { [home.id]: [] },
            machineListStatusByServerId: { [home.id]: 'idle' } }); });
        expect(snapshot()).toMatchObject({ kind: 'resolved', settled: true, machines: [] });
        for (const status of ['loading', 'error', 'signedOut'] as const) {
            await act(async () => { storage.setState({ machines: { [machine.id]: machine },
                machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: status } }); });
            expect(snapshot()).toMatchObject({ inventoryStatus: status,
                machines: [expect.objectContaining({ id: machine.id })], executionEligibleMachineIds: [] });
            expect(snapshot()).not.toHaveProperty('settled');
            expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId, machineId: machine.id })).toBeNull();
        }
        await act(async () => { storage.setState({ isDataReady: false, machineListStatusByServerId: { [home.id]: 'idle' } }); });
        expect(snapshot()).toMatchObject({ settled: true, executionEligibleMachineIds: [machine.id] });
        expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId, machineId: machine.id })?.machine).toBe(machine);
        await hook.unmount();
    });

    it('offers a daemon-selected source once without dropping a distinct portable installation', async () => {
        const serverIdentityId = 'srv_source_inventory';
        const url = 'https://source-inventory.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'machine-source', active: true, activeAt: Date.now() });
        storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        const pluginId = 'acme.source';
        const report: PluginMachineMaterializationV1 = { serverIdentityId, machineId: machine.id,
            materializationId: `daemon-selected:${pluginId}`, pluginId, version: '0.0.0', sourceClass: 'localPath',
            portableRelease: false, enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [] };
        const portable = { ...report, materializationId: 'portable-installation', portableRelease: true,
            sourceClass: 'registryPackage' as const };
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [report, portable], snapshots: [],
        } });
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' } } };
        const source = { origin, version: '0.0.0', occurrenceId: 'source-occurrence', generation: 1, serverId: home.id };
        const sources = [{ source, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId,
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: sources }));
        expect(hook.getCurrent().candidates.map(getPluginExecutionOriginCandidateOrigin)).toEqual([
            { serverIdentityId, materializationRef: { machineId: machine.id, materializationId: portable.materializationId, pluginId } },
            origin,
        ]);
        expect(hook.getCurrent().resolveExecutionOrigin()?.source).toEqual(source);
        await hook.unmount();
    });

    it('resolves a sole source afresh and withdraws execution on source retirement or Account change', async () => {
        const serverIdentityId = 'srv_source_execution';
        const url = 'https://source-execution.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'machine-source', active: true, activeAt: Date.now() });
        storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId: 'acme.source',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' } } };
        const source = { origin, version: '1.0.0', occurrenceId: 'source-occurrence', generation: 1, serverId: home.id };
        const candidates = [{ source, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        let currentSources: typeof candidates = candidates;
        let currentDefaults = [origin];
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: 'acme.source',
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates,
            readSourceCandidates: () => currentSources, declaredDefaultOrigins: [origin],
            readDeclaredDefaultOrigins: () => currentDefaults }));
        expect(hook.getCurrent().selectedOrigin).toEqual(origin);
        expect(hook.getCurrent().machineCandidates).toEqual(expect.arrayContaining([
            expect.objectContaining({ target: { serverIdentityId, machineId: machine.id }, availability: 'online' }),
        ]));
        expect(hook.getCurrent().resolveExecutionOrigin()?.source).toEqual(source);
        const alternate = { ...candidates[0]!, source: { ...source, origin: { ...origin,
            sourceRef: { ...origin.sourceRef, sourceCustody: { kind: 'development' as const, registeredRootId: 'alternate-source-root' } } } } };
        currentSources = [...candidates, alternate];
        currentDefaults = [];
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        currentSources = [];
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        currentSources = candidates;
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: {
                v: 1, pluginExecutionOriginsByPluginId: { 'acme.source': origin },
            } } });
        });
        const machineFree = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: 'acme.source',
            enabled: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates }));
        expect(machineFree.getCurrent()).toMatchObject({ candidates: [], machineCandidates: [], selectedOrigin: null,
            canExecute: false, state: { kind: 'selectionRequired', candidates: [] } });
        expect(machineFree.getCurrent().resolveExecutionOrigin()).toBeNull();
        await expect(machineFree.getCurrent().selectOrigin(origin)).resolves.toEqual({ status: 'unavailable' });
        await expect(machineFree.getCurrent().clearOrigin()).resolves.toEqual({ status: 'unavailable' });
        await machineFree.unmount();
        const incumbentResolve = hook.getCurrent().resolveExecutionOrigin;
        currentSources = [];
        await act(async () => { storage.setState({ settingsScope: { ...scope, accountId: 'account-switched' } }); });
        expect(incumbentResolve()).toBeNull();
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        await hook.unmount();
    });

    it('retains selection work across machine presentation updates while observing fresh eligibility and invocation data', async () => {
        // Observe the real expensive derivation; do not replace its implementation.
        const serializeFacts = vi.spyOn(executionOrigin, 'serializePluginMachineExecutionOriginMachineFacts');
        const serverIdentityId = 'srv_origin_presence';
        const url = 'https://origin-presence.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'machine-origin-presence', active: true, activeAt: Date.now(), updatedAt: 10 });
        machine.metadata = { ...machine.metadata!, displayName: 'Before' };
        storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId: 'acme.presence',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'presence-root' } } };
        const source = { origin, version: '1.0.0', occurrenceId: 'presence-occurrence', generation: 1, serverId: home.id };
        const candidates = [{ source, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        const defaults = [origin];
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return usePluginMachineExecutionOriginSelection({ pluginId: 'acme.presence',
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates,
            declaredDefaultOrigins: defaults, includeMachineCandidates: false });
        });
        const initial = hook.getCurrent();
        expect(initial.canExecute).toBe(true);
        expect(initial.resolveExecutionOrigin()?.machineTarget.machine).toBe(machine);

        const initialSerializations = serializeFacts.mock.calls.length;
        for (let version = 1; version <= 100; version += 1) {
            await act(async () => { storage.setState({ settingsVersion: version }); });
        }
        const redundantSerializations = serializeFacts.mock.calls.length - initialSerializations;
        console.info('execution-origin unchanged inventory: 100 settings-version updates, fact serializations =', redundantSerializations);
        expect(redundantSerializations).toBe(0);
        expect(hook.getCurrent().candidates).toBe(initial.candidates);
        expect(hook.getCurrent().canExecute).toBe(true);
        const settledRenders = renders;

        const refreshed = { ...machine, activeAt: Date.now(), updatedAt: 11,
            metadata: { ...machine.metadata!, displayName: 'After' } };
        await act(async () => { storage.setState({ machineListByServerId: { [home.id]: [refreshed] } }); });
        expect(renders).toBe(settledRenders);
        expect(hook.getCurrent().machineCandidates).toEqual([]);
        expect(hook.getCurrent().candidates).toBe(initial.candidates);
        expect(hook.getCurrent().state).toBe(initial.state);
        expect(hook.getCurrent().canExecute).toBe(true);
        expect(initial.resolveExecutionOrigin()?.machineTarget.machine).toBe(refreshed);

        const expiresAtMs = readMachineStatusNextRefreshAtMs(refreshed, Date.now());
        expect(expiresAtMs).not.toBeNull();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAtMs!);
        await act(async () => { storage.setState({ settingsVersion: 101 }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['offline'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        expect(initial.resolveExecutionOrigin()).toBeNull();
        clock.mockRestore();
        await act(async () => { storage.setState({ settingsVersion: 102 }); });
        expect(hook.getCurrent().canExecute).toBe(true);

        await act(async () => { storage.setState({ machineListByServerId: { [home.id]: [{ ...refreshed,
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } }] } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['unknown'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        expect(initial.resolveExecutionOrigin()).toBeNull();
        for (const [changed, reason] of [
            [{ ...refreshed, revokedAt: Date.now() }, 'revoked'],
            [{ ...refreshed, replacedByMachineId: 'replacement' }, 'replaced'],
        ] as const) {
            await act(async () => { storage.setState({ machineListByServerId: { [home.id]: [changed] } }); });
            expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: [reason] });
            expect(hook.getCurrent().canExecute).toBe(false);
            expect(initial.resolveExecutionOrigin()).toBeNull();
        }
        await act(async () => { storage.setState({ machineListByServerId: { [home.id]: [{ ...refreshed, active: false, activeAt: 0 }] } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['offline'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        await act(async () => { storage.setState({ machineListByServerId: { [home.id]: [refreshed] } }); });
        expect(hook.getCurrent().canExecute).toBe(true);
        await act(async () => { storage.setState({ machineListStatusByServerId: { [home.id]: 'error' } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['stale'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        expect(initial.resolveExecutionOrigin()).toBeNull();
        await act(async () => { storage.setState({ machineListStatusByServerId: { [home.id]: 'idle' } }); });
        expect(hook.getCurrent().canExecute).toBe(true);
        await act(async () => { storage.setState({ machineListByServerId: { [home.id]: [] } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['missing'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        expect(initial.resolveExecutionOrigin()).toBeNull();
        await act(async () => { storage.setState({ machineListStatusByServerId: { [home.id]: 'loading' } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['unknown'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        expect(initial.resolveExecutionOrigin()).toBeNull();
        await hook.unmount();
    });

    it('recomputes candidates and reasons on A-to-B-to-A without refreshing stable inputs', async () => {
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: FIXTURE_ACCOUNT_ID };
        storage.setState({ profileScope: scope });
        const materializationA: PluginMachineMaterializationV1 = {
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            pluginId: 'acme.plugin-a',
            version: '1.0.0',
            sourceClass: 'registryPackage',
            portableRelease: true,
            uiArtifacts: [],
            enabled: false,
            trustState: 'trusted',
            observedAt: 100,
        };
        const materializationB: PluginMachineMaterializationV1 = {
            ...materializationA,
            pluginId: 'acme.plugin-b',
            materializationId: 'mat-b',
            enabled: true,
            trustState: 'revoked',
        };
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: {
                availabilityCursor: 1,
                intentReads: [],
                materializations: [materializationA, materializationB],
                snapshots: [],
            },
        });

        // No internal mocks: native persistence adapters come from the standard
        // Vitest harness; the projection, classifier, inventory and selection run real.
        const hook = await renderHook(({ pluginId }: { pluginId: string }) => {
            const reader = useActivePluginAccountAvailabilityReader();
            const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
            const machineSnapshots = useAllProfileMachineInventorySnapshots();
            return {
                reader,
                classifyRelease,
                machineSnapshots,
                selection: usePluginMachineExecutionOriginSelection({ pluginId, classifyRelease }),
            };
        }, { initialProps: { pluginId: materializationA.pluginId } });

        const initial = hook.getCurrent();
        expect(initial.reader).not.toBeNull();
        expect(initial.selection.candidates.map((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).pluginId))
            .toEqual([materializationA.pluginId]);
        expect(initial.selection.state).toMatchObject({ kind: 'unavailable', reasons: ['disabled'] });

        const next = await hook.rerender({ pluginId: materializationB.pluginId });
        expect(next.reader).toBe(initial.reader);
        expect(next.classifyRelease).toBe(initial.classifyRelease);
        expect(next.machineSnapshots).toBe(initial.machineSnapshots);
        expect(next.selection.candidates.map((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).pluginId))
            .toEqual([materializationB.pluginId]);
        expect(next.selection.state).toMatchObject({ kind: 'unavailable', reasons: ['revoked'] });

        const returned = await hook.rerender({ pluginId: materializationA.pluginId });
        expect(returned.selection.candidates.map((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).pluginId))
            .toEqual([materializationA.pluginId]);
        expect(returned.selection.state).toMatchObject({ kind: 'unavailable', reasons: ['disabled'] });
        await hook.unmount();
    });

    it('keeps retained external-store selectors stable when execution-origin inputs change', async () => {
        // Observe the callbacks passed to React without replacing any hook or store logic.
        const callbacks = vi.mocked(React.useCallback);
        const memos = vi.mocked(React.useMemo);
        callbacks.mockClear();
        memos.mockClear();
        const serverIdentityId = 'srv_retained_origin';
        const url = 'https://retained-origin.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machines = Array.from({ length: 90 }, (_, index) => createMachineFixture({
            id: `retained-machine-${index}`, active: index === 0, activeAt: index === 0 ? Date.now() : 0,
        }));
        storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: machines }, machineListStatusByServerId: { [home.id]: 'idle' } });
        const sourceFor = (pluginId: string, machineId: string) => [{
            source: { origin: { serverIdentityId, sourceRef: { machineId, pluginId,
                sourceCustody: { kind: 'development' as const, registeredRootId: 'retained-source-root' } } },
                version: '1.0.0', occurrenceId: `${pluginId}-occurrence`, generation: 1, serverId: home.id },
            releaseContent: 'matched' as const, validation: { kind: 'admitted' as const },
        }];
        const sourceA = sourceFor('acme.retained-a', machines[0]!.id);
        const sourceB = sourceFor('acme.retained-b', machines[1]!.id);
        const hook = await renderHook(({ pluginId, sources }: { pluginId: string; sources: typeof sourceA }) =>
            usePluginMachineExecutionOriginSelection({ pluginId, sourceCandidates: sources,
                includeMachineCandidates: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier() }),
        { initialProps: { pluginId: 'acme.retained-a', sources: sourceA } });
        const readSelector = () => {
            const callback = [...memos.mock.results, ...callbacks.mock.results].findLast((result) => result.type === 'return'
                && typeof result.value === 'function'
                && result.value.toString().includes('readExecutionOriginMachineSnapshots'))?.value;
            expect(callback).toBeTypeOf('function');
            // The observed React callback is the store selector, whose public input is StorageState.
            return callback as (state: ReturnType<typeof storage.getState>) => unknown;
        };
        const retained = readSelector();
        await hook.rerender({ pluginId: 'acme.retained-b', sources: sourceB });
        const current = readSelector();
        expect(current).not.toBe(retained);
        const state = storage.getState();
        const before = retained(state);
        const currentBefore = current(state);
        expect(currentBefore).not.toEqual(before);
        expect(retained(state)).toBe(before);
        expect(current(state)).toBe(currentBefore);
        await hook.unmount();
    });
});
