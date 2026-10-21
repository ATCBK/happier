import { describe, expect, it, vi } from 'vitest';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { createAppShellPluginUiProjectionPublication } from './appShellPluginUiProjectionPublication';
import {
    publishCommittedAppShellPluginUiProjection,
    readCurrentAppShellPluginUiExecutionOriginCandidates,
    readCurrentAppShellPluginUiProjection,
    subscribeCommittedAppShellPluginUiProjection,
} from './committedPluginUiProjection';

function translationProjection(generation: number, title: string): PluginUiProjectionModel {
    return Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, generation,
        installedPackagesById: Object.freeze({ 'acme.publication': { id: 'acme.publication', displayName: 'Publication',
            version: '1.0.0', enabled: true, source: { kind: 'registryPackage' as const, locator: 'acme.publication' } } }),
        translationsByPluginId: Object.freeze({ 'acme.publication': Object.freeze({ id: 'translations:acme.publication',
            pluginId: 'acme.publication', contributionKind: 'translations' as const, locales: ['en'], bundles: { en: { title } } }) }),
    });
}

function currentness(projection: PluginUiProjectionModel): PluginUiProjectionCurrentness {
    return Object.freeze({ pluginUiProjection: projection, pluginBrowserProjection: null,
        phase: 'current', interactionEnabled: true, machineId: 'machine', serverId: null,
        platform: 'web', accountLifetime: null });
}

describe('AppShell projection source publication', () => {
    it('keeps eleven UI provisioners stable while controller selection checks stream in', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const pluginIds = Array.from({ length: 11 }, (_, index) => `acme.provisioner-${index}`);
        const machines = ['controller-a', 'controller-b', 'controller-c'];
        const origins = new Map(machines.map(machineId => [machineId, new Map(pluginIds.map(pluginId => [pluginId,
            PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test', sourceRef: {
                machineId, pluginId, sourceCustody: { kind: 'development', registeredRootId: `${machineId}-${pluginId}` },
            } }),
        ]))]));
        const models = machines.map(machineId => {
            const installedPackagesById = Object.fromEntries(pluginIds.map(pluginId => [pluginId, {
                id: pluginId, displayName: pluginId, version: '1.0.0', enabled: true,
                occurrenceId: `${machineId}-${pluginId}`, executionOrigin: origins.get(machineId)!.get(pluginId)!,
                source: { kind: 'localPath', locator: `${machineId}-${pluginId}` },
            }]));
            const translationsByPluginId = Object.fromEntries(pluginIds.map(pluginId => [pluginId, {
                id: `translations:${pluginId}`, pluginId, contributionKind: 'translations' as const,
                locales: ['en'], bundles: { en: { title: pluginId } }, occurrenceId: `${machineId}-${pluginId}`,
                executionOrigin: origins.get(machineId)!.get(pluginId)!,
            }]));
            return Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
                installedPackagesById: Object.freeze(installedPackagesById),
                translationsByPluginId: Object.freeze(translationsByPluginId) }) satisfies PluginUiProjectionModel;
        });
        const values = vi.spyOn(Object, 'values');
        const entries = vi.spyOn(Object, 'entries');
        const keys = vi.spyOn(Object, 'keys');
        const sourceMaps = new Set<object>(models.flatMap(model => [model.installedPackagesById, model.translationsByPluginId]));
        const sourceWalks = () => values.mock.calls.filter(([value]) => sourceMaps.has(value)).length
            + entries.mock.calls.filter(([value]) => sourceMaps.has(value)).length
            + keys.mock.calls.filter(([value]) => sourceMaps.has(value)).length;
        try {
            owner.publishSources({ accountLifetime: null, availabilityReader: null, hostBundledUiEnabled: false,
                activeServerId: null, serverProfilesGeneration: 0, activeInventoryLoaded: true,
                onlineMachineIds: machines, selectableMachineIds: machines });
            models.forEach((model, index) => owner.publishMachineCurrentness(machines[index]!, null,
                { ...currentness(model), machineId: machines[index]! }));
            for (const pluginId of pluginIds) {
                const origin = origins.get(machines[0]!)!.get(pluginId)!;
                owner.publishExecutionOrigin(pluginId, null, origin, [origin]);
            }
            const initial = owner.getSnapshot();
            const establishedWalks = sourceWalks();
            expect(establishedWalks).toBeGreaterThan(0);
            let candidatePublications = 0;
            const unsubscribe = owner.subscribe(() => {
                if (owner.getSnapshot().candidateFactsByPluginId !== initial.candidateFactsByPluginId) candidatePublications++;
            });
            try {
                for (let controllerCount = 2; controllerCount <= machines.length; controllerCount++) {
                    for (const pluginId of pluginIds) {
                        owner.publishExecutionOrigin(pluginId, null, origins.get(machines[0]!)!.get(pluginId)!,
                            machines.slice(0, controllerCount).map(machineId => origins.get(machineId)!.get(pluginId)!));
                    }
                }
                expect(owner.getSnapshot().projectionUnion).toBe(initial.projectionUnion);
                expect(sourceWalks() - establishedWalks).toBe(0);
                expect(candidatePublications).toBe(0);
            } finally { unsubscribe(); }
        } finally { values.mockRestore(); entries.mockRestore(); keys.mockRestore(); owner.dispose(); }
    });

    it('does not rederive the UI union or feed back candidate reports for native-only origin reports', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const nativeId = 'acme.native-provisioner';
        const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test',
            sourceRef: { machineId: 'machine', pluginId: nativeId,
                sourceCustody: { kind: 'development', registeredRootId: 'native-root' } } });
        if (!('sourceRef' in origin)) throw new Error('Fixture must retain exact native source custody');
        const base = translationProjection(1, 'Visible');
        const model = Object.freeze({ ...base, installedPackagesById: Object.freeze({ ...base.installedPackagesById,
            [nativeId]: Object.freeze({ id: nativeId, displayName: 'Native provisioner', enabled: true,
                version: '1.0.0', occurrenceId: 'native-occurrence', executionOrigin: origin,
                sourceCustody: origin.sourceRef.sourceCustody, source: { kind: 'localPath' as const, locator: 'native-root' } }) }) });
        owner.publishSources({ accountLifetime: null, availabilityReader: null, hostBundledUiEnabled: false,
            activeServerId: 'server-1', serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] });
        owner.publishMachineCurrentness('machine', null, { ...currentness(model), serverId: 'server-1' });
        const initial = owner.getSnapshot();
        const facts = initial.candidateFactsByPluginId;
        expect(facts.get(nativeId)?.sourceCandidates).toHaveLength(1);
        let feedbackReports = 0;
        const unsubscribe = owner.subscribe(() => {
            if (owner.getSnapshot().candidateFactsByPluginId !== facts) {
                feedbackReports += 1;
                // The real reporter republishes its descriptive election after
                // a candidate change. Detect a cycle without mocking selection.
                if (feedbackReports < 3) owner.publishExecutionOrigin(nativeId, null, origin, [origin]);
            }
        });
        const values = vi.spyOn(Object, 'values');
        try {
            for (let index = 0; index < 10; index += 1) {
                owner.publishExecutionOrigin(nativeId, null, index % 2 ? null : origin, [origin]);
            }
            const declarationWalks = values.mock.calls.filter(([value]) => value === model.translationsByPluginId).length;
            expect(declarationWalks).toBe(0);
            expect(owner.getSnapshot().projectionUnion).toBe(initial.projectionUnion);
            expect(owner.getSnapshot().candidateFactsByPluginId).toBe(facts);
            expect(feedbackReports).toBe(0);
        } finally { values.mockRestore(); unsubscribe(); owner.dispose(); }
    });

    it('notifies committed candidate readers for native-only changes without replacing the aggregate declaration', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const sources = { accountLifetime: null, availabilityReader: null, hostBundledUiEnabled: false,
            activeServerId: 'server-1', serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: Object.freeze(['machine']), selectableMachineIds: Object.freeze(['machine']) };
        const pluginId = 'acme.native-only';
        let sourceReads = 0;
        const publishNative = (generation: number) => {
            const sourceCustody = Object.freeze({ kind: 'development' as const, registeredRootId: 'native-only-root' });
            const model: PluginUiProjectionModel = Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, generation,
                installedPackagesById: Object.freeze({ [pluginId]: Object.freeze({ id: pluginId, displayName: 'Native only',
                    version: '1.0.0', enabled: true, source: { kind: 'localPath' as const, locator: 'native-only-root' }, occurrenceId: `${pluginId}:occurrence`,
                    executionOrigin: { serverIdentityId: 'srv_test', sourceRef: { machineId: 'machine', pluginId, sourceCustody } },
                    sourceCustody }) }) });
            const report = { ...currentness(new Proxy(model, {
                get(target, key, receiver) { sourceReads += 1; return Reflect.get(target, key, receiver); },
            })), serverId: 'server-1' };
            owner.publishMachineCurrentness('machine', null, report);
            return report;
        };
        owner.publishSources(sources);
        const firstReport = publishNative(7);
        const first = owner.getSnapshot();
        expect(first.pluginUiProjection).toBeNull();
        expect(first.candidateFactsByPluginId.get(pluginId)?.sourceCandidates[0]?.source.generation).toBe(7);
        const read = () => owner.getSnapshot().pluginUiProjection;
        let sourceSubscriptions = 0;
        const bind = () => publishCommittedAppShellPluginUiProjection(read,
            id => owner.getSnapshot().candidateFactsByPluginId.get(id) ?? null,
            listener => {
                sourceSubscriptions += 1;
                const stop = owner.subscribe(listener);
                return () => { sourceSubscriptions -= 1; stop(); };
            });
        const firstCleanup = bind();
        let notifications = 0;
        let observed = readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId);
        const unsubscribe = subscribeCommittedAppShellPluginUiProjection(() => {
            notifications += 1;
            observed = readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId);
        });
        let currentCleanup = firstCleanup;
        try {
            sourceReads = 0;
            for (let index = 0; index < 100; index += 1) {
                owner.publishSources({ ...sources });
                owner.publishMachineCurrentness('machine', null, firstReport);
                expect(readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId)).toBe(observed);
            }
            expect(sourceReads).toBe(0);
            expect(notifications).toBe(0);
            publishNative(8);
            expect(owner.getSnapshot().pluginUiProjection).toBe(first.pluginUiProjection);
            expect(owner.getSnapshot().projectionUnion.phase).toBe(first.projectionUnion.phase);
            expect(notifications).toBe(1);
            expect(observed.sourceCandidates[0]?.source.generation).toBe(8);
            expect(sourceReads).toBeGreaterThan(0);

            // Rebinding the same read function must detach its predecessor,
            // and an old cleanup must not clear or detach the new binding.
            currentCleanup = bind();
            expect(sourceSubscriptions).toBe(1);
            firstCleanup();
            expect(sourceSubscriptions).toBe(1);
            notifications = 0;
            publishNative(9);
            expect(notifications).toBe(1);
            expect(observed.sourceCandidates[0]?.source.generation).toBe(9);
            currentCleanup();
            expect(sourceSubscriptions).toBe(0);
            expect(readCurrentAppShellPluginUiProjection()).toBeNull();
            expect(readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId).sourceCandidates).toEqual([]);
            notifications = 0;
            publishNative(10);
            expect(notifications).toBe(0);
        } finally {
            unsubscribe();
            currentCleanup();
            owner.dispose();
        }
    });

    it('makes repeated reads inert and publishes a changed source without rebuilding on equivalent commits', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const sources = { accountLifetime: null, availabilityReader: null, hostBundledUiEnabled: false,
            activeServerId: null, serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: Object.freeze(['machine']), selectableMachineIds: Object.freeze(['machine']) };
        owner.publishSources(sources);
        let sourceReads = 0;
        const observed = (projection: PluginUiProjectionModel) => new Proxy(projection, {
            get(target, key, receiver) { sourceReads += 1; return Reflect.get(target, key, receiver); },
        });
        const first = currentness(observed(translationProjection(1, 'First')));
        owner.publishMachineCurrentness('machine', null, first);
        const ready = owner.getSnapshot();
        expect(ready.pluginUiProjection?.translationsByPluginId['acme.publication']?.bundles).toEqual({ en: { title: 'First' } });
        let notifications = 0;
        const unsubscribe = owner.subscribe(() => { notifications += 1; });
        sourceReads = 0;
        for (let index = 0; index < 100; index += 1) {
            owner.publishSources({ ...sources });
            owner.publishMachineCurrentness('machine', null, first);
            expect(owner.getSnapshot()).toBe(ready);
        }
        expect(notifications).toBe(0);
        expect(sourceReads).toBe(0);
        owner.publishMachineCurrentness('machine', null, currentness(observed(translationProjection(2, 'Second'))));
        expect(sourceReads).toBeGreaterThan(0);
        expect(owner.getSnapshot()).not.toBe(ready);
        expect(owner.getSnapshot().pluginUiProjection?.translationsByPluginId['acme.publication']?.bundles).toEqual({ en: { title: 'Second' } });
        expect(notifications).toBe(1);
        unsubscribe();
        owner.dispose();
    });

    it('drops a departing Machine report so its return cannot re-admit the old current snapshot', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const sources = { accountLifetime: null, availabilityReader: null, hostBundledUiEnabled: false,
            activeServerId: null, serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: Object.freeze(['machine']), selectableMachineIds: Object.freeze(['machine']) };
        owner.publishSources(sources);
        owner.publishMachineCurrentness('machine', null, currentness(translationProjection(1, 'First')));
        expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(true);
        owner.publishSources({ ...sources, onlineMachineIds: [] });
        expect(owner.getSnapshot().projectionTargets).toHaveLength(0);
        owner.publishSources({ ...sources });
        expect(owner.getSnapshot().projectionTargets).toHaveLength(1);
        expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(false);
        expect(owner.getSnapshot().unionMembers[0]?.phase).toBe('establishing');
        owner.dispose();
    });

    it('does not re-admit an old unscoped Home report under the same Machine id', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const sources = { accountLifetime: null, availabilityReader: null, hostBundledUiEnabled: false,
            activeServerId: 'home-a', serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: Object.freeze(['machine']), selectableMachineIds: Object.freeze(['machine']) };
        const first = { ...currentness(translationProjection(1, 'Home A')), serverId: 'home-a' };
        owner.publishSources(sources);
        owner.publishMachineCurrentness('machine', null, first);
        expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(true);
        owner.publishSources({ ...sources, activeServerId: 'home-b' });
        owner.publishMachineCurrentness('machine', null, first);
        expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(false);
        expect(owner.getSnapshot().unionMembers[0]?.phase).toBe('establishing');
        owner.dispose();
    });
});
