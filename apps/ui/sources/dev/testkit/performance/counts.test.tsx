import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createElement, StrictMode, Suspense } from 'react';

// Instrument tests do not need the root fixture/catalog import graph.
import { renderHook } from '../hooks/renderHook';
import { standardCleanup } from '../cleanup/standardCleanup';
import { countStoreNotifications, countTransportRequests, createRenderCommitCounter, useRenderCommitCounter } from './counts';
import { installTimerCensus } from './timerCensus';

afterEach(() => {
    standardCleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('performance count instruments', () => {
    it('counts hook renders and commits independently of the mount baseline', async () => {
        const counter = createRenderCommitCounter();
        const hook = await renderHook(({ value }: { value: number }) => {
            useRenderCommitCounter(counter);
            return value;
        }, { initialProps: { value: 1 } });
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
        counter.reset();
        await hook.rerender({ value: 2 });
        expect(hook.getCurrent()).toBe(2);
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
    });

    it('does not count a suspended render as a committed consumer', async () => {
        const counter = createRenderCommitCounter();
        const pending = new Promise<void>(() => {});
        const hook = await renderHook(({ suspended }: { suspended: boolean }) => {
            useRenderCommitCounter(counter);
            if (suspended) throw pending;
            return 'ready';
        }, {
            initialProps: { suspended: true },
            wrapper: ({ children }) => createElement(Suspense, { fallback: null }, children),
        });
        expect(counter.read().renders).toBeGreaterThan(0);
        expect(counter.read().commits).toBe(0);
        counter.reset();
        await hook.rerender({ suspended: false });
        expect(hook.getCurrent()).toBe('ready');
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
    });

    it('counts one commit when StrictMode replays an effect after rendering twice', async () => {
        const counter = createRenderCommitCounter();
        const hook = await renderHook(({ value }: { value: number }) => {
            useRenderCommitCounter(counter);
            return value;
        }, {
            initialProps: { value: 1 },
            wrapper: ({ children }) => createElement(StrictMode, null, children),
        });
        expect(counter.read()).toEqual({ renders: 2, commits: 1 });
        counter.reset();
        await hook.rerender({ value: 2 });
        expect(counter.read()).toEqual({ renders: 2, commits: 1 });
    });

    it('records every real Zustand notification with changed top-level keys, including empty merges', () => {
        const store = createStore(() => ({ row: { id: 'a' }, ready: false }));
        const counter = countStoreNotifications(store);
        store.setState(state => state);
        expect(counter.read()).toEqual([]);
        store.setState({});
        store.setState({ ready: true });
        expect(counter.read()).toEqual([[], ['ready']]);
        counter.reset();
        store.setState({ row: { id: 'a' } });
        expect(counter.read()).toEqual([['row']]);
        counter.stop();
        store.setState({ ready: false });
        expect(counter.read()).toEqual([['row']]);
    });

    it('counts physical requests by caller-selected route even when transport rejects', async () => {
        const transport = countTransportRequests(async (path: string) => {
            if (path === '/failed') throw new Error('transport rejected');
            return path;
        }, path => `GET ${path}`);
        expect(await transport.request('/sessions')).toBe('/sessions');
        await transport.request('/sessions');
        await expect(transport.request('/failed')).rejects.toThrow('transport rejected');
        expect(transport.read()).toEqual({ 'GET /sessions': 2, 'GET /failed': 1 });
        transport.reset();
        expect(transport.read()).toEqual({});
    });

    it('censuses live timers, preserves scheduling, and keeps unattributed timers visible', () => {
        vi.useFakeTimers();
        const census = installTimerCensus(stack => stack.includes('namedConsumer') ? 'relative age' : null);
        const fired = vi.fn();
        function namedConsumer() { return setTimeout(fired, 20); }
        namedConsumer();
        const orphan = setInterval(fired, 50);
        expect(census.read()).toEqual([
            { kind: 'timeout', delayMs: 20, consumer: 'relative age' },
            { kind: 'interval', delayMs: 50, consumer: null },
        ]);
        vi.advanceTimersByTime(20);
        expect(fired).toHaveBeenCalledTimes(1);
        expect(census.read()).toEqual([{ kind: 'interval', delayMs: 50, consumer: null }]);
        clearInterval(orphan);
        expect(census.read()).toEqual([]);
        const cancelled = setTimeout(fired, 20);
        clearTimeout(cancelled);
        expect(census.read()).toEqual([]);
        census.stop();
        setTimeout(fired, 20);
        expect(census.read()).toEqual([]);
    });
});
