import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, createDeferred, homeAccountPickerRowFixture, renderHook, standardCleanup } from '@/dev/testkit';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';

// The HTTP and credential-store boundaries are replaced; scoped Action execution and search stay real.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { useHomeAccountSearch } = await import('./useHomeAccountSearch');
const SEARCH_PATH = '/v1/home/accounts/search';

beforeEach(async () => {
    resetServerFeaturesClientForTests();
    await harness.reset();
    vi.useFakeTimers();
});

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
});

describe('useHomeAccountSearch', () => {
    it('withdraws same-scope cached and pending answers on loss of authority and reads afresh when re-enabled', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://withdraw-search.example', accountId: 'account-a' });
        const scope = { serverId: home, accountId: 'account-a' };
        const ada = homeAccountPickerRowFixture('ada', 'Ada');
        harness.answer(home, SEARCH_PATH, { body: { accounts: [ada] } });
        const hook = await renderHook(({ enabled, query }) => useHomeAccountSearch(scope, query, enabled), {
            initialProps: { enabled: true, query: 'Ada' },
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(hook.getCurrent().rows).toEqual([ada]);
        const held = createDeferred<void>();
        harness.answer(home, SEARCH_PATH, { body: { accounts: [ada] }, respondAfter: held.promise });
        await hook.rerender({ enabled: true, query: 'Ad' });
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        await hook.rerender({ enabled: false, query: 'Ada' });
        expect(hook.getCurrent()).toMatchObject({ rows: [], searching: false, failure: null });
        await act(async () => { hook.getCurrent().retry(); held.resolve(); await vi.advanceTimersByTimeAsync(1050); });
        expect(hook.getCurrent().rows).toEqual([]);
        expect(harness.requestsFor(SEARCH_PATH)).toHaveLength(2);
        const fresh = homeAccountPickerRowFixture('fresh-ada', 'Ada');
        harness.answer(home, SEARCH_PATH, { body: { accounts: [fresh] } });
        await hook.rerender({ enabled: true, query: 'Ada' });
        expect(hook.getCurrent().rows).toEqual([]);
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(hook.getCurrent().rows).toEqual([fresh]);
        expect(harness.requestsFor(SEARCH_PATH)).toHaveLength(3);
    });

    it('searches the new Home and Account for the same query without exposing another scope’s cached rows', async () => {
        const homeA = await harness.addHome({ name: 'Home A', serverUrl: 'https://search-a.example', accountId: 'account-a' });
        const homeB = await harness.addHome({ name: 'Home B', serverUrl: 'https://search-b.example', accountId: 'account-a' });
        const adaA = homeAccountPickerRowFixture('ada-a', 'Ada A');
        const adaB = homeAccountPickerRowFixture('ada-b', 'Ada B');
        const adaC = homeAccountPickerRowFixture('ada-c', 'Ada C');
        harness.answer(homeA, SEARCH_PATH, { body: { accounts: [adaA] } });
        harness.answer(homeB, SEARCH_PATH, { body: { accounts: [adaB] } });
        const hook = await renderHook(({ scope, query }) => useHomeAccountSearch(scope, query, true), {
            initialProps: { scope: { serverId: homeA, accountId: 'account-a' }, query: ' Ada ' },
        });
        expect(harness.requestsFor(SEARCH_PATH)).toHaveLength(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(hook.getCurrent().rows).toEqual([adaA]);

        await hook.rerender({ scope: { serverId: homeB, accountId: 'account-a' }, query: ' Ada ' });
        expect(hook.getCurrent().rows).toEqual([]);
        expect(hook.getCurrent().searching).toBe(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(hook.getCurrent().rows).toEqual([adaB]);
        expect(harness.requestsFor(SEARCH_PATH).map(request => request.serverId)).toEqual([homeA, homeB]);

        await harness.switchAccount(homeB, 'account-b');
        harness.answer(homeB, SEARCH_PATH, { body: { accounts: [adaC] } });
        await hook.rerender({ scope: { serverId: homeB, accountId: 'account-b' }, query: ' Ada ' });
        expect(hook.getCurrent().rows).toEqual([]);
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(hook.getCurrent().rows).toEqual([adaC]);
        expect(harness.requestsFor(SEARCH_PATH)).toHaveLength(3);

        await hook.rerender({ scope: { serverId: homeA, accountId: 'account-a' }, query: ' Ada ' });
        expect(hook.getCurrent().rows).toEqual([adaA]);
        expect(harness.requestsFor(SEARCH_PATH)).toHaveLength(3);
    });

    it('withdraws all protected answers for the refusing scope, without retrying or carrying refusals into another Home', async () => {
        const homeA = await harness.addHome({ name: 'Home A', serverUrl: 'https://refusal-a.example', accountId: 'account-a' });
        const homeB = await harness.addHome({ name: 'Home B', serverUrl: 'https://refusal-b.example', accountId: 'account-a' });
        harness.answer(homeA, SEARCH_PATH, { status: 403, body: { error: 'forbidden' } });
        const ada = homeAccountPickerRowFixture('ada', 'Ada');
        harness.answer(homeB, SEARCH_PATH, { body: { accounts: [ada] } });
        const hook = await renderHook(({ scope, query }) => useHomeAccountSearch(scope, query, true), {
            initialProps: { scope: { serverId: homeA, accountId: 'account-a' }, query: 'Ada' },
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(1050); });
        expect(hook.getCurrent().failure).toMatchObject({ kind: 'forbidden', retryable: false });
        expect(harness.requestsFor(SEARCH_PATH)).toHaveLength(1);

        await hook.rerender({ scope: { serverId: homeB, accountId: 'account-a' }, query: 'Ada' });
        expect(hook.getCurrent().failure).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(hook.getCurrent().rows).toEqual([ada]);

        harness.answer(homeB, SEARCH_PATH, { status: 403, body: { error: 'forbidden' } });
        await hook.rerender({ scope: { serverId: homeB, accountId: 'account-a' }, query: 'Grace' });
        await act(async () => { await vi.advanceTimersByTimeAsync(1050); });
        expect(hook.getCurrent().failure).toMatchObject({ kind: 'forbidden', retryable: false });
        expect(hook.getCurrent().rows).toEqual([]);
        await hook.rerender({ scope: { serverId: homeB, accountId: 'account-a' }, query: 'Ada' });
        expect(hook.getCurrent().rows).toEqual([]);
        expect(hook.getCurrent().searching).toBe(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(hook.getCurrent().failure?.kind).toBe('forbidden');

        const fresh = homeAccountPickerRowFixture('fresh', 'Ada');
        harness.answer(homeB, SEARCH_PATH, { body: { accounts: [fresh] } });
        await act(async () => { hook.getCurrent().retry(); });
        expect(hook.getCurrent().rows).toEqual([fresh]);

        await hook.rerender({ scope: { serverId: homeA, accountId: 'account-a' }, query: 'Ada' });
        expect(hook.getCurrent().rows).toEqual([]);
        expect(hook.getCurrent().failure).toMatchObject({ kind: 'forbidden', retryable: false });
        expect(harness.requestsFor(SEARCH_PATH)).toHaveLength(5);
    });

    it('retains the last rows and cached answer through a transient failure', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://retain-search.example', accountId: 'account-a' });
        const scope = { serverId: home, accountId: 'account-a' };
        const ada = homeAccountPickerRowFixture('ada', 'Ada');
        harness.answer(home, SEARCH_PATH, { body: { accounts: [ada] } });
        const hook = await renderHook(({ query }) => useHomeAccountSearch(scope, query, true), { initialProps: { query: 'Ada' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(hook.getCurrent().rows).toEqual([ada]);
        harness.answer(home, SEARCH_PATH, { status: 503, body: { error: 'temporarily_unavailable' } });
        await hook.rerender({ query: 'Grace' });
        await act(async () => { await vi.advanceTimersByTimeAsync(1050); });
        expect(hook.getCurrent()).toMatchObject({ rows: [ada], searching: false, failure: { retryable: true } });
        await hook.rerender({ query: 'Ada' });
        expect(hook.getCurrent().rows).toEqual([ada]);
        expect(hook.getCurrent().failure).toBeNull();
        expect(harness.requestsFor(SEARCH_PATH)).toHaveLength(3);
    });

    it('retries transient failures within the current scope and caches the recovered answer', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://retry-search.example', accountId: 'account-a' });
        harness.answer(home, SEARCH_PATH, { status: 503, body: { error: 'temporarily_unavailable' } });
        const scope = { serverId: home, accountId: 'account-a' };
        const hook = await renderHook(({ query }) => useHomeAccountSearch(scope, query, true), { initialProps: { query: 'Ada' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(1050); });
        expect(hook.getCurrent().failure?.retryable).toBe(true);
        expect(hook.getCurrent().searching).toBe(false);
        expect(harness.requestsFor(SEARCH_PATH)).toHaveLength(2);
        const ada = homeAccountPickerRowFixture('ada', 'Ada');
        harness.answer(home, SEARCH_PATH, { body: { accounts: [ada] } });
        await act(async () => { hook.getCurrent().retry(); });
        expect(hook.getCurrent().rows).toEqual([ada]);
        expect(hook.getCurrent().failure).toBeNull();
        await hook.rerender({ query: '' });
        await hook.rerender({ query: 'Ada' });
        expect(hook.getCurrent().rows).toEqual([ada]);
        expect(harness.requestsFor(SEARCH_PATH)).toHaveLength(3);
    });
});
