import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { isSessionListRowVisible, resetSessionSurfaceVisibilityForTests } from '@/sync/domains/session/sessionSurfaceVisibility';

const hydrateSessionListRows = vi.hoisted(() => vi.fn(async (_addresses: readonly { serverId: string; sessionId: string }[]) => undefined));
vi.mock('@/sync/sync', () => ({ sync: { hydrateSessionListRows } }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { resolveCompactAppDestinations, resolveDestinationRefFromHref, useDestinationInstanceTitles } from './compactAppDestinationCatalog';

const scope = { serverId: 'home-a', accountId: 'account-a' };
const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });

afterEach(() => {
    hydrateSessionListRows.mockClear();
    resetSessionSurfaceVisibilityForTests();
    storage.setState(storage.getInitialState(), true);
});

describe('Session tab titles', () => {
    it('demand the content of the restored Sessions they name, so an undecided Session is not titled as locked', async () => {
        storage.getState().activateProfileScope(scope);
        storage.setState({ sessionListRowsByServerId: { [scope.serverId]: {
            undecided: createSessionListRenderableSessionFixture({ id: 'undecided', encryptionMode: 'e2ee', encryptedContentAvailability: undefined }),
            settled: createSessionListRenderableSessionFixture({ id: 'settled', encryptionMode: 'e2ee', encryptedContentAvailability: 'ready' }),
        } } });
        const entries = ['/session/undecided?serverId=home-a', '/session/settled?serverId=home-a'].map((href, index) => {
            const ref = resolveDestinationRefFromHref(catalog, href);
            if (!ref) throw new Error(`Unregistered fixture destination: ${href}`);
            return { key: String(index), ref };
        });

        const hook = await renderHook(() => useDestinationInstanceTitles(catalog, entries));

        expect(hydrateSessionListRows.mock.calls.flatMap(([addresses]) => addresses.map(address => address.sessionId))).toEqual(['undecided']);
        expect(isSessionListRowVisible('undecided', scope.serverId)).toBe(true);
        await hook.unmount();
        expect(isSessionListRowVisible('undecided', scope.serverId)).toBe(false);
    });
});
