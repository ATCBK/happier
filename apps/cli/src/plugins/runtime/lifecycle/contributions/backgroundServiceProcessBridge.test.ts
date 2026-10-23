import { describe, expect, it } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';
import { createBackgroundServiceProcessServiceClient, createBackgroundServiceProcessServiceHost, type BackgroundServiceProcessBridgeMessage } from './backgroundServiceProcessBridge';

function connect<T extends Readonly<Record<string, unknown>>>(services: T) {
    let client: ReturnType<typeof createBackgroundServiceProcessServiceClient<T>>;
    // JSON is the real transport boundary: never accidentally pass functions or signals by reference.
    const copy = (message: BackgroundServiceProcessBridgeMessage) => JSON.parse(JSON.stringify(message));
    const host = createBackgroundServiceProcessServiceHost({ services, send: (message) => queueMicrotask(() => client.receive(copy(message))) });
    client = createBackgroundServiceProcessServiceClient<T>({ description: JSON.parse(JSON.stringify(host.description)), send: (message) => queueMicrotask(() => host.receive(copy(message))) });
    return { host, client };
}

describe('background process service bridge', () => {
    it('preserves returned database handles, transaction callbacks, binary/bigint rows and errors', async () => {
        let committed: unknown;
        const pair = connect({ storage: { daemon: {
            consistency: () => ({ kind: 'authoritativeSerializable' }),
            database: async (_name: string, options: { migrations: { up(tx: { execute(sql: string): Promise<void> }): Promise<void> }[] }) => {
                await options.migrations[0]!.up({ execute: async (sql: string) => { committed = sql; } });
                return {
                    query: async () => [{ bytes: new Uint8Array([0, 255]), rowId: 9007199254740993n }],
                    transaction: async <T>(run: (tx: { execute(sql: string): Promise<void> }) => Promise<T>) => run({ execute: async (sql: string) => { committed = sql; } }),
                };
            },
        } }, actions: { execute: async () => { throw new PluginError({ code: 'approval_required', message: 'Requires approval', details: { operation: 'write' } }); } } });
        try {
            expect(pair.client.services.storage.daemon.consistency()).toEqual({ kind: 'authoritativeSerializable' });
            const db = await pair.client.services.storage.daemon.database('index', { migrations: [{ up: async (tx) => { await tx.execute('CREATE TABLE items'); } }] });
            expect(committed).toBe('CREATE TABLE items');
            expect(await db.query()).toEqual([{ bytes: new Uint8Array([0, 255]), rowId: 9007199254740993n }]);
            expect(await db.transaction(async (tx) => { await tx.execute('INSERT'); return 42; })).toBe(42);
            expect(committed).toBe('INSERT');
            await expect(pair.client.services.actions.execute()).rejects.toMatchObject({ data: { code: 'approval_required', details: { operation: 'write' } } });
        } finally { await pair.client.dispose(); await pair.host.dispose(); }
    });

    it('keeps scope selection and watches synchronous and drains subscriptions on disposal', async () => {
        const listeners = new Set<(value: string) => void>();
        const pair = connect({ settings: { forScope: (scope: { kind: 'daemon' | 'account' }) => ({
            describe: () => [{ id: scope.kind }],
            get: async () => scope.kind,
            watch(listener: (value: string) => void) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
        }) } });
        const values: string[] = [];
        const scoped = pair.client.services.settings.forScope({ kind: 'daemon' });
        expect(scoped.describe()).toEqual([{ id: 'daemon' }]);
        expect(await scoped.get()).toBe('daemon');
        const subscription = scoped.watch((value) => values.push(value));
        // A subsequent read is ordered after subscription admission on the same transport.
        await scoped.get();
        for (const listener of listeners) listener('changed');
        await scoped.get();
        expect(values).toEqual(['changed']);
        await subscription.dispose();
        expect(listeners.size).toBe(0);
        scoped.watch(() => {});
        await scoped.get();
        await pair.client.dispose();
        await pair.host.dispose();
        expect(listeners.size).toBe(0);
    });

    it('propagates cancellation and rejects pending calls when the channel closes', async () => {
        const pair = connect({ actions: { execute: async (options: { signal: AbortSignal }) => new Promise<void>((resolve, reject) => {
            if (options.signal.aborted) { reject(new Error('cancelled')); return; }
            options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }) } });
        const controller = new AbortController();
        const pending = pair.client.services.actions.execute({ signal: controller.signal });
        const rejected = expect(pending).rejects.toThrow('cancelled');
        controller.abort();
        await rejected;
        const disconnected = pair.client.services.actions.execute({ signal: new AbortController().signal });
        const closed = expect(disconnected).rejects.toMatchObject({ data: { code: 'background_service_process_bridge_closed' } });
        await pair.client.dispose();
        await pair.host.dispose();
        await closed;
    });

    it('retains cancellation after a handle opens and preserves its terminal promise', async () => {
        let observed: AbortSignal | undefined;
        const pair = connect({ transport: { open: async (options: { signal: AbortSignal }) => {
            observed = options.signal;
            let finish!: (value: string) => void;
            const closed = new Promise<string>((resolve) => { finish = resolve; });
            return { closed, dispose: async () => finish('disposed') };
        } } });
        try {
            const controller = new AbortController();
            const handle = await pair.client.services.transport.open({ signal: controller.signal });
            controller.abort({ kind: 'generationRetired' });
            await Promise.resolve();
            expect(observed?.aborted).toBe(true);
            expect(observed?.reason).toEqual({ kind: 'generationRetired' });
            await handle.dispose();
            expect(await handle.closed).toBe('disposed');
        } finally { await pair.client.dispose(); await pair.host.dispose(); }
    });

    it('drains nested follow subscriptions when the process disconnects', async () => {
        let following = false;
        const pair = connect({ sessions: { followTranscript: async (_listener: (value: string) => void) => {
            following = true;
            return { status: 'following', subscription: { dispose: async () => { following = false; } } };
        } } });
        await pair.client.services.sessions.followTranscript(() => {});
        expect(following).toBe(true);
        await pair.client.dispose();
        await pair.host.dispose();
        expect(following).toBe(false);
    });

    it('closes subscriptions acquired while disconnect was already settling', async () => {
        let enter!: () => void;
        let finish!: () => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const finishOpening = new Promise<void>((resolve) => { finish = resolve; });
        let disposed = false;
        const pair = connect({ sessions: { open: async () => {
            enter();
            await finishOpening;
            return { subscription: { dispose: () => { disposed = true; } } };
        } } });
        const pending = pair.client.services.sessions.open();
        await entered;
        await pair.client.dispose();
        await pair.host.dispose();
        finish();
        await Promise.allSettled([pending]);
        expect(disposed).toBe(true);
    });
});
