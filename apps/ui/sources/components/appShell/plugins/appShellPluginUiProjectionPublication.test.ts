import { describe, expect, it } from 'vitest';

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
                    version: '1.0.0', enabled: true, source: { kind: 'localPath' as const }, occurrenceId: `${pluginId}:occurrence`,
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
