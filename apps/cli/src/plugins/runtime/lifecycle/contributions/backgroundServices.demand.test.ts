import { describe, expect, it } from 'vitest';

import { createUnavailablePluginServices } from '../../invocation/services/unavailable';
import { createProductionPluginInvocationServiceOwners } from '../../invocation/services/production';
import { activatePluginRuntimeRegistry } from '../manager';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { BackgroundServiceContributionSchema } from '@happier-dev/protocol';
import { createBackgroundServiceRunnerHost, type PluginBackgroundServiceRunnerRegistration } from './backgroundServices';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function createHost(registration: PluginBackgroundServiceRunnerRegistration) {
    return createBackgroundServiceRunnerHost({
        registrations: [registration],
        createContext(input) {
            return {
                context: {
                    plugin: { id: input.pluginId, version: input.pluginVersion },
                    contribution: { id: input.localId, qualifiedId: `${input.pluginId}/backgroundServices/${input.localId}` },
                    surface: 'background',
                    invokedAtMs: 1,
                    signal: input.signal,
                    services: createUnavailablePluginServices(),
                },
                complete() {},
            };
        },
    });
}

const identity = { pluginId: 'acme.indexer', pluginVersion: '1.0.0', occurrenceId: 'one', localId: 'index' };
const target = { pluginId: identity.pluginId, occurrenceId: identity.occurrenceId, localId: identity.localId };

describe('background service demand lifecycle', () => {
    it('keeps omitted declaration fields intact and accepts explicit placement and activation at the strict protocol boundary', () => {
        expect(BackgroundServiceContributionSchema.parse({ id: 'index' })).toEqual({ id: 'index' });
        const explicit = { id: 'index', placement: 'process', activation: 'demand' };
        expect(BackgroundServiceContributionSchema.parse(explicit)).toEqual(explicit);
        expect(BackgroundServiceContributionSchema.safeParse({ id: 'index', placement: 'elsewhere' }).success).toBe(false);
        expect(BackgroundServiceContributionSchema.safeParse({ ...explicit, extra: true }).success).toBe(false);
    });

    it('definitively stops a process execution that ignores run cancellation before joining disposal', async () => {
        const started = deferred();
        const release = deferred();
        let stops = 0;
        const host = createHost({ ...identity, activation: 'demand', placement: 'process', async runner() {}, createExecution() {
            return {
                async run() { started.resolve(); await release.promise; },
                async stop() { stops += 1; release.resolve(); },
                async dispose() {},
            };
        } });
        const handle = host.demand(target);
        const cancellation = expect(handle.settlement).rejects.toMatchObject({ name: 'AbortError' });
        await started.promise;
        const disposal = host.dispose();
        let observedStops = 0;
        try {
            await Promise.resolve();
            observedStops = stops;
        } finally { release.resolve(); }
        await disposal;
        await cancellation;
        expect(observedStops).toBe(1);
    });

    it('does not allocate a process execution for a demand cancelled before its run begins', async () => {
        let births = 0;
        const host = createHost({ ...identity, placement: 'process', activation: 'demand', async runner() {}, createExecution() {
            births += 1;
            return { async run() {}, async dispose() {} };
        } });
        const handle = host.demand(target);
        const cancellation = expect(handle.settlement).rejects.toMatchObject({ name: 'AbortError' });
        handle.cancel();
        await cancellation;
        await host.settle([identity.pluginId]);
        expect(births).toBe(0);
        await host.dispose();
    });

    it('retires active and queued demands together without entering the follow-up run', async () => {
        const started = deferred();
        let runs = 0;
        const host = createHost({ ...identity, activation: 'demand', async runner(context) {
            runs += 1;
            started.resolve();
            await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        } });
        const active = host.demand(target);
        await started.promise;
        const queued = host.demand(target);
        const activeCancellation = expect(active.settlement).rejects.toMatchObject({ name: 'AbortError' });
        const queuedCancellation = expect(queued.settlement).rejects.toMatchObject({ name: 'AbortError' });
        host.retire([identity.pluginId]);
        await Promise.all([activeCancellation, queuedCancellation]);
        await host.settle([identity.pluginId]);
        expect(runs).toBe(1);
        await host.dispose();
    });

    it('joins execution disposal before settlement and gives a demand during disposal a fresh execution', async () => {
        const disposing = deferred();
        const allowDisposal = deferred();
        let births = 0;
        let settled = false;
        const host = createHost({ ...identity, activation: 'demand', placement: 'process', async runner() {}, createExecution() {
            const birth = ++births;
            return { async run() {}, async dispose() {
                if (birth === 1) { disposing.resolve(); await allowDisposal.promise; }
            } };
        } });
        const first = host.demand(target);
        void first.settlement.then(() => { settled = true; });
        await disposing.promise;
        expect(settled).toBe(false);
        const second = host.demand(target);
        expect(births).toBe(1);
        allowDisposal.resolve();
        await Promise.all([first.settlement, second.settlement]);
        expect(births).toBe(2);
        await host.dispose();
    });

    it('lazily activates a demand-only plugin and binds demand to its daemon invocation services', async () => {
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: identity.pluginId, version: '1.0.0', displayName: 'Demand indexer',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: { backgroundServices: [{ id: 'index', activation: 'demand' }, { id: 'followup', activation: 'demand' }] },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error('Demand service manifest must be admitted');
        const contributes = {
            agents: [], actions: [], resources: [], activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId: identity.pluginId,
                manifestPath: '/virtual/happier.plugin.json', daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-demand', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }], catalogEntriesById: {}, agentDefinitionsById: new Map(), pluginDiagnosticsByPluginId: {},
        } as unknown as ResolvedContributionRegistry;
        const services = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        let activations = 0;
        let runs = 0;
        const registry = await activatePluginRuntimeRegistry({ contributes, generation: 1, invocationServices: services,
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: '@happier-dev/plugins-demand/daemon', load: async () => ({
                activate(api: { backgroundServices: { register(id: string, runner: PluginBackgroundServiceRunnerRegistration['runner']): void } }) {
                    activations += 1;
                    api.backgroundServices.register('index', async (context) => {
                        expect(context.services.availability('backgroundServices').status).toBe('available');
                        await context.services.backgroundServices.demand('followup').settlement;
                    });
                    api.backgroundServices.register('followup', async () => { runs += 1; });
                },
            }) }),
        });
        try {
            registry.startAdoptedBackgroundServices();
            expect(activations).toBe(0);
            await registry.demandBackgroundService({ pluginId: identity.pluginId, localId: 'index' }).settlement;
            expect(activations).toBe(1);
            expect(runs).toBe(1);
        } finally { await registry.dispose(); await services.dispose(); }
    });

    it('registers a host service in the same owner without constructing plugin context', async () => {
        let hostRuns = 0;
        const host = createBackgroundServiceRunnerHost({ registrations: [], createContext() { throw new Error('Host services have no plugin context'); } });
        host.start();
        host.register({ owner: { kind: 'host', serviceId: 'memory-indexer' }, occurrenceId: 'host-one', localId: 'index', activation: 'demand', async runner(context) {
            expect(context.isOccurrenceCurrent()).toBe(true);
            expect(context).not.toHaveProperty('plugin');
            hostRuns += 1;
        } });
        await host.demand({ serviceId: 'memory-indexer' }).settlement;
        expect(hostRuns).toBe(1);
        await host.dispose();
    });

    it('does no idle work and coalesces arrivals during a run into exactly one follow-up', async () => {
        const firstStarted = deferred();
        const releaseFirst = deferred();
        let runs = 0;
        const host = createHost({
            ...identity,
            activation: 'demand',
            async runner() {
                runs += 1;
                if (runs === 1) { firstStarted.resolve(); await releaseFirst.promise; }
            },
        });
        host.start();
        await Promise.resolve();
        expect(runs).toBe(0);
        const first = host.demand(target);
        await firstStarted.promise;
        const arrivals = Array.from({ length: 1000 }, () => host.demand(target));
        releaseFirst.resolve();
        await Promise.all([first.settlement, ...arrivals.map((handle) => handle.settlement)]);
        await host.settle([identity.pluginId]);
        expect(runs).toBe(2);
        await host.dispose();
    });

    it('cancels only its caller and preserves another coalesced caller', async () => {
        const started = deferred();
        const release = deferred();
        const signals: AbortSignal[] = [];
        const host = createHost({ ...identity, activation: 'demand', async runner(context) {
            signals.push(context.signal);
            if (signals.length === 1) { started.resolve(); await release.promise; }
        } });
        host.start();
        const first = host.demand(target);
        await started.promise;
        const cancelled = host.demand(target);
        const survivor = host.demand(target);
        const rejection = expect(cancelled.settlement).rejects.toMatchObject({ name: 'AbortError' });
        cancelled.cancel();
        await rejection;
        expect(signals[0]!.aborted).toBe(false);
        release.resolve();
        await Promise.all([first.settlement, survivor.settlement]);
        expect(signals).toHaveLength(2);
        await host.dispose();
    });

    it('disposes a process execution after the coalesced batch and creates a new execution on next demand', async () => {
        const started = deferred();
        const release = deferred();
        let births = 0;
        let disposals = 0;
        let runs = 0;
        const host = createHost({ ...identity, placement: 'process', activation: 'demand',
            async runner() { throw new Error('Process placement must use its admitted execution'); },
            createExecution() {
                births += 1;
                return { async run() {
                    runs += 1;
                    if (runs === 1) { started.resolve(); await release.promise; }
                }, async dispose() { disposals += 1; } };
            },
        });
        host.start();
        const first = host.demand(target);
        await started.promise;
        const next = host.demand(target);
        release.resolve();
        await Promise.all([first.settlement, next.settlement]);
        await host.settle([identity.pluginId]);
        expect({ births, runs, disposals }).toEqual({ births: 1, runs: 2, disposals: 1 });
        await host.demand(target).settlement;
        await host.settle([identity.pluginId]);
        expect({ births, runs, disposals }).toEqual({ births: 2, runs: 3, disposals: 2 });
        await host.dispose();
    });

    it('rejects a failed demand and permits a later demand without an idle retry', async () => {
        let runs = 0;
        const failure = new Error('index failed');
        const host = createHost({ ...identity, activation: 'demand', async runner() {
            runs += 1;
            if (runs === 1) throw failure;
        } });
        host.start();
        await expect(host.demand(target).settlement).rejects.toBe(failure);
        await host.settle([identity.pluginId]);
        expect(runs).toBe(1);
        await host.demand(target).settlement;
        expect(runs).toBe(2);
        await host.dispose();
    });
});
