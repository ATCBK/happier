import { afterEach, describe, expect, it } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

// The whole path is real: the Action source, the scoped authority, the Session reader, credential storage,
// the Session store and the Home transport. Only the Homes' HTTP responses are the external boundary.
type Homes = Awaited<ReturnType<typeof serveAccountHomes>>;
type RequestState = 'pending' | 'settled' | 'absent';

let homes: Homes | undefined;
afterEach(async () => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await homes?.dispose();
    homes = undefined;
});

const request = { tool: 'Bash', arguments: {}, createdAt: 1 };
function agentStateFor(state: RequestState): string {
    return JSON.stringify(state === 'pending' ? { requests: { r1: request } }
        : state === 'settled' ? { completedRequests: { r1: { ...request, completedAt: 2, status: 'approved' } } }
        : { requests: {} });
}

/** Home A serves the request in `state`; Home B (focused) always has it settled, so a read on B would be visible. */
async function serve(state: RequestState, options?: Readonly<{ hold?: { entered: () => void; released: Promise<void> }; failRead?: boolean }>) {
    homes = await serveAccountHomes({ homes: [
        { key: 'a', serverUrl: 'https://review-permission-a.test', accountId: 'account-a' },
        { key: 'b', serverUrl: 'https://review-permission-b.test', accountId: 'account-b' },
    ], route: async (incoming) => {
        if (incoming.path === '/v2/sessions/s1') {
            if (options?.failRead && incoming.home === 'a') return Response.json({ error: 'unavailable' }, { status: 503 });
            if (options?.hold && incoming.home === 'a') { options.hold.entered(); await options.hold.released; }
            return Response.json({ session: { ...createPlainSessionCurrentProjectionRecordFixture({ id: 's1' }),
                agentState: agentStateFor(incoming.home === 'a' ? state : 'settled') } });
        }
        if (incoming.path === '/v1/sessions/s1/turns') return Response.json({ v: 1, sessionId: 's1', updatedAt: 1, turns: [] });
        return undefined;
    } });
    publishAppliedActiveServerSnapshot({ serverId: homes.homes.b!.id, serverUrl: homes.homes.b!.serverUrl, generation: 0 });
    const { createAppSessionTranscriptActions } = await import('./appSessionTranscriptActions');
    return { a: homes.homes.a!, actions: createAppSessionTranscriptActions('s1', homes.homes.a!.id) };
}

const sessionReads = (home: string) => homes!.httpRequests.filter((incoming) => incoming.path === '/v2/sessions/s1' && incoming.home === home);

describe('createAppSessionTranscriptActions.readRequestOutcome', () => {
    it('reads the exact Session on its own Home, never the focused one, and reports a waiting request as pending', async () => {
        const { actions } = await serve('pending');
        await expect(actions.readRequestOutcome!('r1')).resolves.toBe('pending');
        expect(sessionReads('a').length).toBeGreaterThan(0);
        expect(sessionReads('b')).toHaveLength(0);
    });

    it('reports a completed request as settled and publishes that Session through the store owner, so a pending card leaves its state', async () => {
        const { a, actions } = await serve('settled');
        const { storage } = await import('@/sync/domains/state/storage');
        await expect(actions.readRequestOutcome!('r1')).resolves.toBe('settled');
        const published = storage.getState().sessions.s1;
        expect(published?.serverId).toBe(a.id);
        expect(published?.agentState?.completedRequests?.r1).toBeDefined();
        expect(published?.agentState?.requests?.r1).toBeUndefined();
    });

    it('cannot tell when the Session lists neither state, so the read rejects instead of guessing', async () => {
        const { actions } = await serve('absent');
        await expect(actions.readRequestOutcome!('r1')).rejects.toThrow();
    });

    it('rejects when the scoped read fails, and never falls back to another Home', async () => {
        const { actions } = await serve('pending', { failRead: true });
        await expect(actions.readRequestOutcome!('r1')).rejects.toBeDefined();
        expect(sessionReads('b')).toHaveLength(0);
    });

    it('keeps the hold when the Home\'s Account retired while the read was in flight', async () => {
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const released = new Promise<void>((resolve) => { release = resolve; });
        const { actions } = await serve('pending', { hold: { entered: enter, released } });
        const outcome = actions.readRequestOutcome!('r1').then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
        await entered;
        try { await homes!.switchAccount('a', 'successor-account'); } finally { release(); }
        expect(await outcome, 'an Account that is no longer current cannot release the hold').toMatchObject({ ok: false });
    });

    it('targets the active Home only when the Actions themselves carry no Home', async () => {
        await serve('pending');
        const { createAppSessionTranscriptActions } = await import('./appSessionTranscriptActions');
        await createAppSessionTranscriptActions('s1', null).readRequestOutcome!('r1');
        expect(sessionReads('b').length).toBeGreaterThan(0);
        expect(sessionReads('a')).toHaveLength(0);
    });
});
