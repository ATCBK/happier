import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';

describe('useSearch (hook)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns a stable error code when search fails after retries', async () => {
        const searchFn = vi.fn().mockRejectedValue(new Error('boom'));
        const { useSearch } = await import('./useSearch');

        const hook = await renderHook(({ query }) => useSearch(query, searchFn), { initialProps: { query: 'abc' } });

        // Debounce delay
        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 300 });
        });

        // Retry delay (first attempt fails -> waits 750ms -> second attempt fails)
        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 750 });
        });

        expect(searchFn).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().error).toBe('searchFailed');
    });

    it('returns search results after debounce when search succeeds', async () => {
        const searchFn = vi.fn().mockResolvedValue(['alpha']);
        const { useSearch } = await import('./useSearch');

        const hook = await renderHook(({ query }) => useSearch(query, searchFn), { initialProps: { query: 'a' } });

        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 300 });
        });

        expect(searchFn).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().results).toEqual(['alpha']);
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().isSearching).toBe(false);
    });

    it('reuses cached results for repeated queries without calling search again', async () => {
        const searchFn = vi.fn().mockResolvedValue(['alpha']);
        const { useSearch } = await import('./useSearch');

        const hook = await renderHook(({ query }) => useSearch(query, searchFn), { initialProps: { query: 'alpha' } });

        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 300 });
        });
        expect(searchFn).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().results).toEqual(['alpha']);

        await hook.rerender({ query: '' });
        expect(hook.getCurrent().results).toEqual([]);

        await hook.rerender({ query: 'alpha' });
        expect(searchFn).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().results).toEqual(['alpha']);
    });

    it('retries the same failed query on request and caches its recovered answer', async () => {
        const searchFn = vi.fn<() => Promise<string[]>>().mockRejectedValue(new Error('offline'));
        const { useSearch } = await import('./useSearch');
        const hook = await renderHook(({ query }) => useSearch(query, searchFn), { initialProps: { query: 'Grace' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(1050); });
        expect(hook.getCurrent().error).toBe('searchFailed');
        searchFn.mockResolvedValue(['Grace']);
        await act(async () => { hook.getCurrent().retry(); });
        expect(hook.getCurrent().results).toEqual(['Grace']);
        expect(hook.getCurrent().error).toBeNull();
        await hook.rerender({ query: '' });
        await hook.rerender({ query: 'Grace' });
        expect(hook.getCurrent().results).toEqual(['Grace']);
        expect(searchFn).toHaveBeenCalledTimes(3);
    });

    it('keeps the latest query and retry answer when superseded requests settle later', async () => {
        const pending: Array<(rows: string[]) => void> = [];
        const searchFn = vi.fn(() => new Promise<string[]>((resolve) => pending.push(resolve)));
        const { useSearch } = await import('./useSearch');
        const hook = await renderHook(({ query }) => useSearch(query, searchFn), { initialProps: { query: 'old' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        await hook.rerender({ query: 'current' });
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        await act(async () => { hook.getCurrent().retry(); });
        await act(async () => { pending[2]!(['current answer']); });
        await act(async () => { pending[0]!(['old answer']); pending[1]!(['superseded retry answer']); });
        expect(hook.getCurrent().results).toEqual(['current answer']);
        await hook.rerender({ query: '' });
        await hook.rerender({ query: 'current' });
        expect(hook.getCurrent().results).toEqual(['current answer']);
        await hook.rerender({ query: 'last' });
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        await hook.rerender({ query: '' });
        await act(async () => { pending[3]!(['cleared answer']); });
        expect(hook.getCurrent().results).toEqual([]);
    });
});
