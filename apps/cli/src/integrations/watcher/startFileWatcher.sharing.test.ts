import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ watch: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs/promises')>();
    boundary.stat.mockImplementation(fs.stat);
    return { ...fs, stat: boundary.stat };
});
vi.mock('node:fs', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs')>();
    // Observe the genuine OS-watch boundary; filesystem events and recovery remain real.
    boundary.watch.mockImplementation(fs.watch);
    return { ...fs, watch: boundary.watch };
});

import { startFileWatcher } from './startFileWatcher';

it('keeps named rename revalidation independent of the number of sibling transcripts', async () => {
    boundary.watch.mockClear();
    const directory = await mkdtemp(join(tmpdir(), 'native-watch-rename-sharing-'));
    const files = Array.from({ length: 4 }, (_, index) => join(directory, `${index}.jsonl`));
    const stops: Array<() => void> = [];
    const delivered = Promise.withResolvers<void>();
    try {
        await Promise.all(files.map(file => writeFile(file, 'initial\n')));
        await Promise.all(files.map((file, index) => new Promise<void>(resolve => {
            stops.push(startFileWatcher(file, () => { if (index === 0) delivered.resolve(); },
                { emitInitial: false, onWatcherAttached: resolve }));
        })));
        boundary.stat.mockClear();
        // Native rename events cover both atomic file replacement and parent
        // replacement. Revalidate the shared parent once before fan-out.
        boundary.watch.mock.results[0].value.emit('change', 'rename', '0.jsonl');
        await delivered.promise;
        const parentReads = boundary.stat.mock.calls.filter(([path]) => path === directory).length;
        expect(parentReads).toBeLessThanOrEqual(2);
    } finally {
        for (const stop of stops) stop();
        await rm(directory, { recursive: true, force: true });
    }
});

it('shares native parent observation across transcript subscriptions without sharing their lifetime or delivery', async () => {
    boundary.watch.mockClear();
    const directory = await mkdtemp(join(tmpdir(), 'native-watch-sharing-'));
    const first = join(directory, 'first.jsonl');
    const second = join(directory, 'second.jsonl');
    const stops: Array<() => void> = [];
    const changed = [0, 0, 0];
    const deliveries = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    try {
        await Promise.all([writeFile(first, 'initial\n'), writeFile(second, 'initial\n')]);
        await Promise.all([first, second, first].map((file, index) => new Promise<void>((resolve) => {
            stops.push(startFileWatcher(file, () => {
                changed[index] += 1;
                deliveries[index].resolve();
            }, { emitInitial: false, onWatcherAttached: resolve }));
        })));
        // Native subscriptions must scale with directories, not corpus file count.
        expect(boundary.watch).toHaveBeenCalledTimes(1);
        await appendFile(first, 'append\n');
        await Promise.all([deliveries[0].promise, deliveries[2].promise]);
        expect(changed[1]).toBe(0);
        stops[0]();
        stops[2]();
        const firstChanges = changed[0];
        await appendFile(second, 'still-observed\n');
        await deliveries[1].promise;
        expect(changed[0]).toBe(firstChanges);
        expect(boundary.watch).toHaveBeenCalledTimes(1);
        const nativeWatcher = boundary.watch.mock.results[0].value;
        const closed = new Promise<void>((resolve) => nativeWatcher.once('close', resolve));
        stops[1]();
        await closed;
    } finally {
        for (const stop of stops) stop();
        await rm(directory, { recursive: true, force: true });
    }
});

it('recovers every subscriber after their shared native observation fails', async () => {
    boundary.watch.mockClear();
    const directory = await mkdtemp(join(tmpdir(), 'native-watch-recovery-'));
    const files = [join(directory, 'first.jsonl'), join(directory, 'second.jsonl')];
    const stops: Array<() => void> = [];
    const attachments = [0, 0];
    const unavailable = [vi.fn(), vi.fn()];
    let deliveries = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    try {
        await Promise.all(files.map(file => writeFile(file, 'initial\n')));
        await Promise.all(files.map((file, index) => new Promise<void>((resolve) => {
            stops.push(startFileWatcher(file, () => { deliveries[index].resolve(); }, {
                emitInitial: false,
                onWatcherAttached: () => { attachments[index] += 1; resolve(); },
                onWatcherUnavailable: unavailable[index],
            }));
        })));
        boundary.watch.mock.results[0].value.emit('error', new Error('native observation lost'));
        await vi.waitFor(() => expect(attachments).toEqual([2, 2]), { timeout: 10_000 });
        expect(unavailable.every(callback => callback.mock.calls.length > 0)).toBe(true);
        expect(boundary.watch).toHaveBeenCalledTimes(2);
        deliveries = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        await Promise.all(files.map(file => appendFile(file, 'after-recovery\n')));
        await Promise.all(deliveries.map(delivery => delivery.promise));
    } finally {
        for (const stop of stops) stop();
        await rm(directory, { recursive: true, force: true });
    }
});
