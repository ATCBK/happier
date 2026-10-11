import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { getPluginMachineExecutionOriginRef, type PluginMachineMaterializationV1 } from '@happier-dev/protocol';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import {
    clearPluginAccountAvailabilityProjection,
    replacePluginAccountAvailabilityProjection,
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';

import { usePluginMachineExecutionOriginSelection } from './usePluginExecutionOriginSelection';
import { getPluginExecutionOriginCandidateOrigin } from './pluginExecutionOrigin';

describe('execution-origin plugin identity with real Account and machine owners', () => {
    afterEach(async () => {
        await standardCleanup();
        clearPluginAccountAvailabilityProjection();
    });

    it('offers a daemon-selected source once without dropping a distinct portable installation', async () => {
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account-source-inventory' };
        const serverIdentityId = 'srv_source_inventory';
        const url = 'https://source-inventory.example.test';
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
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
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account-source-target' };
        const serverIdentityId = 'srv_source_execution';
        const url = 'https://source-execution.example.test';
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
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
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account-origin-presence' };
        const serverIdentityId = 'srv_origin_presence';
        const url = 'https://origin-presence.example.test';
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
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
        const initialRenders = renders;
        expect(initial.canExecute).toBe(true);
        expect(initial.resolveExecutionOrigin()?.machineTarget.machine).toBe(machine);

        const refreshed = { ...machine, activeAt: Date.now(), updatedAt: 11,
            metadata: { ...machine.metadata!, displayName: 'After' } };
        await act(async () => { storage.setState({ machineListByServerId: { [home.id]: [refreshed] } }); });
        expect(renders).toBe(initialRenders);
        expect(hook.getCurrent().machineCandidates).toEqual([]);
        expect(hook.getCurrent().candidates).toBe(initial.candidates);
        expect(hook.getCurrent().state).toBe(initial.state);
        expect(hook.getCurrent().canExecute).toBe(true);
        expect(initial.resolveExecutionOrigin()?.machineTarget.machine).toBe(refreshed);

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
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account-origin-identity' };
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
});
