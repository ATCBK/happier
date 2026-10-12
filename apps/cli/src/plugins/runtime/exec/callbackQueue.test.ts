import { describe, expect, it, vi } from 'vitest';

import { createPluginProtocolCallbackQueue } from './callbackQueue';

describe('createPluginProtocolCallbackQueue', () => {
    it('retains more than 256 callbacks in order until they drain and accepts later work', async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const onFailure = vi.fn();
        const invoked: number[] = [];
        const queueSamples: Array<{
            family: 'plugin-protocol-callbacks';
            queuedItems: number;
            queuedBytes: number;
            backpressured: boolean;
        }> = [];
        const queue = createPluginProtocolCallbackQueue({
            onFailure,
            recordRuntimeLimitMeasurement: (sample) => {
                if (sample.family === 'plugin-protocol-callbacks') queueSamples.push(sample);
            },
        });

        try {
            for (let index = 0; index < 300; index += 1) {
                expect(queue.enqueue(1, async () => {
                    await blocked;
                    invoked.push(index);
                })).toBe(true);
            }
            expect(onFailure).not.toHaveBeenCalled();
            expect(queueSamples.at(-1)).toEqual({
                family: 'plugin-protocol-callbacks',
                queuedItems: 300,
                queuedBytes: 300,
                backpressured: false,
            });
            release();
            await queue.drained();
            expect(invoked).toEqual(Array.from({ length: 300 }, (_, index) => index));
            expect(queue.enqueue(1, () => { invoked.push(300); })).toBe(true);
            await queue.drained();
            expect(invoked.at(-1)).toBe(300);
            expect(queueSamples.at(-1)).toMatchObject({ queuedItems: 1, queuedBytes: 1 });
        } finally {
            release();
            await queue.drained();
        }
    });

    it('preserves an explicit caller callback count budget', async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const onFailure = vi.fn();
        const invoked: number[] = [];
        const queue = createPluginProtocolCallbackQueue({ maxPendingCallbacks: 2, onFailure });
        expect(queue.enqueue(1, async () => { await blocked; invoked.push(1); })).toBe(true);
        expect(queue.enqueue(1, () => { invoked.push(2); })).toBe(true);
        expect(queue.enqueue(1, () => { invoked.push(3); })).toBe(false);
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(onFailure).toHaveBeenCalledWith({ code: 'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED' });
        release();
        await queue.drained();
        expect(invoked).toEqual([1, 2]);
    });

    it('retains valid callbacks above 8 MiB aggregate bytes until they drain and accepts later work', async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const onFailure = vi.fn();
        const received: Array<{ index: number; bytes: number }> = [];
        const queue = createPluginProtocolCallbackQueue({ onFailure });
        try {
            for (let index = 0; index < 9; index += 1) {
                const payload = Buffer.alloc(1024 * 1024, index);
                expect(queue.enqueue(payload.byteLength, async () => {
                    await blocked;
                    received.push({ index: payload[0] ?? -1, bytes: payload.byteLength });
                })).toBe(true);
            }
            expect(onFailure).not.toHaveBeenCalled();
            expect(received).toEqual([]);
            release();
            await queue.drained();
            expect(received).toEqual(Array.from({ length: 9 }, (_, index) => ({ index, bytes: 1024 * 1024 })));
            expect(queue.enqueue(1, () => { received.push({ index: 9, bytes: 1 }); })).toBe(true);
            await queue.drained();
            expect(received.at(-1)).toEqual({ index: 9, bytes: 1 });
        } finally {
            release();
            await queue.drained();
        }
    });

    it('preserves an explicit caller byte budget and rejects bound plus one without invoking it', async () => {
        const maxPendingBytes = 64;
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const invoked: string[] = [];
        const queueSamples: Array<{
            family: 'plugin-protocol-callbacks';
            queuedItems: number;
            queuedBytes: number;
            backpressured: boolean;
        }> = [];
        const queue = createPluginProtocolCallbackQueue({
            maxPendingBytes,
            onFailure: () => undefined,
            recordRuntimeLimitMeasurement: (sample) => {
                if (sample.family === 'plugin-protocol-callbacks') queueSamples.push(sample);
            },
        });

        expect(queue.enqueue(maxPendingBytes, async () => {
            invoked.push('exact');
            await blocked;
        })).toBe(true);
        expect(queue.enqueue(1, async () => {
            invoked.push('overflow');
        })).toBe(false);
        release();
        await queue.drained();

        expect(invoked).toEqual(['exact']);
        expect(queueSamples).toEqual([
            {
                family: 'plugin-protocol-callbacks',
                queuedItems: 1,
                queuedBytes: maxPendingBytes,
                backpressured: false,
            },
            {
                family: 'plugin-protocol-callbacks',
                queuedItems: 2,
                queuedBytes: maxPendingBytes + 1,
                backpressured: true,
            },
        ]);
    });

    it('contains callback exceptions and stops later callbacks after the sticky failure', async () => {
        const invoked: string[] = [];
        const onFailure = vi.fn();
        const queue = createPluginProtocolCallbackQueue({
            maxPendingCallbacks: 10,
            maxPendingBytes: 100,
            onFailure,
        });
        queue.enqueue(1, async () => {
            invoked.push('throws');
            throw new Error('callback failed');
        });
        queue.enqueue(1, async () => {
            invoked.push('later');
        });

        await queue.drained();

        expect(invoked).toEqual(['throws']);
        expect(onFailure).toHaveBeenCalledTimes(1);
    });
});
