import { describe, expect, it, vi } from 'vitest';

import { ImagePreviewCache } from './imagePreviewCache';

describe('ImagePreviewCache', () => {
    it('shares an in-flight fill and keeps it alive while another consumer remains', async () => {
        const cache = new ImagePreviewCache({ maxEntries: 0, maxTotalBytes: 1_000, now: () => 1_000 });
        const key = { sessionId: 'workspace', signature: 'version', filePath: 'a.png' };
        let settle!: (value: import('./imagePreviewCache').ImagePreviewCacheValue) => void;
        let signal!: AbortSignal;
        const cleanup = vi.fn();
        cache.retain(key);
        cache.retain(key);
        const first = cache.load(key, current => { signal = current; return new Promise(resolve => { settle = resolve; }); });
        const second = cache.load(key, async () => ({ status: 'loaded', uri: 'blob:duplicate' }));
        cache.release(key);
        expect(signal.aborted).toBe(false);
        settle({ status: 'loaded', uri: 'blob:shared', cleanup });
        expect(await first).toMatchObject({ uri: 'blob:shared' });
        expect(await second).toMatchObject({ uri: 'blob:shared' });
        expect(cleanup).not.toHaveBeenCalled();
        cache.release(key);
        expect(cleanup).toHaveBeenCalledOnce();
    });
    it('allows a failed fill to recover on retry', async () => {
        const cache = new ImagePreviewCache({ maxEntries: 10, maxTotalBytes: 1_000, now: () => 1_000 });
        const key = { sessionId: 'workspace', signature: 'version', filePath: 'a.png' };
        cache.retain(key);
        expect(await cache.load(key, async () => ({ status: 'error', error: 'File unavailable' }))).toMatchObject({ status: 'error' });
        expect(await cache.load(key, async () => ({ status: 'loaded', uri: 'blob:retry' }))).toMatchObject({ uri: 'blob:retry' });
        cache.release(key);
    });
    it('does not replace a mounted retry with an earlier cancelled fill', async () => {
        const cache = new ImagePreviewCache({ maxEntries: 10, maxTotalBytes: 1_000, now: () => 1_000 });
        const key = { sessionId: 'workspace', signature: 'version', filePath: 'a.png' };
        let settleFirst!: (value: import('./imagePreviewCache').ImagePreviewCacheValue) => void;
        const staleCleanup = vi.fn();
        cache.retain(key);
        const first = cache.load(key, () => new Promise(resolve => { settleFirst = resolve; }));
        cache.release(key);
        cache.retain(key);
        await cache.load(key, async () => ({ status: 'loaded', uri: 'blob:retry' }));
        settleFirst({ status: 'loaded', uri: 'blob:cancelled', cleanup: staleCleanup });
        await first;
        expect(cache.get(key)).toMatchObject({ uri: 'blob:retry' });
        expect(staleCleanup).toHaveBeenCalledOnce();
        cache.release(key);
    });
    it('keeps a mounted preview alive until its last consumer releases it', () => {
        const cleanup = vi.fn();
        const cache = new ImagePreviewCache({ maxEntries: 1, maxTotalBytes: 10, now: () => 1_000 });
        const key = { sessionId: 'workspace', signature: 'version', filePath: 'a.png' };
        cache.retain(key);
        cache.retain(key);
        cache.set(key, { status: 'loaded', uri: 'blob:a', byteLength: 20, cleanup });
        cache.set({ ...key, filePath: 'b.png' }, { status: 'loaded', uri: 'blob:b' });
        expect(cache.get(key)).toMatchObject({ uri: 'blob:a' });
        cache.release(key);
        expect(cleanup).not.toHaveBeenCalled();
        cache.release(key);
        expect(cache.get(key)).toBeNull();
        expect(cleanup).toHaveBeenCalledOnce();
    });
    it('evicts least-recently used entries when maxEntries is exceeded', () => {
        const cleanup = vi.fn();
        const cache = new ImagePreviewCache({ maxEntries: 1, maxTotalBytes: 1_000_000, now: () => 1_000 });
        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' }, { status: 'loaded', uri: 'blob:a', cleanup });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })?.status).toBe('loaded');

        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' }, { status: 'loaded', uri: 'blob:b' });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })).toBeNull();
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' })?.status).toBe('loaded');
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('evicts entries to satisfy maxTotalBytes', () => {
        const cache = new ImagePreviewCache({ maxEntries: 10, maxTotalBytes: 20, now: () => 1_000 });
        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' }, { status: 'loaded', uri: '12345' });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })?.status).toBe('loaded');

        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' }, { status: 'loaded', uri: '123456' });
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' })).toBeNull();
        expect(cache.get({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' })?.status).toBe('loaded');
    });

    it('cleans up replaced loaded entries', () => {
        const cleanup = vi.fn();
        const cache = new ImagePreviewCache({ maxEntries: 10, maxTotalBytes: 1_000_000, now: () => 1_000 });

        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' }, { status: 'loaded', uri: 'blob:a', cleanup });
        cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'a.png' }, { status: 'loaded', uri: 'blob:a2' });

        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('suppresses async cleanup rejections during eviction', async () => {
        const cache = new ImagePreviewCache({ maxEntries: 1, maxTotalBytes: 1_000_000, now: () => 1_000 });

        cache.set(
            { sessionId: 's1', signature: 'sig1', filePath: 'a.png' },
            { status: 'loaded', uri: 'blob:a', cleanup: async () => { throw new Error('cleanup failed'); } },
        );

        expect(() => {
            cache.set({ sessionId: 's1', signature: 'sig1', filePath: 'b.png' }, { status: 'loaded', uri: 'blob:b' });
        }).not.toThrow();
        await Promise.resolve();
    });
});
