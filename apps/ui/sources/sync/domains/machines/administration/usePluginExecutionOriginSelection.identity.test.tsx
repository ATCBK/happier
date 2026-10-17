import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { advancePluginExecutionOriginSelectionRevision, usePluginMachineExecutionOriginSelection } from './usePluginExecutionOriginSelection';
import { getPluginExecutionOriginCandidateOrigin } from './pluginExecutionOrigin';
import * as executionOrigin from './pluginExecutionOrigin';
import { resolveFreshMachineAdministrationExecutionTarget } from './useTargetSelection';
import { setPluginMachineExecutionOriginPreference } from './selectionPreferences';

const externalStoreReads = await vi.hoisted(async () => {
    // Zustand's CommonJS adapter reads React through require, outside Vitest's ESM spies.
    const { createRequire } = await import('node:module');
    const react = createRequire(import.meta.url)('react') as typeof import('react');
    const original = react.useSyncExternalStore;
    const reads: Array<() => unknown> = [];
    react.useSyncExternalStore = (subscribe, getSnapshot, getServerSnapshot) => {
        reads.push(getSnapshot);
        return original(subscribe, getSnapshot, getServerSnapshot);
    };
    return { reads, restore: () => { react.useSyncExternalStore = original; } };
});
afterAll(() => externalStoreReads.restore());

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
        externalStoreReads.reads.length = 0;
        vi.useRealTimers();
    });

    it('advances its local revision monotonically across A-to-B-to-A', () => {
        const originA = { serverIdentityId: 'srv_one', materializationRef: {
            machineId: 'machine-a', materializationId: 'mat-a', pluginId: 'acme.plugin',
        } };
        const originB = { serverIdentityId: 'srv_two', materializationRef: {
            machineId: 'machine-b', materializationId: 'mat-b', pluginId: 'acme.plugin',
        } };
        const initial = { pluginId: 'acme.plugin', origin: originA, revision: 0 };
        const selectedB = advancePluginExecutionOriginSelectionRevision(initial, 'acme.plugin', originB);
        const selectedAAgain = advancePluginExecutionOriginSelectionRevision(selectedB, 'acme.plugin', originA);
        expect(selectedB.revision).toBe(1);
        expect(selectedAAgain.revision).toBe(2);
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

    it('says it is loading until Account availability is admitted, then answers from it', async () => {
        const serverIdentityId = 'srv_availability_loading';
        const url = 'https://availability-loading.example.test';
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: [] }, machineListStatusByServerId: { [home.id]: 'idle' } });
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({
            pluginId: 'acme.loading', classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(),
        }));
        // Nothing is known yet: this is not the answer "no Machine can run it".
        expect(hook.getCurrent().loading).toBe(true);
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
        } }); });
        expect(hook.getCurrent().loading).toBe(false);
        expect(hook.getCurrent().state.kind).toBe('unavailable');
        // Nor is "none" an answer while the Home's Machine list is still being read.
        await act(async () => { storage.setState({ machineListStatusByServerId: { [home.id]: 'loading' } }); });
        expect(hook.getCurrent().loading).toBe(true);
        await act(async () => { storage.setState({ machineListStatusByServerId: { [home.id]: 'idle' } }); });
        expect(hook.getCurrent().loading).toBe(false);
        await hook.unmount();
    });

    it('keeps rows and ready selection after visiting another plugin while the picker credential read settles', async () => {
        const serverIdentityId = 'srv_return_to_plugin';
        const url = 'https://return-to-plugin.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'return-machine', active: true, activeAt: Date.now() });
        storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] },
            machineListStatusByServerId: { [home.id]: 'idle' } });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
        } });
        const pluginId = 'acme.return';
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: 'return-root' } } };
        const candidates = [{ source: { origin, version: '1.0.0', occurrenceId: 'return-occurrence',
            generation: 1, serverId: home.id }, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        const { getPluginUiEphemeralSharedScope } = await import('@/components/plugins/surfaces/pluginUiEphemeralSharedScope');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { acquireTriageListWindow, readTriageListWindowSnapshot, refreshTriageListWindow } = await import(
            '../../../../../../../packages/plugins/triage/src/ui/window/mountedWindow');
        const { TriageListEntriesResultV1Schema } = await import('../../../../../../../packages/plugins/triage/src/actions/listEntriesProtocol');
        const { resolveTriageListShellState } = await import('../../../../../../../packages/plugins/triage/src/ui/shell/windowState');
        const { testkitEntryRef, testkitObservation, TRIAGE_TESTKIT_SOURCE, TESTKIT_SOURCE_INSTANCE_ID } = await import(
            '../../../../../../../packages/plugins/triage/src/corpus/testkit/observations.test-support');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        const now = Date.now();
        const result = TriageListEntriesResultV1Schema.parse({ v: 1,
            configuredSources: [{ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, source: TRIAGE_TESTKIT_SOURCE, available: true }],
            configuredSourcesStatus: 'complete', window: { v: 1,
                rows: [{ entryRef: testkitEntryRef(), lane: '1-open', sortAtMs: now,
                    presence: { kind: 'present', observedAtMs: now },
                    selected: { kind: 'selected', sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, reason: 'onlyPresent' },
                    observation: testkitObservation({ observedAtMs: now }), otherObservations: [], observedByCount: 1 }],
                lanes: [{ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, source: TRIAGE_TESTKIT_SOURCE,
                    health: { kind: 'walkFinished' }, exhausted: true }], coverage: 'complete', assembledAtMs: now } });
        const host = { executeAction: async () => result };
        const scopeFor = (selection: ReturnType<typeof usePluginMachineExecutionOriginSelection>, id = pluginId) => {
            const selected = selection.state.kind === 'selected' ? selection.state.candidate : null;
            return getPluginUiEphemeralSharedScope({ accountLifetime, pluginId: id,
                occurrenceId: selected && 'source' in selected ? selected.source.occurrenceId : 'artifact:retained-view',
                executionOrigin: selection.selectedOrigin, isCurrent: () => accountLifetime?.isCurrent() === true });
        };
        // Compose the real selector, host sharing scope, aggregate acquisition
        // and shell presentation. Only the Action transport/device storage are boundaries.
        const first = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId,
            includeMachineCandidates: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates }));
        expect(first.getCurrent().state.kind).toBe('selected');
        const firstScope = scopeFor(first.getCurrent());
        const firstLease = acquireTriageListWindow(host, firstScope);
        await refreshTriageListWindow('view', host, firstScope);
        const retainedWindow = readTriageListWindowSnapshot(host, firstScope).window;
        expect(retainedWindow?.rows).toHaveLength(1);
        firstLease.release();
        await first.unmount();
        const otherPluginId = 'acme.other-page';
        const otherCandidates = [{ ...candidates[0]!, source: { ...candidates[0]!.source,
            occurrenceId: 'other-occurrence', origin: { ...origin, sourceRef: { ...origin.sourceRef, pluginId: otherPluginId } } } }];
        const other = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: otherPluginId,
            includeMachineCandidates: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: otherCandidates }));
        expect(other.getCurrent().state.kind).toBe('selected');
        acquireTriageListWindow(host, scopeFor(other.getCurrent(), otherPluginId)).release();
        await other.unmount();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const readCredentials = vi.mocked(TokenStorage.getCredentialsForServerUrl).getMockImplementation()
            ?? TokenStorage.getCredentialsForServerUrl;
        let releasePickerRead!: () => void;
        const pickerRead = new Promise<void>(resolve => { releasePickerRead = resolve; });
        let reads = 0;
        // Device credential storage is a real asynchronous boundary. Keep the
        // real reader and delay only its second (picker-presentation) result.
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl, options) => {
            const result = await readCredentials.call(TokenStorage, serverUrl, options);
            if (serverUrl === url && options?.storageReadFailure === 'surface' && ++reads === 2) await pickerRead;
            return result;
        });
        const returnPresentations: Array<{ loading: boolean; kind: string }> = [];
        const hook = await renderHook(() => {
            const selection = usePluginMachineExecutionOriginSelection({ pluginId,
                classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates });
            returnPresentations.push({ loading: selection.loading, kind: selection.state.kind });
            return selection;
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().canExecute).toBe(true));
            await act(async () => { releasePickerRead(); });
            expect(hook.getCurrent().loading).toBe(false);
            expect(hook.getCurrent().state.kind).toBe('selected');
            expect(hook.getCurrent().selectedOrigin).toEqual(origin);
            expect(returnPresentations.filter(state => !state.loading && state.kind !== 'selected')).toEqual([]);
            const returningScope = scopeFor(hook.getCurrent());
            const returningLease = acquireTriageListWindow(host, returningScope);
            try {
                const snapshot = readTriageListWindowSnapshot(host, returningScope);
                expect(snapshot.window).toBe(retainedWindow);
                expect(resolveTriageListShellState(snapshot)).toMatchObject({ kind: 'window', failure: null });
            } finally { returningLease.release(); }
        } finally {
            releasePickerRead();
            await hook.unmount();
        }
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
        const classified: string[] = [];
        const candidateProjections = new Set<readonly unknown[]>();
        const hook = await renderHook(() => {
            const classify = useActivePluginAccountAvailabilityReleaseClassifier();
            const classifyRelease = React.useMemo(() => (materialization: PluginMachineMaterializationV1) => {
                classified.push(materialization.materializationId);
                return classify(materialization);
            }, [classify]);
            const selection = usePluginMachineExecutionOriginSelection({ pluginId, classifyRelease, sourceCandidates: sources });
            candidateProjections.add(selection.candidates);
            return selection;
        });
        // Undemanded rendering classifies only the emitted candidate projection.
        // Availability reads retain their memo; explicit invocation stays fresh.
        for (const materialization of [report, portable]) {
            expect(classified.filter(id => id === materialization.materializationId)).toHaveLength(candidateProjections.size);
        }
        expect(hook.getCurrent().candidates.map(getPluginExecutionOriginCandidateOrigin)).toEqual([
            { serverIdentityId, materializationRef: { machineId: machine.id, materializationId: portable.materializationId, pluginId } },
            origin,
        ]);
        const beforeAvailabilityRead = classified.length;
        expect(hook.getCurrent().canExecute).toBe(true);
        expect(hook.getCurrent().canExecute).toBe(true);
        expect(classified).toHaveLength(beforeAvailabilityRead + 2);
        const beforeInvocation = classified.length;
        expect(hook.getCurrent().resolveExecutionOrigin()?.source).toEqual(source);
        expect(classified.length).toBeGreaterThan(beforeInvocation);
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
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
        } });
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
        const settingsBeforeMount = storage.getState().settings;
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: 'acme.source',
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates,
            readSourceCandidates: () => currentSources, declaredDefaultOrigins: [origin],
            readDeclaredDefaultOrigins: () => currentDefaults }));
        expect(hook.getCurrent().selectedOrigin).toEqual(origin);
        expect(hook.getCurrent().machineCandidates).toEqual(expect.arrayContaining([
            expect.objectContaining({ target: { serverIdentityId, machineId: machine.id }, availability: 'online' }),
        ]));
        expect(hook.getCurrent().resolveExecutionOrigin()?.source).toEqual(source);
        // A retained source can already be selected while its Home's live
        // Machine census is still resolving. That is pending, not an outage.
        await act(async () => { storage.setState({ machineListStatusByServerId: { [home.id]: 'loading' } }); });
        expect(hook.getCurrent().canExecute).toBe(false);
        expect(hook.getCurrent().loading).toBe(true);
        for (const status of ['error', 'signedOut'] as const) {
            await act(async () => { storage.setState({ machineListStatusByServerId: { [home.id]: status } }); });
            expect(hook.getCurrent().canExecute).toBe(false);
            expect(hook.getCurrent().loading).toBe(false);
        }
        await act(async () => { storage.setState({ machineListStatusByServerId: { [home.id]: 'idle' } }); });
        expect(hook.getCurrent().canExecute).toBe(true);
        expect(hook.getCurrent().loading).toBe(false);
        await hook.rerender();
        expect(storage.getState().settings).toBe(settingsBeforeMount);
        const alternate = { ...candidates[0]!, source: { ...source, origin: { ...origin,
            sourceRef: { ...origin.sourceRef, sourceCustody: { kind: 'development' as const, registeredRootId: 'alternate-source-root' } } } } };
        currentSources = [...candidates, alternate];
        currentDefaults = [];
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        currentSources = [];
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        const resolveBeforePreferenceChange = hook.getCurrent().resolveExecutionOrigin;
        currentSources = [alternate];
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1:
                setPluginMachineExecutionOriginPreference({}, 'acme.source', alternate.source.origin) } });
            expect(resolveBeforePreferenceChange()?.origin).toEqual(alternate.source.origin);
        });
        currentSources = candidates;
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1:
                setPluginMachineExecutionOriginPreference({}, 'acme.source', origin) } });
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

        // Runtime/parent rerenders can replace store-selector closures without
        // replacing inventory facts. Observe serialization itself, forwarding JSON.
        const stringify = vi.spyOn(JSON, 'stringify');
        const machineFactsSerializations = () => stringify.mock.calls.filter(([value]) => Array.isArray(value)
            && value.some(row => Array.isArray(row) && row[0] === serverIdentityId && row[1] === machine.id)).length;
        const detailedHook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: 'acme.presence',
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates,
            declaredDefaultOrigins: defaults }));
        expect(detailedHook.getCurrent().canExecute).toBe(true);
        await hook.rerender();
        const settledSerializations = machineFactsSerializations();
        for (let index = 0; index < 5; index++) {
            await hook.rerender();
            await detailedHook.rerender();
        }
        expect(machineFactsSerializations()).toBe(settledSerializations);
        await detailedHook.unmount();

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
        const beforePresentationRefresh = machineFactsSerializations();

        const refreshed = { ...machine, activeAt: Date.now(), updatedAt: 11,
            metadata: { ...machine.metadata!, displayName: 'After' } };
        await act(async () => { storage.setState({ machineListByServerId: { [home.id]: [refreshed] } }); });
        expect(renders).toBe(settledRenders);
        expect(hook.getCurrent().machineCandidates).toEqual([]);
        expect(hook.getCurrent().candidates).toBe(initial.candidates);
        expect(hook.getCurrent().state).toBe(initial.state);
        expect(hook.getCurrent().canExecute).toBe(true);
        expect(initial.resolveExecutionOrigin()?.machineTarget.machine).toBe(refreshed);
        expect(machineFactsSerializations()).toBe(beforePresentationRefresh);

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
            const callback = [...memos.mock.results, ...callbacks.mock.results].reverse().find((result) => result.type === 'return'
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

    it('keeps React snapshots stable across presence expiry until an owner publishes a wake', async () => {
        const serverIdentityId = 'srv_snapshot_expiry';
        const url = 'https://snapshot-expiry.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'snapshot-expiry-machine', active: true, activeAt: Date.now() });
        storage.setState({ profileScope: scope, settingsScope: scope,
            machines: {}, machineListByServerId: { [home.id]: [machine] },
            machineListStatusByServerId: { [home.id]: 'idle' } });
        // A non-bundled plugin supplies both a portable installation and a development source.
        const pluginId = 'acme.snapshot-expiry';
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], snapshots: [], materializations: [{
                serverIdentityId, machineId: machine.id, materializationId: 'installed-external-plugin',
                pluginId, version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
                enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [],
            }],
        } });
        const sources = [{ source: {
            origin: { serverIdentityId, sourceRef: { machineId: machine.id, pluginId,
                sourceCustody: { kind: 'development' as const, registeredRootId: 'snapshot-expiry-root' } } },
            version: '1.0.0', occurrenceId: 'snapshot-expiry-occurrence', generation: 1, serverId: home.id,
        }, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        externalStoreReads.reads.length = 0;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const readAtMs = Date.now();
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId,
            sourceCandidates: sources, includeMachineCandidates: false,
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier() }));
        // Observe the real getSnapshot handed to React, including the store's selector adapter.
        const readSnapshot = [...externalStoreReads.reads].reverse().find(read => {
            const value = read();
            return value !== null && typeof value === 'object' && 'key' in value && 'snapshots' in value;
        });
        expect(readSnapshot).toBeTypeOf('function');
        const state = storage.getState();
        const before = readSnapshot!();
        expect(readSnapshot!()).toBe(before);
        const expiresAtMs = readMachineStatusNextRefreshAtMs(machine, Date.now());
        expect(expiresAtMs).not.toBeNull();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAtMs!);
        try {
            expect(storage.getState()).toBe(state);
            expect(readSnapshot!()).toBe(before);
            await act(async () => { await vi.advanceTimersByTimeAsync(expiresAtMs! - readAtMs); });
            expect(storage.getState()).toBe(state);
            expect(hook.getCurrent().candidates).toHaveLength(2);
            expect(hook.getCurrent().candidates.every(candidate =>
                candidate.validation.kind === 'rejected' && candidate.validation.reason === 'offline')).toBe(true);
        } finally {
            clock.mockRestore();
            await hook.unmount();
        }
    });
});
