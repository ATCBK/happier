import { describe, expect, it, vi } from 'vitest';
import { waitForTestEvent } from './waitForTestEvent';

describe('waitForTestEvent', () => {
    it('rechecks an unchanged assertion only on real publications', async () => {
        let state = 'preparing';
        const listeners = new Set<() => void>();
        const assertion = vi.fn(() => { expect(state).toBe('connected'); });
        let settled = false;
        const result = waitForTestEvent(notify => {
            listeners.add(notify);
            return () => { listeners.delete(notify); };
        }, assertion).then(() => { settled = true; });
        await Promise.resolve();
        state = 'connected';
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(assertion).toHaveBeenCalledOnce();
        for (const notify of listeners) notify();
        await result;
        expect(assertion).toHaveBeenCalledTimes(2);
        expect(listeners.size).toBe(0);
    });

    it('observes a real publication and releases its subscription after the matching state', async () => {
        let state = 'preparing';
        const listeners = new Set<() => void>();
        const unsubscribe = vi.fn();
        const result = waitForTestEvent(notify => {
            listeners.add(notify);
            return () => { listeners.delete(notify); unsubscribe(); };
        }, () => state, value => value === 'connected');
        state = 'connecting';
        for (const notify of listeners) notify();
        expect(listeners.size).toBe(1);
        state = 'connected';
        for (const notify of listeners) notify();
        await expect(result).resolves.toBe('connected');
        expect(listeners.size).toBe(0);
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('accepts already-published state without retaining a subscription', async () => {
        const unsubscribe = vi.fn();
        await expect(waitForTestEvent(() => unsubscribe, () => 2, value => value === 2)).resolves.toBe(2);
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('cleans up when subscribing synchronously publishes the matching state', async () => {
        const unsubscribe = vi.fn();
        await expect(waitForTestEvent(notify => {
            notify();
            return unsubscribe;
        }, () => true, Boolean)).resolves.toBe(true);
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('rejects a failed observation and releases the subscription', async () => {
        const unsubscribe = vi.fn();
        const failure = new Error('observation failed');
        await expect(waitForTestEvent(() => unsubscribe, () => { throw failure; }, () => true))
            .rejects.toBe(failure);
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
});
