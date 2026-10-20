import { describe, expect, it } from 'vitest';

import { observeLazyPrismaQuery } from './accountPublicationContention.testkit';

// A lazy database-boundary fixture: query construction has no effect, while
// consumption and transaction binding preserve the real Prisma promise shape.
function lazyQuery(operation: () => unknown) {
    let running: Promise<unknown> | undefined;
    const run = () => running ??= Promise.resolve().then(operation);
    return {
        then: (fulfilled?: (value: unknown) => unknown, rejected?: (error: unknown) => unknown) => run().then(fulfilled, rejected),
        catch: (rejected: (error: unknown) => unknown) => run().catch(rejected),
        finally: (settled: () => void) => run().finally(settled),
        [Symbol.toStringTag]: 'PrismaPromise',
    };
}

describe('Account contention query observer', () => {
    it('awaits an optional peer hook before consuming the native lazy query', async () => {
        const events: string[] = [];
        let release!: () => void;
        const peerCommitted = new Promise<void>(resolve => { release = resolve; });
        const observed = observeLazyPrismaQuery(lazyQuery(() => {
            events.push('query');
            return 'row';
        }), () => ({
            started: () => { events.push('started'); },
            settled: succeeded => { events.push(succeeded ? 'fulfilled' : 'rejected'); },
        }), async () => {
            events.push('peer started');
            await peerCommitted;
            events.push('peer committed');
        });
        expect(events).toEqual([]);
        const consumed = Promise.resolve(observed);
        await new Promise<void>(resolve => setImmediate(resolve));
        try {
            expect(events).toEqual(['peer started']);
        } finally {
            release();
        }
        expect(await consumed).toBe('row');
        expect(events).toEqual(['peer started', 'peer committed', 'started', 'query', 'fulfilled']);
        expect(await observed).toBe('row');
        expect(events).toHaveLength(5);
    });

    it('propagates a peer hook rejection without consuming the native query', async () => {
        const error = new Error('peer publication rejected');
        let nativeConsumed = false;
        const observed = observeLazyPrismaQuery(lazyQuery(() => { nativeConsumed = true; }), () => ({
            started: () => {}, settled: () => {},
        }), async () => { throw error; });
        await expect(observed).rejects.toBe(error);
        await expect(observed).rejects.toBe(error);
        expect(nativeConsumed).toBe(false);
    });

    it('leaves construction lazy and starts inside the scheduler only when consumed', async () => {
        const events: string[] = [];
        const query = lazyQuery(() => { events.push('query'); return { id: 'row' }; });
        const observed = observeLazyPrismaQuery(query, () => ({
            started: () => { events.push('started'); },
            settled: succeeded => { events.push(succeeded ? 'fulfilled' : 'rejected'); },
        }));
        await Promise.resolve();
        expect(events).toEqual([]);
        // The production inTx owner refreshes statement_timeout immediately
        // before assimilating this thenable. Construction must not escape it.
        const scheduled = Promise.resolve().then(async () => {
            events.push('statement budget');
            return await observed;
        });
        expect(await scheduled).toEqual({ id: 'row' });
        expect(events).toEqual(['statement budget', 'started', 'query', 'fulfilled']);
        expect(await observed).toEqual({ id: 'row' });
        expect(events).toHaveLength(4);
    });

    it('retains rejection identity and observes failure once across consumers', async () => {
        const error = new Error('database rejected');
        const outcomes: boolean[] = [];
        const observed = observeLazyPrismaQuery(lazyQuery(() => { throw error; }), () => ({
            started: () => {}, settled: succeeded => { outcomes.push(succeeded); },
        }));
        await expect(observed).rejects.toBe(error);
        await expect(observed).rejects.toBe(error);
        expect(outcomes).toEqual([false]);
    });

    it('preserves fluent receivers, transaction arguments and derived lazy queries', async () => {
        const observations: string[] = [];
        const transaction = { kind: 'batch', id: 'transaction' };
        const query = {
            ...lazyQuery(() => 'root'),
            relation(this: object, name: string) {
                expect(this).toBe(query);
                return lazyQuery(() => `relation:${name}`);
            },
            requestTransaction(this: object, requested: unknown) {
                expect(this).toBe(query);
                expect(requested).toBe(transaction);
                return { ...lazyQuery(() => requested), transaction: requested };
            },
        };
        const observed = observeLazyPrismaQuery(query, () => ({
            started: () => { observations.push('started'); },
            settled: succeeded => { observations.push(succeeded ? 'fulfilled' : 'rejected'); },
        }));
        if (!observed || typeof observed !== 'object') throw new Error('Expected query object');
        const relation: unknown = Reflect.apply(Reflect.get(observed, 'relation'), observed, ['account']);
        const bound: unknown = Reflect.apply(Reflect.get(observed, 'requestTransaction'), observed, [transaction]);
        expect(observations).toEqual([]);
        expect(Object.prototype.toString.call(observed)).toBe('[object PrismaPromise]');
        expect(await relation).toBe('relation:account');
        expect(bound && typeof bound === 'object' ? Reflect.get(bound, 'transaction') : null).toBe(transaction);
        expect(await bound).toBe(transaction);
        expect(observations).toEqual(['started', 'fulfilled', 'started', 'fulfilled']);
    });
});
