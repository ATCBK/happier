import { expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { discoverAgentAccountingJsonlSource } from '@happier-dev/plugin-sdk/sessions/file-stores';

import { createExternalSessionObservationReconciler } from './createExternalSessionObservationReconciler';

it.runIf(process.env.HAPPIER_RUN_OBSERVATION_MEMORY_BENCHMARK === '1')(
    'retains directory-sized delivery state for a source-wide corpus and releases it on disable', async () => {
        setFlagsFromString('--expose_gc');
        const collect: unknown = runInNewContext('gc');
        if (typeof collect !== 'function') throw new Error('Benchmark GC unavailable');
        const sample = async () => {
            await new Promise<void>(resolve => setImmediate(resolve)); collect();
            await new Promise<void>(resolve => setImmediate(resolve)); collect();
            return process.memoryUsage().heapUsed;
        };
        const directory = await mkdtemp(join(tmpdir(), 'source-wide-delivery-'));
        const files = Array.from({ length: 3_000 }, (_, index) => join(directory, `${index}.jsonl`));
        const reconciler = createExternalSessionObservationReconciler({ acquireObserver: async () => ({ dispose() {} }) });
        const changes: string[] = [];
        const register = (topology: boolean) => reconciler.registerAccountingSource({
            resource: { pluginId: 'fixture', agentLocalId: 'fixture', occurrenceId: '1', resourceKey: 'fixture' },
            source: { kind: 'fixture' }, changeObservation: 'watch_file_changes',
            watchFileChanges: { files, ...(topology ? { topologyDirectories: [directory] } : {}) },
            onChange: change => { changes.push(change.changedFile ?? change.reason); },
        });
        try {
            for (const file of files) await writeFile(file, '{}\n');
            const baseline = await sample();
            let individual: Pick<Awaited<ReturnType<typeof register>>, 'dispose'> = await register(false);
            const perFile = await sample();
            await individual.dispose(); individual = { dispose() {} };
            const released = await sample();
            let inventory: Awaited<ReturnType<typeof discoverAgentAccountingJsonlSource>> | null =
                await discoverAgentAccountingJsonlSource([directory], new AbortController().signal);
            const accountingWalk = await sample();
            const walkArray = new WeakRef(inventory.files);
            const subscription = await reconciler.registerAccountingSource({
                resource: { pluginId: 'fixture', agentLocalId: 'fixture', occurrenceId: '1', resourceKey: 'fixture' },
                source: { kind: 'fixture' }, changeObservation: 'watch_file_changes',
                // The same discovered arrays, so the WeakRef proves the owner does not retain them.
                watchFileChanges: { files: inventory.files as string[], topologyDirectories: inventory.topologyDirectories as string[] },
                onChange: change => { changes.push(change.changedFile ?? change.reason); },
            });
            inventory = null;
            // Registration includes attachment of the shared content observer.
            await appendFile(files[0]!, '{}\n');
            await vi.waitFor(() => expect(changes).toContain(files[0]));
            const directoryDemand = await sample();
            console.info('R242_OBSERVATION_HEAP', JSON.stringify({ files: files.length, baseline, perFile, released, accountingWalk, directoryDemand }));
            expect(walkArray.deref()).toBeUndefined();
            expect(directoryDemand - released).toBeLessThan((perFile - baseline) / 4);
            await subscription.dispose();
            const disabled = await sample();
            const delivered = changes.length;
            await appendFile(files[0]!, '{}\n');
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(changes).toHaveLength(delivered);
            console.info('R242_OBSERVATION_DISABLED_HEAP', JSON.stringify({ disabled }));
        } finally { await reconciler.dispose(); await rm(directory, { recursive: true, force: true }); }
    }, 60_000,
);

it('accounts for a file change without scanning the source corpus', async () => {
    const files = Array.from({ length: 50_000 }, (_, index) => `/fixture/${String(index).padStart(5, '0')}.jsonl`);
    const changedFile = files[files.length - 1]!;
    let changed: (() => void) | undefined;
    let notifications = 0;
    const reconciler = createExternalSessionObservationReconciler({
        acquireObserver: async () => ({ dispose() {} }),
        // The OS watcher is the system boundary; registration, resource demand,
        // filtering, invalidation, and disposal all use the real host owner.
        watchFile: (file, notify) => {
            if (file === changedFile) changed = () => notify(file);
            return () => {};
        },
    });
    const subscription = await reconciler.registerAccountingSource({
        resource: { pluginId: 'fixture', agentLocalId: 'fixture', occurrenceId: '1', resourceKey: 'fixture' },
        source: { kind: 'fixture' },
        changeObservation: 'watch_file_changes',
        watchFileChanges: { files },
        onChange: () => { notifications++; },
    });
    try {
        const iterations = 4_000;
        const cpuMs = (start: NodeJS.CpuUsage) => {
            const usage = process.cpuUsage(start);
            return (usage.user + usage.system) / 1_000;
        };
        const ownerSamples: number[] = [];
        const linearSamples: number[] = [];
        let linearNotifications = 0;
        // Relative CPU cost avoids an absolute latency promise and host
        // scheduling noise. The linear reference reproduces the former match.
        for (let batch = 0; batch < 3; batch++) {
            let start = process.cpuUsage();
            for (let index = 0; index < iterations; index++) changed!();
            ownerSamples.push(cpuMs(start));
            start = process.cpuUsage();
            for (let index = 0; index < iterations; index++) {
                if (files.includes(changedFile)) linearNotifications++;
            }
            linearSamples.push(cpuMs(start));
        }
        const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[1]!;
        const ownerMs = median(ownerSamples);
        const linearMs = median(linearSamples);
        console.info('accounting file-match CPU benchmark', JSON.stringify({
            files: files.length, iterations, ownerMs, linearMs, ratio: ownerMs / linearMs,
        }));
        expect(notifications).toBe(iterations * 3);
        expect(linearNotifications).toBe(notifications);
        expect(ownerMs / linearMs).toBeLessThan(0.25);
        await subscription.dispose();
        changed!();
        expect(notifications).toBe(iterations * 3);
    } finally {
        await reconciler.dispose();
    }
});

it.runIf(process.env.HAPPIER_RUN_OBSERVATION_MEMORY_BENCHMARK === '1')(
    'measures release of a synthetic observation corpus while its owner stays alive',
    async () => {
        // GC is confined to this opt-in benchmark process, never the daemon.
        setFlagsFromString('--expose_gc');
        const collect: unknown = runInNewContext('gc');
        if (typeof collect !== 'function') throw new Error('Benchmark GC unavailable');
        const sample = async () => {
            await new Promise<void>(resolve => setImmediate(resolve));
            collect();
            await new Promise<void>(resolve => setImmediate(resolve));
            collect();
            const { heapUsed, heapTotal, external, arrayBuffers, rss } = process.memoryUsage();
            return { heapUsed, heapTotal, external, arrayBuffers, rss,
                nativeWatchers: process.getActiveResourcesInfo().filter(kind => kind === 'FSEventWrap').length };
        };
        const directory = await mkdtemp(join(tmpdir(), 'observation-memory-'));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: async () => ({ dispose() {} }),
        });
        try {
            const baseline = await sample();
            const files = 10_000;
            let subscription: Pick<Awaited<ReturnType<typeof reconciler.registerAccountingSource>>, 'dispose'> = await reconciler.registerAccountingSource({
                resource: { pluginId: 'fixture', agentLocalId: 'fixture', occurrenceId: '1', resourceKey: 'fixture' },
                source: { kind: 'fixture' }, changeObservation: 'watch_file_changes',
                watchFileChanges: { files: Array.from({ length: files }, (_, index) => join(directory, `${index}.jsonl`)) },
                onChange() {},
            });
            const demanded = await sample();
            await subscription.dispose();
            // The real source consumers drop their retired demand handle.
            // Holding it here would measure this fixture's disposed closure.
            subscription = { dispose() {} };
            const released = await sample();
            console.info('observation corpus memory benchmark', JSON.stringify({ files, baseline, demanded, released }));
            expect(demanded.nativeWatchers - baseline.nativeWatchers).toBe(1);
            expect(released.nativeWatchers).toBe(baseline.nativeWatchers);
        } finally {
            await reconciler.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    },
);
