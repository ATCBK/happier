import { describe, expect, it, vi } from 'vitest';

import { createScopedBatchResolutionSingleFlight } from './scopedResolutionSingleFlight';

describe('scoped batch pending reads', () => {
    it.each([33, 64])('gathers concurrent readers after %i asynchronous preparation steps', async preparationDepth => {
        const realTask = globalThis.setTimeout;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const reads = createScopedBatchResolutionSingleFlight<string>();
            const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
            const preparing = reads.reserve('details');
            const first = reads.run('details', ['a', 'b'], request);
            // Credential/carrier preparations have unequal promise depths.
            for (let depth = 0; depth < preparationDepth; depth += 1) await Promise.resolve();
            const second = preparing.run(['b', 'c'], request);
            // Observe a completed microtask checkpoint without advancing the
            // frozen timer queue used by consumer deadline/cleanup tests.
            await new Promise<void>(resolve => realTask(resolve, 0));
            expect(request.mock.calls.map(([ids]) => ids)).toEqual([['a', 'b', 'c']]);
            const [left, right] = await Promise.all([first, second]);
            expect([...left.keys()]).toEqual(['a', 'b']);
            expect([...right.keys()]).toEqual(['b', 'c']);
        } finally { vi.useRealTimers(); }
    });

    it('dispatches an unreserved first read promptly without advancing frozen timers', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const reads = createScopedBatchResolutionSingleFlight<string>();
            const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
            const result = reads.run('details', ['a'], request);
            await Promise.resolve();
            expect(request).toHaveBeenCalledTimes(1);
            expect([...await result]).toEqual([['a', 'a']]);
        } finally { vi.useRealTimers(); }
    });

    it('releases an aborted preparation without holding a ready borrower or selecting the departed ids', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const abort = new AbortController();
        const preparing = reads.reserve('details', { signal: abort.signal });
        const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
        const ready = reads.run('details', ['a'], request);
        await Promise.resolve();
        expect(request).not.toHaveBeenCalled();
        abort.abort();
        await expect(preparing.run(['b'], request)).rejects.toMatchObject({ name: 'AbortError' });
        expect([...await ready]).toEqual([['a', 'a']]);
        expect(request.mock.calls.map(([ids]) => ids)).toEqual([['a']]);
    });

    it('releases a failed preparation and does not hold other authority or projection partitions', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const scope = {};
        const preparing = reads.reserve('details', { scope });
        const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
        const ready = reads.run('details', ['held'], request, { scope });
        const independent = await Promise.all([
            reads.run('details', ['other-authority'], request, { scope: {} }),
            reads.run('messages', ['other-projection'], request, { scope }),
            reads.run('details', ['fresh'], request, { scope, fresh: true }),
        ]);
        expect(independent.map(result => [...result.keys()])).toEqual([['other-authority'], ['other-projection'], ['fresh']]);
        expect(request.mock.calls.some(([ids]) => ids.includes('held'))).toBe(false);
        preparing.release();
        preparing.release();
        expect([...await ready]).toEqual([['held', 'held']]);
    });

    it('isolates invalidation during preparation without holding or overwriting the successor', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const scope = {};
        const preparing = reads.reserve('details', { scope });
        const oldRequest = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, 'old'])));
        const old = reads.run('details', ['a'], oldRequest, { scope });
        await Promise.resolve();
        reads.invalidate(scope);
        const replacement = await reads.run('details', ['a'], async () => new Map([['a', 'new']]), { scope });
        expect([...replacement]).toEqual([['a', 'new']]);
        expect(oldRequest).not.toHaveBeenCalled();
        const prepared = preparing.run(['a', 'b'], oldRequest);
        expect([...await old]).toEqual([['a', 'old']]);
        expect([...await prepared]).toEqual([['a', 'old'], ['b', 'old']]);
        expect(oldRequest.mock.calls.map(([ids]) => ids)).toEqual([['a', 'b']]);
    });

    it('gathers matching authority paths without assigning reference ids', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const configuration = {};
        const material = {};
        const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
        const [left, right] = await Promise.all([
            reads.run('details', ['a', 'b'], request, { scope: [configuration, material] }),
            reads.run('details', ['b', 'c'], request, { scope: [configuration, material] }),
        ]);
        expect(request).toHaveBeenCalledTimes(1);
        expect([...left]).toEqual([['a', 'a'], ['b', 'b']]);
        expect([...right]).toEqual([['b', 'b'], ['c', 'c']]);
    });

    it('releases sibling waiters after a joined item fails while preserving an independent borrower', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        let rejectA!: (error: Error) => void;
        let signalB: AbortSignal | undefined;
        const first = reads.run('details', ['a'], () => new Promise((_resolve, reject) => { rejectA = reject; }));
        const firstFailure = expect(first).rejects.toThrow('a failed');
        await vi.waitFor(() => expect(rejectA).toBeTypeOf('function'));
        const mixed = reads.run('details', ['a', 'b'], (_ids, signal) => {
            signalB = signal;
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('b cancelled')), { once: true }));
        });
        const mixedFailure = expect(mixed).rejects.toThrow('a failed');
        const survivor = new AbortController();
        const remaining = reads.run('details', ['b'], async () => new Map(), { signal: survivor.signal });
        const cancelled = expect(remaining).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(signalB).toBeDefined());
        rejectA(new Error('a failed'));
        await Promise.all([firstFailure, mixedFailure]);
        expect(signalB?.aborted).toBe(false);
        survivor.abort();
        await cancelled;
        expect(signalB?.aborted).toBe(true);
    });

    it('gathers overlapping demands once and preserves each caller selection', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, `value:${id}`])));
        const [left, right] = await Promise.all([
            reads.run('details', ['a', 'b', 'a'], request),
            reads.run('details', ['b', 'c'], request),
        ]);
        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0]?.[0]).toEqual(['a', 'b', 'c']);
        expect([...left]).toEqual([['a', 'value:a'], ['b', 'value:b']]);
        expect([...right]).toEqual([['b', 'value:b'], ['c', 'value:c']]);
        await reads.run('details', ['b'], request);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('keeps the overlapping survivor alive after the initiating caller leaves', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const caller = new AbortController();
        let finish!: (value: ReadonlyMap<string, string>) => void;
        let physical: AbortSignal | undefined;
        const request = vi.fn((_ids: readonly string[], signal: AbortSignal) => {
            physical = signal;
            return new Promise<ReadonlyMap<string, string>>(resolve => { finish = resolve; });
        });
        const left = reads.run('details', ['a', 'b'], request, { signal: caller.signal });
        const cancelled = expect(left).rejects.toMatchObject({ name: 'AbortError' });
        const right = reads.run('details', ['b', 'c'], request);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        caller.abort();
        await cancelled;
        expect(physical?.aborted).toBe(false);
        finish(new Map([['a', 'A'], ['b', 'B'], ['c', 'C']]));
        expect([...await right]).toEqual([['b', 'B'], ['c', 'C']]);
    });

    it('keeps projection, authority and explicit fresh witnesses separate', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
        const scope = {};
        await Promise.all([
            reads.run('details', ['a'], request, { scope }),
            reads.run('details', ['a'], request, { scope: {} }),
            reads.run('messages', ['a'], request, { scope }),
            reads.run('details', ['a'], request, { scope, fresh: true }),
        ]);
        expect(request).toHaveBeenCalledTimes(4);
    });

    it('invalidates pending joins without cancelling incumbent borrowers', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const scope = {};
        let finish!: (value: ReadonlyMap<string, string>) => void;
        const old = reads.run('details', ['a'], () => new Promise<ReadonlyMap<string, string>>(resolve => { finish = resolve; }), { scope });
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        reads.invalidate(scope);
        const replacement = await reads.run('details', ['a'], async () => new Map([['a', 'new']]), { scope });
        finish(new Map([['a', 'old']]));
        expect([...await old]).toEqual([['a', 'old']]);
        expect([...replacement]).toEqual([['a', 'new']]);
    });
});
