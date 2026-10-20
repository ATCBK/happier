import { EventEmitter, on } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { startFileWatcher } from './startFileWatcher';

it('keeps idle logical file subscriptions smaller than an eagerly allocated Node event queue', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'happier-file-watch-memory-')));
    const inspector = new Session();
    const disposers: Array<() => void> = [];
    const stock: ReturnType<typeof on>[] = [];
    inspector.connect();
    const retainedHeap = async () => {
        // This isolated synthetic process owns every measured subscription.
        await inspector.post('HeapProfiler.collectGarbage');
        return process.memoryUsage().heapUsed;
    };
    try {
        const before = await retainedHeap();
        await Promise.all(Array.from({ length: 512 }, (_, index) => new Promise<void>(resolve => {
            disposers.push(startFileWatcher(join(directory, `${index}.jsonl`), () => {}, {
                emitInitial: false, onWatcherAttached: resolve,
            }));
        })));
        const withFiles = await retainedHeap();
        for (let index = 0; index < disposers.length; index++) stock.push(on(new EventEmitter(), 'change'));
        const withStock = await retainedHeap();
        // Derive the comparison from this Node runtime, rather than a guessed
        // heap cap. A file subscription must not retain even more memory than
        // the two eagerly allocated queues in a stock events.on iterator.
        expect(withFiles - before).toBeLessThan(withStock - withFiles);
    } finally {
        for (const dispose of disposers) dispose();
        await Promise.all(stock.map(iterator => iterator.return?.()));
        inspector.disconnect();
        await rm(directory, { recursive: true, force: true });
    }
});
