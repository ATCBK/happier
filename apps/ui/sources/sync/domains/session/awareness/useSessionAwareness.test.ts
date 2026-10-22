import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useSessionAwareness } = await import('./useSessionAwareness');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
let activeScope: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;

beforeEach(async () => { await homes.reset(); });
afterEach(() => { standardCleanup(); activeScope?.dispose(); activeScope = null; });

it('projects exact scoped native requests from the real store through add, settle, foreign Home and Account retirement', async () => {
    const serverId = await homes.addHome({ name: 'Permission Home', serverUrl: 'https://native-permission.test', accountId: 'alice', currentAccount: true });
    activeScope = await activateStorageAccountScope({ serverId, accountId: 'alice' }, storage);
    const sessionId = 'native-permission-session';
    const base = createSessionFixture({ id: sessionId, serverId, encryptionMode: 'plain', active: true, presence: 'online',
        updatedAt: Date.now(), activeAt: Date.now(), latestTurnStatus: 'in_progress',
        agentState: { requests: {} }, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null });
    storage.setState({ sessions: { [sessionId]: base } });
    const scopes = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
    await vi.waitFor(() => expect(scopes.getCurrent().get(serverId)).toBeDefined());
    const accountLifetime = scopes.getCurrent().get(serverId)!;
    const hook = await renderHook(() => useSessionAwareness(sessionId, serverId, undefined, { accountLifetime }));
    expect(hook.getCurrent().pendingRequests).toEqual([]);
    const request = { tool: 'Bash', kind: 'permission' as const, arguments: { command: 'sleep 300' }, createdAt: Date.now(), turnId: 'native-turn' };
    const pending = { ...base, agentState: { requests: { 'exec-native': request } } };
    await act(async () => { storage.setState({ sessions: { [sessionId]: pending } }); });
    expect(hook.getCurrent().pendingRequests).toEqual([expect.objectContaining({ id: 'exec-native', turnId: 'native-turn' })]);
    expect(hook.getCurrent().oldestPendingRequest?.id).toBe('exec-native');
    expect(hook.getCurrent().requestHref).toBe(`/session/${sessionId}?serverId=${encodeURIComponent(serverId)}`);
    expect(hook.getCurrent().awareness?.operational.primary).toBe('permission_required');
    const stable = hook.getCurrent().pendingRequests;
    await act(async () => { storage.setState({ sessions: { [sessionId]: pending, unrelated: createSessionFixture({ id: 'unrelated', serverId }) } }); });
    expect(hook.getCurrent().pendingRequests).toBe(stable);
    await act(async () => { storage.setState({ profileScope: { serverId, accountId: 'bob' }, sessions: { [sessionId]: pending } }); });
    expect(accountLifetime.isCurrent()).toBe(true);
    expect(hook.getCurrent().pendingRequests).toEqual([]);
    expect(hook.getCurrent().requestHref).toBeNull();
    await act(async () => { storage.setState({ profileScope: { serverId, accountId: 'alice' } }); });
    expect(hook.getCurrent().pendingRequests).toHaveLength(1);
    await act(async () => { storage.setState({ sessions: { [sessionId]: { ...pending, agentState: {
        requests: { 'exec-native': request }, completedRequests: { 'exec-native': { ...request, completedAt: Date.now() + 1, status: 'approved' } },
    } } } }); });
    expect(hook.getCurrent().pendingRequests).toEqual([]);
    expect(hook.getCurrent().oldestPendingRequest).toBeNull();
    expect(hook.getCurrent().requestHref).toBeNull();
    await act(async () => { storage.setState({ sessions: { [sessionId]: { ...pending, serverId: 'foreign-home' } } }); });
    expect(hook.getCurrent().pendingRequests).toEqual([]);
    const foreign = await renderHook(() => useSessionAwareness(sessionId, 'foreign-home', undefined, { accountLifetime }));
    expect(foreign.getCurrent().pendingRequests).toEqual([]);
    expect(foreign.getCurrent().requestHref).toBeNull();
    await foreign.unmount();
    await act(async () => { storage.setState({ sessions: { [sessionId]: pending } }); });
    expect(hook.getCurrent().pendingRequests).toHaveLength(1);
    await act(async () => { await homes.switchAccount(serverId, 'bob'); });
    expect(hook.getCurrent().pendingRequests).toEqual([]);
    expect(hook.getCurrent().requestHref).toBeNull();
    await hook.unmount();
    await scopes.unmount();
});
