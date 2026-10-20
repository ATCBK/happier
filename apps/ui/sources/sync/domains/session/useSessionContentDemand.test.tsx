import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { isSessionListRowVisible, resetSessionSurfaceVisibilityForTests } from './sessionSurfaceVisibility';
import type { SessionAddress } from './sessionAddress';

const hydrateSessionListRows = vi.hoisted(() => vi.fn(async (_addresses: readonly { serverId: string; sessionId: string }[]) => undefined));
vi.mock('@/sync/sync', () => ({ sync: { hydrateSessionListRows } }));

import { useSessionContentDemand } from './useSessionContentDemand';

const home = 'home-a';
const address = (sessionId: string): SessionAddress => ({ serverId: home, sessionId });
const seed = (rows: Record<string, 'unsettled' | 'ready' | 'blocked'>) => storage.setState({
    sessionListRowsByServerId: { [home]: Object.fromEntries(Object.entries(rows).map(([id, state]) => [id, createSessionListRenderableSessionFixture({
        id,
        encryptionMode: 'e2ee',
        encryptedContentAvailability: state === 'unsettled' ? undefined : state === 'ready' ? 'ready' : 'encrypted_content_unavailable',
    })])) },
});
const hydrated = () => hydrateSessionListRows.mock.calls.map(([addresses]) => addresses.map(entry => entry.sessionId));

afterEach(() => {
    hydrateSessionListRows.mockClear();
    resetSessionSurfaceVisibilityForTests();
    storage.setState({ sessionListRowsByServerId: {} });
});

describe('useSessionContentDemand', () => {
    it('retains every shown Session for as long as the surface shows it, and hydrates only the undecided ones when asked to', async () => {
        seed({ a: 'unsettled', b: 'ready', c: 'blocked' });
        const hook = await renderHook(() => useSessionContentDemand(
            [address('a'), address('b'), address('c'), address('unlisted')], { tag: 'test', hydrate: 'unsettled' },
        ));

        expect(hydrated()).toEqual([['a', 'unlisted']]);
        for (const id of ['a', 'b', 'c', 'unlisted']) expect(isSessionListRowVisible(id, home)).toBe(true);
        await hook.unmount();
        for (const id of ['a', 'b', 'c', 'unlisted']) expect(isSessionListRowVisible(id, home)).toBe(false);
    });

    it('refreshes every Session that enters a viewport once, not the ones that stay', async () => {
        seed({ a: 'ready', b: 'ready' });
        let shown = [address('a')];
        const hook = await renderHook(() => useSessionContentDemand(shown, { tag: 'test', hydrate: 'viewport' }));
        expect(hydrated()).toEqual([['a']]);

        shown = [address('a'), address('b')];
        await hook.rerender();
        expect(hydrated()).toEqual([['a'], ['b']]);
        shown = [address('a'), address('b')].slice();
        await hook.rerender();
        expect(hydrated()).toEqual([['a'], ['b']]);
        await hook.unmount();
    });

    it('demands nothing while its surface is inactive, and hydrates again when it returns', async () => {
        seed({ a: 'ready' });
        let active = true;
        const hook = await renderHook(() => useSessionContentDemand([address('a')], { tag: 'test', hydrate: 'viewport', active }));
        expect(hydrated()).toEqual([['a']]);

        active = false;
        await hook.rerender();
        expect(isSessionListRowVisible('a', home)).toBe(false);
        active = true;
        await hook.rerender();
        expect(hydrated()).toEqual([['a'], ['a']]);
        await hook.unmount();
    });
});
