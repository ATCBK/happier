import { describe, expect, it, vi } from 'vitest';

import { createScopedResolutionSingleFlight } from './scopedResolutionSingleFlight';

describe('scoped pending read ownership', () => {
    it.each(['throw', 'abort'] as const)('isolates a first borrower that refuses issuance by %s', async refusal => {
        const reads = createScopedResolutionSingleFlight<number>();
        const controller = new AbortController();
        const refused = new Error('Borrower retired before issuance');
        const dispatched: string[] = [];
        const request = vi.fn(async (_signal: AbortSignal, onIssued: () => void) => {
            onIssued();
            dispatched.push('physical');
            return 42;
        });
        const first = reads.run('row', request, { signal: controller.signal, onIssued: () => {
            if (refusal === 'abort') controller.abort(refused);
            else throw refused;
        } });
        const second = reads.run('row', request, { onIssued: () => dispatched.push('second') });
        expect(await Promise.allSettled([first, second])).toEqual([
            { status: 'rejected', reason: refused }, { status: 'fulfilled', value: 42 },
        ]);
        expect(request).toHaveBeenCalledTimes(1);
        expect(dispatched).toEqual(['second', 'physical']);
    });

    it('prevents physical dispatch when its final borrower refuses issuance', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const dispatched = vi.fn();
        const refused = new Error('Borrower retired before issuance');
        await expect(reads.run('row', async (_signal, onIssued) => {
            onIssued();
            dispatched();
            return 42;
        }, { onIssued: () => { throw refused; } })).rejects.toBe(refused);
        expect(dispatched).not.toHaveBeenCalled();
    });

    it('marks a post-issuance joiner as issued and detaches its cancellation without replay', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const issued = vi.fn();
        const controller = new AbortController();
        let finish!: (value: number) => void;
        let physicalSignal: AbortSignal | null = null;
        const request = vi.fn(async (signal: AbortSignal, onIssued: () => void) => {
            physicalSignal = signal;
            onIssued();
            return await new Promise<number>(resolve => { finish = resolve; });
        });
        const first = reads.run('row', request);
        await Promise.resolve();
        const joined = reads.run('row', request, { signal: controller.signal, onIssued: issued });
        const cancelled = expect(joined).rejects.toMatchObject({ name: 'AbortError' });
        expect(issued).toHaveBeenCalledTimes(1);
        controller.abort();
        await cancelled;
        expect(physicalSignal).toHaveProperty('aborted', false);
        finish(42);
        await expect(first).resolves.toBe(42);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('owns a prepared physical resource before its first borrower leaves, while keeping a survivor alive', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const caller = new AbortController();
        let transferred = false;
        let closed = false;
        let finish!: (value: number) => void;
        const response = new Promise<number>(resolve => { finish = resolve; });
        const request = vi.fn(async () => {
            if (closed) throw new Error('Physical resource was released before dispatch');
            return await response;
        });
        const firstOptions = { signal: caller.signal, onPhysicalAcquire: () => {
            transferred = true;
            return async () => { closed = true; };
        } };
        const first = reads.run('row', request, firstOptions);
        const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        const joinedOptions = { onPhysicalAcquire: () => { throw new Error('A joiner must release its own unused resource'); } };
        const survivor = reads.run('row', request, joinedOptions);
        // The provider's ordinary borrower cleanup runs before the deferred
        // physical resolver. Only synchronous custody transfer may retain it.
        caller.abort();
        if (!transferred) closed = true;
        finish(42);
        await cancelled;
        await expect(survivor).resolves.toBe(42);
        expect(request).toHaveBeenCalledTimes(1);
        expect(closed).toBe(true);
    });

    it('releases prepared custody when every borrower leaves before physical dispatch', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const caller = new AbortController();
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        const request = vi.fn(async () => 1);
        const options = { signal: caller.signal, onPhysicalAcquire: () => () => release() };
        const pending = reads.run('row', request, options);
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        caller.abort();
        await cancelled;
        await vi.waitFor(() => expect(request).not.toHaveBeenCalled());
        const disposal = vi.fn();
        void released.then(disposal);
        await vi.waitFor(() => expect(disposal).toHaveBeenCalledTimes(1));
    });

    it('partitions by each existing authority reference and invalidates a whole configuration prefix', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const configuration = {};
        const replacementConfiguration = {};
        const material = {};
        const replacementMaterial = {};
        let finish!: (value: number) => void;
        const response = new Promise<number>(resolve => { finish = resolve; });
        const request = vi.fn(async () => await response);
        const pending = [
            reads.run('row', request, { scope: [configuration, material] }),
            reads.run('row', request, { scope: [configuration, material] }),
            reads.run('row', request, { scope: [configuration, replacementMaterial] }),
            reads.run('row', request, { scope: [replacementConfiguration, material] }),
        ];
        try {
            await Promise.resolve();
            expect(request).toHaveBeenCalledTimes(3);
            reads.invalidate(configuration);
            pending.push(reads.run('row', request, { scope: [configuration, material] }));
            pending.push(reads.run('row', request, { scope: [replacementConfiguration, material] }));
            await Promise.resolve();
            expect(request).toHaveBeenCalledTimes(4);
            finish(9);
            await expect(Promise.all(pending)).resolves.toEqual([9, 9, 9, 9, 9, 9]);
        } finally {
            finish(9);
            await Promise.allSettled(pending);
        }
    });

    it('detaches a cancelled borrower without cancelling a surviving reader', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const caller = new AbortController();
        let finish!: (value: number) => void;
        let transportSignal: AbortSignal | undefined;
        const request = vi.fn((signal: AbortSignal) => {
            transportSignal = signal;
            return new Promise<number>(resolve => { finish = resolve; });
        });
        const first = reads.run('row', request, { signal: caller.signal });
        const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        const second = reads.run('row', request);
        await Promise.resolve();
        caller.abort();
        finish(42);
        await cancelled;
        expect(request).toHaveBeenCalledTimes(1);
        expect(transportSignal?.aborted).toBe(false);
        expect(await second).toBe(42);
    });

    it('cancels the last departed read and does not let a replacement join it', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const caller = new AbortController();
        let oldSignal: AbortSignal | undefined;
        let finishOld!: (value: number) => void;
        const first = reads.run('row', signal => {
            oldSignal = signal;
            return new Promise<number>(resolve => { finishOld = resolve; });
        }, { signal: caller.signal });
        const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await Promise.resolve();
        caller.abort();
        finishOld(1);
        await cancelled;
        expect(oldSignal?.aborted).toBe(true);
        expect(await reads.run('row', async () => 2)).toBe(2);
        await Promise.resolve();
        expect(await reads.run('row', async () => 3)).toBe(3);
    });

    it('does not dispatch already-cancelled demand and isolates exact authority objects', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const cancelled = new AbortController();
        cancelled.abort();
        const request = vi.fn(async () => 1);
        await expect(reads.run('row', request, { signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(request).not.toHaveBeenCalled();
        const authorityA = {};
        const authorityB = {};
        let finish!: (value: number) => void;
        const a = reads.run('row', () => new Promise<number>(resolve => { finish = resolve; }), { scope: authorityA });
        const b = reads.run('row', async () => 2, { scope: authorityB });
        expect(await b).toBe(2);
        finish(1);
        expect(await a).toBe(1);
    });

    it('forgets failures and settled values rather than caching them', async () => {
        const reads = createScopedResolutionSingleFlight<number>();
        const error = new Error('unavailable');
        const request = vi.fn(async () => { throw error; });
        const results = await Promise.allSettled([reads.run('row', request), reads.run('row', request)]);
        expect(results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
        expect(request).toHaveBeenCalledTimes(1);
        expect(await reads.run('row', async () => 2)).toBe(2);
        expect(await reads.run('row', async () => 3)).toBe(3);
    });
});
