import { describe, expect, it } from 'vitest';
import { createBackdropRenderCache } from './backdropRenderCache';

describe('backdrop cached rendering', () => {
    it('shares an in-flight render and retains completed pixels for the same key', async () => {
        let started = 0;
        const cache = createBackdropRenderCache(async () => { started += 1; return { pixels: started }; });
        const first = cache.render('one');
        const second = cache.render('one');
        expect(first).toBe(second);
        expect(await first).toEqual({ pixels: 1 });
        expect(await cache.render('one')).toEqual({ pixels: 1 });
        expect(await cache.render('different-size')).toEqual({ pixels: 2 });
    });
    it('does not keep a failed render, allowing the next visit to recover', async () => {
        let attempts = 0;
        const cache = createBackdropRenderCache(async () => { if (++attempts === 1) throw new Error('image unavailable'); return 'ready'; });
        await expect(cache.render('picture')).rejects.toThrow('image unavailable');
        await expect(cache.render('picture')).resolves.toBe('ready');
    });
    it('does not let a released render evict its replacement after a worker is remounted', async () => {
        let rejectOld!: (error: Error) => void;
        let finishNew!: (value: string) => void;
        let attempts = 0;
        const cache = createBackdropRenderCache(() => ++attempts === 1
            ? new Promise<string>((_resolve, reject) => { rejectOld = reject; })
            : new Promise<string>(resolve => { finishNew = resolve; }));
        const old = cache.render('picture');
        cache.clear();
        const replacement = cache.render('picture');
        rejectOld(new Error('worker unmounted'));
        await expect(old).rejects.toThrow('worker unmounted');
        expect(cache.render('picture')).toBe(replacement);
        finishNew('pixels');
        await expect(replacement).resolves.toBe('pixels');
    });
});
