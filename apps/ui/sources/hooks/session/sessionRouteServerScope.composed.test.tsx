import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installSessionActionRpcBoundary(() => ({ ok: true }));
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { getServerProfileById, setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { createSessionRouteServerScope } = await import('./sessionRouteServerScope');
const { useHydrateSessionForRoute } = await import('./useHydrateSessionForRoute');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let serverId: string;
let alias: string;
let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useHydrateSessionForRoute>>>> | undefined;
beforeEach(async () => {
    await homes.reset();
    const localId = await homes.addHome({ name: 'Session route Home', serverUrl: 'https://session-route.test', accountId: 'account' });
    const identified = await setServerProfileIdentityForUrl('https://session-route.test', 'srv_session_route');
    expect(identified).not.toBeNull();
    alias = localId;
    const request = createSessionReadBatchFetchBoundary(homes.request);
    connection = await restoreServerAccountForTest({ serverUrl: 'https://session-route.test',
        serverIdentityId: 'srv_session_route', accountId: 'account', request });
    installHomeGovernanceBoundaries(homes);
    setRuntimeFetch(request);
    serverId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
    expect(getServerProfileById(alias)?.id).toBe(connection.home.id);
    expect(resolveServerProfileScopeIdForIdentifier(alias)).toBe(serverId);
    installSessionActionFixture({ homes, storage, serverId: localId,
        session: { id: 'own-session', serverId, encryptionMode: 'plain', metadata: { path: '/repo', host: 'test' } } });
});
afterEach(async () => { await hook?.unmount(); hook = undefined; await connection?.dispose(); });

describe('Session route Home alias resolution', () => {
    it('resolves a local-profile alias to the canonical Home before real route hydration', async () => {
        const canonical = createSessionRouteServerScope({ id: 'own-session', serverId });
        const aliased = createSessionRouteServerScope({ id: 'own-session', serverId: alias });
        expect(aliased.serverId).toBe(canonical.serverId);
        expect(aliased.buildHref('own-session')).toBe(canonical.buildHref('own-session'));
        hook = await renderHook(() => useHydrateSessionForRoute('own-session', 'alias-route', aliased.hydrationOptions));
        expect(hook.getCurrent()).toMatchObject({ kind: 'available', sessionId: 'own-session', serverId });
        await act(async () => storage.setState(state => ({ sessions: { ...state.sessions } })));
        expect(hook.getCurrent().kind).toBe('available');
        const foreign = createSessionRouteServerScope({ id: 'own-session', serverId: 'foreign-home' });
        expect(foreign.serverId).toBe('foreign-home');
        expect(foreign.hydrationOptions).toEqual({ serverId: 'foreign-home' });
    });

    it('hydrates a cold alias-qualified Session through the same Home HTTP authority', async () => {
        storage.setState({ sessions: {}, sessionListRowsByServerId: {}, sessionListIndexByServerId: {} });
        const scope = createSessionRouteServerScope({ id: 'own-session', serverId: alias });
        hook = await renderHook(() => useHydrateSessionForRoute('own-session', 'cold-alias-route', {
            ...scope.hydrationOptions, hydrateMessages: false,
        }));
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ kind: 'available', sessionId: 'own-session', serverId }));
        expect(storage.getState().sessions['own-session']?.serverId).toBe(serverId);
        const reads = homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v2/sessions/own-session');
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every(request => request.serverUrl === 'https://session-route.test')).toBe(true);
    });
});
