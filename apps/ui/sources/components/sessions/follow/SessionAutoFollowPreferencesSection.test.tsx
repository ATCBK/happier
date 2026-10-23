import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { resolveSessionFollowActionRequest } from '@happier-dev/protocol';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
const network = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { getStorage } = await import('@/sync/domains/state/storage');
const { SessionAutoFollowPreferencesSection } = await import('./SessionAutoFollowPreferencesSection');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests();
    network.resetRequests();
});
afterAll(() => network.dispose());

type Screen = Awaited<ReturnType<typeof renderSettingsView>>;
/** Follow automatically is a level per rule (lab P5): Important follows, Off does not. */
function isOn(screen: Screen, field: string): boolean | undefined {
    return screen.findByTestId(`session-auto-follow-${field}:important`)?.props.accessibilityState?.checked;
}
function choose(screen: Screen, field: string, on: boolean) {
    screen.findByTestId(`session-auto-follow-${field}:${on ? 'important' : 'off'}`)?.props.onPress();
}

const preferencesPath = resolveSessionFollowActionRequest('follow.preferences.get', {}).path;

function setPreferencesFetch(handler: RuntimeFetch) {
    network.setHttpResponder(async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        if (pathname === '/v1/features') return globalThis.fetch(url, init);
        // Preserve the canonical Account bootstrap and Settings transport underneath.
        if (pathname !== preferencesPath) return createEmptyAccountBootstrapHttpResponse(pathname, init);
        return handler(url, init);
    });
}

async function flushAsyncWork() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function publishFollowFeature(serverId: string, following: boolean) {
    const features = buildServerFeaturesResponse();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...features, features: { ...features.features, sessions: { ...features.features.sessions, enabled: true, following: { enabled: following } } } }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await getServerFeaturesSnapshot({ serverId, force: true });
}

async function renderEnabledPreferencesSection(serverUrl: string) {
    const home = await network.addHome(serverUrl, 'account-a');
    await publishFollowFeature(home.id, true);
    setPreferencesFetch(async () => new Response('{}', { status: 404 }));
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-a', request: network.request });
    await publishFollowFeature(home.id, true);
    expect(getStorage().getState().profileScope).toEqual({ serverId: home.id, accountId: 'account-a' });
    return home;
}

it('loads Account preferences on first render and preserves a failed toggle for retry', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-follow.example');
    let preferences = { assigned: true, direct: false, team: false, group: false };
    let failWrite = true;
    setPreferencesFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        if (init?.method === 'PUT') {
            if (failWrite) return new Response('{}', { status: 503 });
            preferences = JSON.parse(String(init.body));
        }
        return new Response(JSON.stringify(preferences), { status: 200 });
    });
    const screen = await renderSettingsView(<SessionAutoFollowPreferencesSection serverId={home.id} />);
    await vi.waitFor(() => expect(isOn(screen, 'assigned'), JSON.stringify({
        content: screen.getTextContent(), scope: getStorage().getState().profileScope,
        paths: network.httpRequests.map(request => new URL(request.url).pathname),
    })).toBe(true));
    for (const field of ['assigned', 'direct', 'team', 'group']) {
        const anchor = `coordination.autoFollow${field[0]!.toUpperCase()}${field.slice(1)}`;
        expect(screen.findAll((node) => node.props.nativeID === `setting-${anchor}`).length).toBeGreaterThan(0);
    }
    await act(async () => { choose(screen, 'direct', true); });
    expect(isOn(screen, 'direct')).toBe(true);
    expect(preferences.direct).toBe(false);
    expect(screen.findByTestId('session-auto-follow-retry')).not.toBeNull();
    failWrite = false;
    await act(async () => { screen.findByTestId('session-auto-follow-retry')?.props.onPress(); });
    expect(preferences.direct).toBe(true);
    expect(screen.findByTestId('session-auto-follow-retry')).toBeNull();
    await screen.unmount();
});

it('does not read preferences for 1,000 unrelated detailed Account changes but refreshes Follow configuration', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-relevance.example');
    let reads = 0;
    let assigned = true;
    setPreferencesFetch(async () => {
        reads++;
        return Response.json({ assigned, direct: false, team: false, group: false });
    });
    const screen = await renderSettingsView(<SessionAutoFollowPreferencesSection serverId={home.id} />);
    await vi.waitFor(() => expect(isOn(screen, 'assigned')).toBe(true));
    const baseline = reads;
    const unrelatedKinds = ['kv', 'session', 'artifact', 'machine', 'account'] as const;
    await act(async () => {
        for (let index = 0; index < 1_000; index++) publishHomeAccountChange(home.id, [`unrelated-${index}`],
            { changeKinds: [unrelatedKinds[index % unrelatedKinds.length]!], sessionListQueryAffects: true });
    });
    await flushAsyncWork();
    expect(reads).toBe(baseline);
    assigned = false;
    const { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } = await import('@happier-dev/protocol/sessions/follow/changes');
    await act(async () => publishHomeAccountChange(home.id, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
    await vi.waitFor(() => expect(isOn(screen, 'assigned')).toBe(false));
    expect(reads).toBe(baseline + 1);
    for (const event of [
        { entityIds: ['self'], changeKinds: ['account'] as const },
        { entityIds: ['shared-session'], changeKinds: ['share'] as const },
        { source: 'connected' as const },
        { entityIds: ['future-entity'], changeKinds: ['future-kind'] },
        {},
    ]) {
        const before = reads;
        assigned = !assigned;
        await act(async () => publishHomeAccountChange(home.id, 'entityIds' in event ? event.entityIds : undefined, event));
        await vi.waitFor(() => expect(isOn(screen, 'assigned')).toBe(assigned));
        expect(reads).toBe(before + 1);
    }
    await screen.unmount();
});

it('coalesces Account-change wakes during a save and reconciles to the Home after success or failure', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-follow-race.example');
    const initial = { assigned: true, direct: false, team: false, group: false };
    let authoritative = initial;
    let reads = 0;
    const firstWrite = createDeferred<Response>();
    const secondWrite = createDeferred<Response>();
    let writes = 0;
    setPreferencesFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        if (init?.method === 'PUT') return ++writes === 1 ? firstWrite.promise : secondWrite.promise;
        reads += 1;
        return new Response(JSON.stringify(authoritative), { status: 200 });
    });

    const screen = await renderSettingsView(<SessionAutoFollowPreferencesSection serverId={home.id} />);
    await flushAsyncWork();
    expect(reads).toBe(1);

    act(() => { choose(screen, 'direct', true); });
    authoritative = { ...initial, team: true };
    act(() => {
        publishHomeAccountChange(home.id);
        publishHomeAccountChange(home.id);
    });
    expect(reads).toBe(1);
    firstWrite.resolve(new Response(JSON.stringify({ ...initial, direct: true }), { status: 200 }));
    await flushAsyncWork();
    expect(reads).toBe(2);
    expect(isOn(screen, 'direct')).toBe(false);
    expect(isOn(screen, 'team')).toBe(true);

    act(() => { choose(screen, 'group', true); });
    authoritative = { ...initial, assigned: false };
    act(() => { publishHomeAccountChange(home.id); });
    secondWrite.resolve(new Response('{}', { status: 503 }));
    await flushAsyncWork();
    expect(reads).toBe(3);
    // The confirmed Home value is refreshed beneath the failed change…
    expect(isOn(screen, 'assigned')).toBe(false);
    // …and the change the user asked for, its error and its retry all survive that refresh.
    expect(isOn(screen, 'group')).toBe(true);
    expect(screen.findByTestId('session-auto-follow-error')).not.toBeNull();
    expect(screen.findByTestId('session-auto-follow-retry')).not.toBeNull();

    // A later reconnect wake is still only a refresh: it may not abandon the failed change.
    act(() => { publishHomeAccountChange(home.id); });
    await flushAsyncWork();
    expect(reads).toBe(4);
    expect(isOn(screen, 'group')).toBe(true);
    expect(screen.findByTestId('session-auto-follow-retry')).not.toBeNull();

    // Retry re-executes that exact intent against the current confirmed value, not a stale
    // snapshot: the refreshed `assigned: false` survives and only `group` changes.
    let retried: unknown = null;
    setPreferencesFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        if (init?.method === 'PUT') {
            retried = JSON.parse(String(init.body));
            return new Response(String(init.body), { status: 200 });
        }
        reads += 1;
        return new Response(JSON.stringify(authoritative), { status: 200 });
    });
    await act(async () => { screen.findByTestId('session-auto-follow-retry')?.props.onPress(); });
    await flushAsyncWork();
    expect(retried).toEqual({ ...initial, assigned: false, group: true });
    expect(screen.findByTestId('session-auto-follow-error')).toBeNull();
    expect(isOn(screen, 'group')).toBe(true);
    await screen.unmount();
});

it('reloads the Home after the Follow feature decision disappears during an outstanding save', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-follow-feature-flip.example');
    const write = createDeferred<Response>();
    let reads = 0;
    const DIAG: string[] = [];
    setPreferencesFetch(async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        // The Home feature decision is the thing this test flips, and the features
        // client reads it through the same runtime fetch. Delegate that path to the
        // decision `publishFollowFeature` installs instead of answering it with this
        // section's preference payload, which would pin the feature off forever.
        if (pathname === '/v1/features') return await globalThis.fetch(url, init);
        if (init?.method === 'PUT') return write.promise;
        reads += 1;
        DIAG.push(`read:${pathname}`);
        return new Response(JSON.stringify({ assigned: true, direct: false, team: false, group: false }), { status: 200 });
    });

    const screen = await renderSettingsView(<SessionAutoFollowPreferencesSection serverId={home.id} />);
    await flushAsyncWork();
    DIAG.push('mounted');
    act(() => { choose(screen, 'direct', true); });
    DIAG.push('toggled');

    await act(async () => { await publishFollowFeature(home.id, false); });
    DIAG.push('feature-off');
    expect(screen.findByTestId('session-auto-follow-direct:important')).toBeNull();
    write.resolve(new Response(JSON.stringify({ assigned: true, direct: true, team: false, group: false }), { status: 200 }));
    await flushAsyncWork();
    DIAG.push('write-settled');

    await act(async () => { await publishFollowFeature(home.id, true); });
    DIAG.push('feature-on');
    await flushAsyncWork();
    expect(reads, DIAG.join(' > ')).toBe(2);
    expect(isOn(screen, 'direct')).toBe(false);
    expect(screen.findByTestId('session-auto-follow-direct:important')?.props.accessibilityState?.disabled).toBe(false);
    await screen.unmount();
});

it('does not start a deferred refresh after the settings lifetime is retired', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-follow-retire.example');
    const write = createDeferred<Response>();
    let reads = 0;
    setPreferencesFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        if (init?.method === 'PUT') return write.promise;
        reads += 1;
        return new Response(JSON.stringify({ assigned: true, direct: false, team: false, group: false }), { status: 200 });
    });

    const screen = await renderSettingsView(<SessionAutoFollowPreferencesSection serverId={home.id} />);
    await flushAsyncWork();
    act(() => { choose(screen, 'direct', true); });
    act(() => { publishHomeAccountChange(home.id); });
    await screen.unmount();
    write.resolve(new Response(JSON.stringify({ assigned: true, direct: true, team: false, group: false }), { status: 200 }));
    await flushAsyncWork();
    expect(reads).toBe(1);
});
