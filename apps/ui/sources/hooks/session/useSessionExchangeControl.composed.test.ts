import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';
import { createAutonomousExchangeStateV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storage');
const { useSessionFollowers } = await import('@/components/sessions/follow/useSessionFollowers');
const { useSessionExchangeControl } = await import('./useSessionExchangeControl');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const initial = getStorage().getState();
let restored: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => { await homes.reset(); });
afterEach(async () => {
    await standardCleanup();
    await restored?.dispose(); restored = undefined;
    getStorage().setState(initial, true);
});

for (const kind of ['followers', 'exchange'] as const) {
    for (const scenario of ['unrelated', 'burst', 'retirement', 'account retirement'] as const) it(`${kind}: ${scenario} refreshes preserve exact scope and useful reads`, async () => {
        const serverUrl = `https://${kind}-refresh.test`;
        const serverId = await homes.addHome({ name: kind, serverUrl, accountId: 'alice', currentAccount: true });
        homes.answer(serverId, '/v2/sessions/query', { body: { sessions: [],
            hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null } });
        const signals: (AbortSignal | null | undefined)[] = [];
        restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
            credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: async (url, init) => {
                if (String(url).includes(kind === 'followers' ? '/follows/followers' : '/exchanges/root')) signals.push(init?.signal);
                return homes.request(url, init);
            } });
        await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
        const path = kind === 'followers' ? '/v2/sessions/source/follows/followers' : '/v2/sessions/source/exchanges/root';
        const body = (revision: number) => kind === 'followers'
            ? { follows: [], sources: [], rules: [], coverage: 'complete', peopleCount: revision }
            : { state: createAutonomousExchangeStateV1(5), observedRevision: `session-message-row-revision:v1:${revision}` };
        homes.answer(serverId, path, { body: body(0) });
        // Both real hooks use the same HTTP and Account-lifetime boundaries.
        const useProjection = kind === 'followers'
            ? ({ sessionId }: { sessionId: string }) => { const value = useSessionFollowers({ serverId, sessionId }, true); return { value: value.projection, busy: value.loading }; }
            : ({ sessionId }: { sessionId: string }) => { const value = useSessionExchangeControl({ serverId, sessionId }, 'root'); return { value: value.observation, busy: value.refreshing }; };
        const hook = await renderHook<{
            value: ReturnType<typeof useSessionFollowers>['projection'] | ReturnType<typeof useSessionExchangeControl>['observation'];
            busy: boolean;
        }, { sessionId: string }>(useProjection, { initialProps: { sessionId: 'source' } });
        await vi.waitFor(() => expect(hook.getCurrent().value).not.toBeNull());
        await vi.waitFor(() => expect(hook.getCurrent().busy).toBe(false));
        const reads = () => homes.requests.filter(request => request.path === path).length;
        const before = reads();
        if (scenario === 'unrelated') {
            await act(async () => {
                publishHomeAccountChange(serverId, ['source'], { changeKinds: ['artifact'] });
                publishHomeAccountChange(serverId, ['another-session'], { changeKinds: ['session'] });
                publishHomeAccountChange('another-home', ['source'], { changeKinds: ['session'] });
            });
            await flushHookEffects();
            expect(reads()).toBe(before);
            await act(async () => publishHomeAccountChange(serverId, undefined, { source: 'connected' }));
            await vi.waitFor(() => expect(reads()).toBe(before + 1));
            await vi.waitFor(() => expect(hook.getCurrent().busy).toBe(false));
            if (kind === 'followers') {
                await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
                await vi.waitFor(() => expect(reads()).toBe(before + 2));
            }
            return;
        }

        let release: (() => void) | undefined;
        const held = new Promise<void>(resolve => { release = resolve; });
        homes.answer(serverId, path, { body: body(1), respondAfter: held });
        try {
            await act(async () => publishHomeAccountChange(serverId, ['source'], { changeKinds: ['session'] }));
            await vi.waitFor(() => expect(reads()).toBe(before + 1));
            await act(async () => {
                for (let index = 0; index < 8; index++) publishHomeAccountChange(serverId, ['source'], { changeKinds: ['session'] });
            });
            await flushHookEffects();
            if (scenario === 'account retirement') {
                const oldSignal = signals.at(-1);
                await act(async () => { await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId }); });
                await vi.waitFor(() => expect(oldSignal?.aborted).toBe(true));
                await act(async () => release?.());
                await vi.waitFor(() => expect(hook.getCurrent().value).toBeNull());
                await flushHookEffects();
                expect(hook.getCurrent().busy).toBe(false);
                return;
            }
            if (scenario === 'retirement') {
                const oldSignal = signals.at(-1);
                const nextPath = path.replace('/source/', '/replacement/');
                homes.answer(serverId, nextPath, { body: body(9) });
                await hook.rerender({ sessionId: 'replacement' });
                expect(oldSignal?.aborted).toBe(true);
                await vi.waitFor(() => expect(hook.getCurrent().value).toMatchObject(kind === 'followers' ? { peopleCount: 9 }
                    : { address: { sessionId: 'replacement' }, status: { observedRevision: 'session-message-row-revision:v1:9' } }));
                await act(async () => release?.());
                await flushHookEffects();
                expect(hook.getCurrent().value).toMatchObject(kind === 'followers' ? { peopleCount: 9 }
                    : { address: { sessionId: 'replacement' } });
                return;
            }
            expect(reads()).toBe(before + 1);
            expect(signals.at(-1)?.aborted).toBe(false);
            expect(hook.getCurrent().value).not.toBeNull();
            homes.answer(serverId, path, { body: body(2) });
        } finally { await act(async () => release?.()); }
        await vi.waitFor(() => expect(reads()).toBe(before + 2));
        await vi.waitFor(() => expect(hook.getCurrent().busy).toBe(false));
        expect(hook.getCurrent().value).toMatchObject(kind === 'followers' ? { peopleCount: 2 }
            : { status: { observedRevision: 'session-message-row-revision:v1:2' } });

        await hook.unmount();
    });
}
