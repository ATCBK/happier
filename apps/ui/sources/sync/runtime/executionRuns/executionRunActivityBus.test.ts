import { describe, expect, it, vi } from 'vitest';

import {
    notifyExecutionRunActivity,
    notifyExecutionRunActivityFromUpdate,
    notifyExecutionRunActivityReconnect,
    subscribeExecutionRunActivity,
} from './executionRunActivityBus';

describe('executionRunActivityBus', () => {
    it('wakes only the exact Machine demand and catches it up on its Home reconnect', () => {
        const own = vi.fn();
        const otherHome = vi.fn();
        const sameSessionId = vi.fn();
        const off = [subscribeExecutionRunActivity({ serverId: 'home-a', machineId: 'machine-one' }, own),
            subscribeExecutionRunActivity({ serverId: 'home-b', machineId: 'machine-one' }, otherHome),
            subscribeExecutionRunActivity({ serverId: 'home-a', sessionId: 'machine-one' }, sameSessionId)];
        try {
            notifyExecutionRunActivityFromUpdate('home-a', { type: 'execution-run-updated', machineId: 'machine-one', runId: 'run-one' });
            expect(own).toHaveBeenCalledExactlyOnceWith({ runId: 'run-one' });
            expect(otherHome).not.toHaveBeenCalled();
            expect(sameSessionId).not.toHaveBeenCalled();
            notifyExecutionRunActivityFromUpdate('home-a', { type: 'execution-run-updated', machineId: 'machine-one', sessionId: 'session-one', runId: 'run-one' });
            notifyExecutionRunActivityFromUpdate('home-a', { type: 'execution-run-updated', machineId: 'machine-one', runId: 'run-one', run: {} });
            expect(own).toHaveBeenCalledTimes(1);
            notifyExecutionRunActivityReconnect('home-a');
            expect(own).toHaveBeenLastCalledWith({ runId: null });
            expect(otherHome).not.toHaveBeenCalled();
        } finally { for (const dispose of off) dispose(); }
        own.mockClear();
        notifyExecutionRunActivityReconnect('home-a');
        expect(own).not.toHaveBeenCalled();
    });
    it('isolates listeners for duplicate raw Session ids across Homes', () => {
        const homeAListener = vi.fn();
        const homeBListener = vi.fn();
        const unsubscribeHomeA = subscribeExecutionRunActivity(
            { serverId: 'home-a', sessionId: 'same-session' },
            homeAListener,
        );
        const unsubscribeHomeB = subscribeExecutionRunActivity(
            { serverId: 'home-b', sessionId: 'same-session' },
            homeBListener,
        );

        notifyExecutionRunActivity({ serverId: 'home-b', sessionId: 'same-session' });

        expect(homeAListener).not.toHaveBeenCalled();
        expect(homeBListener).toHaveBeenCalledTimes(1);

        unsubscribeHomeA();
        unsubscribeHomeB();
    });

    it('catches up only demanded addresses in the reconnected Home', () => {
        const homeAListener = vi.fn();
        const homeBListener = vi.fn();
        const unsubscribeA = subscribeExecutionRunActivity({ serverId: 'home-a', sessionId: 's1' }, homeAListener);
        const unsubscribeB = subscribeExecutionRunActivity({ serverId: 'home-b', sessionId: 's1' }, homeBListener);
        notifyExecutionRunActivityReconnect('home-b');
        expect(homeAListener).not.toHaveBeenCalled();
        expect(homeBListener).toHaveBeenCalledWith({ runId: null });
        unsubscribeB();
        homeBListener.mockClear();
        notifyExecutionRunActivityReconnect('home-b');
        expect(homeBListener).not.toHaveBeenCalled();
        unsubscribeA();
    });
});
