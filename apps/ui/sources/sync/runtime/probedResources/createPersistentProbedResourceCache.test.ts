import { describe, expect, it, vi } from 'vitest';

import { createPersistentProbedResourceCache } from './createPersistentProbedResourceCache';

function createCache() {
    return createPersistentProbedResourceCache<string>({
        cacheId: 'owned-probe-test', persistKey: 'owned-probe-test', persistVersion: 1,
        persistMaxEntries: 1, persistMaxAgeMs: 100, staleTimeMs: 100, errorCooldownMs: 100,
        normalizePersistedValue: (raw) => typeof raw === 'string' ? raw : null,
    });
}

describe('persistent probe occurrence lifetime', () => {
    it('settles a departed consumer while retaining another consumer and its operation', async () => {
        const cache = createCache();
        const first = new AbortController();
        const second = new AbortController();
        let ownedSignal: AbortSignal | undefined;
        let complete!: (value: string) => void;
        const run = vi.fn((signal: AbortSignal) => {
            ownedSignal = signal;
            return new Promise<string>((resolve) => { complete = resolve; });
        });
        const departed = cache.runDedupe('shared', run, first.signal);
        const retained = cache.runDedupe('shared', run, second.signal);
        const cancelled = expect(departed).rejects.toMatchObject({ name: 'AbortError' });
        first.abort();
        await cancelled;
        expect(ownedSignal?.aborted).toBe(false);
        complete('native-result');
        await expect(retained).resolves.toBe('native-result');
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('abandons the final departed occurrence without trapping a remount or deleting its replacement', async () => {
        const cache = createCache();
        const controller = new AbortController();
        let oldSignal: AbortSignal | undefined;
        let finishOld!: (value: string) => void;
        const old = cache.runDedupe('same', (signal) => {
            oldSignal = signal;
            return new Promise<string>((resolve) => { finishOld = resolve; });
        }, controller.signal);
        const cancelled = expect(old).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort();
        await cancelled;
        expect(oldSignal?.aborted).toBe(true);
        let finishNew!: (value: string) => void;
        const replacement = cache.runDedupe('same', () => new Promise<string>((resolve) => { finishNew = resolve; }));
        finishOld('late-old-result');
        await Promise.resolve();
        const wrongRun = vi.fn(async () => 'wrong');
        const joined = cache.runDedupe('same', wrongRun);
        finishNew('new-result');
        await expect(replacement).resolves.toBe('new-result');
        await expect(joined).resolves.toBe('new-result');
        expect(wrongRun).not.toHaveBeenCalled();
    });

    it('retains an occurrence for callers with no cancellation signal', async () => {
        const cache = createCache();
        const controller = new AbortController();
        let ownedSignal: AbortSignal | undefined;
        let complete!: (value: string) => void;
        const retained = cache.runDedupe('legacy', (signal) => {
            ownedSignal = signal;
            return new Promise<string>((resolve) => { complete = resolve; });
        });
        const departed = cache.runDedupe('legacy', async () => 'wrong', controller.signal);
        const cancelled = expect(departed).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort();
        await cancelled;
        expect(ownedSignal?.aborted).toBe(false);
        complete('legacy-result');
        await expect(retained).resolves.toBe('legacy-result');
    });
});
