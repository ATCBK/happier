import { describe, expect, it } from 'vitest';
import type { SessionListQueryV1 } from '@happier-dev/protocol';

import {
    createSessionListQueryHomeController,
    type SessionListQueryHomeState,
    type SessionListQueryPageRequest,
} from './sessionListQueryController';
import { buildSessionListQueryKey } from './sessionListQueryKey';

const QUERY_A: SessionListQueryV1 = {
    v: 1,
    storage: 'active',
    includeInactive: false,
    scope: 'all_accessible',
    attention: 'any',
    audiences: [{ kind: 'team', teamId: 'team-a' }],
    tagIds: [],
    includeAttention: true,
};

const QUERY_B: SessionListQueryV1 = {
    ...QUERY_A,
    audiences: [{ kind: 'team', teamId: 'team-b' }],
};

const QUERY_ARCHIVED: SessionListQueryV1 = { ...QUERY_A, storage: 'archived' };
const QUERY_ORDINARY: SessionListQueryV1 = {
    ...QUERY_A,
    scope: 'my_work',
    audiences: [],
};

const KEY_A = buildSessionListQueryKey('home-a', QUERY_A);
const KEY_B = buildSessionListQueryKey('home-a', QUERY_B);
const KEY_ARCHIVED = buildSessionListQueryKey('home-a', QUERY_ARCHIVED);

function result(
    sessionIds: string[],
    cursors: Partial<Readonly<{
        nextCursor: string | null;
        hasNext: boolean;
        attentionNextCursor: string | null;
        attentionHasNext: boolean;
        current: boolean;
    }>> = {},
) {
    return {
        sessionIds,
        nextCursor: cursors.nextCursor ?? null,
        hasNext: cursors.hasNext ?? false,
        attentionNextCursor: cursors.attentionNextCursor ?? null,
        attentionHasNext: cursors.attentionHasNext ?? false,
        current: cursors.current ?? true,
        source: 'v2' as const,
    };
}

describe('SessionListQueryHomeController', () => {
    it.each(['replace', 'ordinary', 'attention'] as const)('retries the failed %s operation and clears its recovery state after success', async (operation) => {
        const requests: SessionListQueryPageRequest[] = [];
        let failing = false;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async request => {
                requests.push(request);
                if (failing) throw new Error('Home unavailable');
                if (request.cursor || request.attentionCursor) return result(['tail']);
                return result(['head'], operation === 'attention'
                    ? { attentionNextCursor: 'attention-next', attentionHasNext: true }
                    : { nextCursor: 'ordinary-next', hasNext: true });
            },
        });
        await controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        failing = true;
        await (operation === 'replace' ? controller.invalidate() : controller.loadNext());
        expect(controller.getSnapshot()).toMatchObject({ phase: 'error', failedOperation: operation });
        const failedRequest = requests.at(-1)!;
        failing = false;
        await controller.retry();
        expect(requests.at(-1)).toMatchObject({
            ...(operation === 'ordinary' ? { cursor: failedRequest.cursor } : {}),
            ...(operation === 'attention' ? { attentionCursor: failedRequest.attentionCursor } : {}),
        });
        if (operation === 'replace') {
            expect(requests.at(-1)?.cursor).toBeUndefined();
            expect(requests.at(-1)?.attentionCursor).toBeUndefined();
        }
        expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', failedOperation: undefined });
        controller.dispose();
    });

    it('settles an offline Home before feature discovery and keeps a reachable undecided Home pending', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async request => {
                requests.push(request);
                return result(['bot-a']);
            },
        });
        const input = { query: QUERY_A, selected: true, supported: null } as const;
        await controller.update({ ...input, online: false });
        expect(controller.getSnapshot()).toMatchObject({ phase: 'offline', addresses: [] });
        expect(requests).toEqual([]);
        await controller.update({ ...input, online: true });
        expect(controller.getSnapshot().phase).toBe('idle');
        expect(requests).toEqual([]);
        await controller.update({ ...input, online: true, supported: true });
        expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', addresses: [{ serverId: 'home-a', sessionId: 'bot-a' }] });
    });

    it('does not notify when the same unavailable input is re-applied', async () => {
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async () => result(['row-a']),
        });
        let notifications = 0;
        controller.subscribe(() => { notifications += 1; });
        for (const online of [false, null] as const) {
            await controller.update({ query: QUERY_A, selected: true, online, supported: true });
            const settled = controller.getSnapshot();
            notifications = 0;
            // Surfaces re-apply their input on every socket or machine-status change.
            await controller.update({ query: QUERY_A, selected: true, online, supported: true });
            await controller.update({ query: QUERY_A, selected: true, online, supported: true });
            expect(notifications).toBe(0);
            expect(controller.getSnapshot()).toBe(settled);
        }
    });

    it('skips a row-level (structural-only) invalidation for a corpus the ordinary list can answer', async () => {
        let requests = 0;
        const makeController = () => createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async () => {
                requests += 1;
                return result(['row-a']);
            },
        });
        const ordinary = makeController();
        await ordinary.update({ query: QUERY_ORDINARY, selected: true, online: true, supported: true });
        const structural = makeController();
        await structural.update({ query: QUERY_A, selected: true, online: true, supported: true });
        requests = 0;

        await ordinary.invalidate('structural');
        expect(requests).toBe(0);
        expect(ordinary.getSnapshot().phase).toBe('ready');

        await structural.invalidate('structural');
        expect(requests).toBe(1);

        await ordinary.invalidate();
        expect(requests).toBe(2);
    });

    it.each([401, 403, 503])('retains stale membership only while access permits it after HTTP %s', async (status) => {
        let failure: { status: number } | null = null;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async () => {
                if (failure) throw failure;
                return result(['private-row'], {
                    nextCursor: 'ordinary-next', hasNext: true,
                    attentionNextCursor: 'attention-next', attentionHasNext: true,
                });
            },
        });
        await controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        failure = { status };
        await controller.refresh();

        expect(controller.getSnapshot()).toMatchObject(status === 503 ? {
            addresses: [{ serverId: 'home-a', sessionId: 'private-row' }],
            nextCursor: 'ordinary-next', hasNext: true,
            attentionNextCursor: 'attention-next', attentionHasNext: true,
            phase: 'error', failureReason: 'network',
        } : {
            addresses: [], appliedQueryKey: null, freshnessAt: null,
            nextCursor: null, hasNext: false,
            attentionNextCursor: null, attentionHasNext: false,
            phase: 'error', failureReason: 'access_denied',
        });

        failure = null;
        await controller.refresh();
        expect(controller.getSnapshot()).toMatchObject({
            addresses: [{ serverId: 'home-a', sessionId: 'private-row' }],
            appliedQueryKey: KEY_A, phase: 'ready', failureReason: null,
        });
    });

    it('lets the first page land when the same input is re-applied while it is in flight', async () => {
        // The sessions surface re-applies its input on unrelated renders. Re-applying an identical
        // query before the first page lands must not abort and restart that page: on a busy Account
        // the list would never leave its skeleton.
        const requests: SessionListQueryPageRequest[] = [];
        let release!: () => void;
        const firstPageHeld = new Promise<void>((resolve) => { release = resolve; });
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => {
                requests.push(request);
                await firstPageHeld;
                return result(['row-1']);
            },
        });
        const input = { query: QUERY_ORDINARY, selected: true, online: true, supported: true } as const;
        const first = controller.update(input);
        await Promise.resolve();
        const again = controller.update({ ...input });
        release();
        await Promise.all([first, again]);

        expect(requests).toHaveLength(1);
        expect(requests[0]?.signal.aborted).toBe(false);
        expect(controller.getSnapshot()).toMatchObject({
            addresses: [{ serverId: 'home-a', sessionId: 'row-1' }],
            phase: 'ready',
        });
    });

    it('ignores a slow old query after a newer query becomes current', async () => {
        let resolveA!: (value: ReturnType<typeof result>) => void;
        const slowA = new Promise<ReturnType<typeof result>>((resolve) => {
            resolveA = resolve;
        });
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async ({ source }) => source.kind === 'query' && source.body.audiences[0]?.kind === 'team'
                && source.body.audiences[0].teamId === 'team-a'
                ? slowA
                : result(['b']),
            now: () => 100,
        });

        const first = controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        const second = controller.update({ query: QUERY_B, selected: true, online: true, supported: true });
        await second;
        resolveA(result(['a']));
        await first;

        expect(controller.getSnapshot()).toMatchObject({
            requestedQueryKey: KEY_B,
            appliedQueryKey: KEY_B,
            addresses: [{ serverId: 'home-a', sessionId: 'b' }],
            phase: 'ready',
        });
    });

    it('keeps pull-to-refresh pending until its queued replacement finishes', async () => {
        const resolvers: Array<(value: ReturnType<typeof result>) => void> = [];
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: (request) => {
                requests.push(request);
                return new Promise((resolve) => resolvers.push(resolve));
            },
        });

        const initial = controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        let refreshSettled = false;
        const refresh = controller.refresh().then(() => { refreshSettled = true; });

        resolvers[0]!(result(['stale']));
        await initial;
        expect(requests).toHaveLength(2);
        expect(refreshSettled).toBe(false);

        resolvers[1]!(result(['fresh']));
        await refresh;
        expect(refreshSettled).toBe(true);
        expect(controller.getSnapshot()).toMatchObject({
            addresses: [{ serverId: 'home-a', sessionId: 'fresh' }],
            phase: 'ready',
        });
    });

    it('keeps invalidation pending until its queued replacement applies membership', async () => {
        const resolvers: Array<(value: ReturnType<typeof result>) => void> = [];
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: (request) => {
                requests.push(request);
                return new Promise((resolve) => resolvers.push(resolve));
            },
        });

        const initial = controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        // Consumed as the declared promise, without a cast: a fire-and-forget
        // `void` return would not compile here. Settlement is recorded with the
        // snapshot observed at that instant, so an implementation that resolved
        // when the replacement *starts* — rather than when its membership
        // applies — would be caught by the recorded phase.
        const settlements: SessionListQueryHomeState[] = [];
        const invalidation = controller.invalidate().then(() => {
            settlements.push(controller.getSnapshot());
        });

        resolvers[0]!(result(['stale']));
        await initial;
        expect(requests).toHaveLength(2);
        expect(settlements).toHaveLength(0);

        resolvers[1]!(result(['fresh']));
        await invalidation;
        expect(settlements).toHaveLength(1);
        expect(settlements[0]).toMatchObject({
            addresses: [{ serverId: 'home-a', sessionId: 'fresh' }],
            appliedQueryKey: KEY_A,
            phase: 'ready',
        });
    });

    it('resolves an invalidation whose queued replacement fails, so a void caller cannot reject', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        let finishInitial!: (value: ReturnType<typeof result>) => void;
        let failReplacement!: (error: Error) => void;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: (request) => {
                requests.push(request);
                if (requests.length === 1) {
                    return new Promise((resolve) => { finishInitial = resolve; });
                }
                // Held, not eagerly rejected: the queued replacement must still be
                // in flight when settlement is asserted below, so this proves
                // chaining rather than a microtask-ordering coincidence.
                return new Promise((_resolve, reject) => { failReplacement = reject; });
            },
        });

        const initial = controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        const settlements: SessionListQueryHomeState[] = [];
        const rejections: unknown[] = [];
        const invalidation = controller.invalidate().then(
            () => { settlements.push(controller.getSnapshot()); },
            (error: unknown) => { rejections.push(error); },
        );

        finishInitial(result(['stale']));
        await initial;
        expect(requests).toHaveLength(2);
        expect(settlements).toHaveLength(0);

        failReplacement(new Error('replacement failed'));
        await invalidation;
        // The failed replacement is reported through the typed snapshot, never as
        // a rejected invalidation: `void controller.invalidate()` is the intended
        // fire-and-forget form at the Account-change and reminder leaves, and a
        // rejecting promise there would surface as an unhandled rejection.
        expect(rejections).toEqual([]);
        expect(settlements).toEqual([expect.objectContaining({
            phase: 'error',
            failureReason: 'network',
            addresses: [{ serverId: 'home-a', sessionId: 'stale' }],
        })]);
    });

    it('settles an in-flight invalidation without a replacement when the Home goes offline', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        let finishInitial!: (value: ReturnType<typeof result>) => void;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: (request) => {
                requests.push(request);
                return new Promise((resolve) => { finishInitial = resolve; });
            },
        });
        const online = { query: QUERY_A, selected: true, online: true, supported: true };

        const initial = controller.update(online);
        const settlements: SessionListQueryHomeState[] = [];
        const rejections: unknown[] = [];
        const invalidation = controller.invalidate().then(
            () => { settlements.push(controller.getSnapshot()); },
            (error: unknown) => { rejections.push(error); },
        );

        await controller.update({ ...online, online: false });
        expect(requests[0]?.signal.aborted).toBe(true);
        finishInitial(result(['stale']));
        await initial;
        await invalidation;

        // The queued refresh cannot survive the request that lost currentness, so
        // no replacement is issued — but the promise the caller already holds must
        // still settle rather than hang behind a refresh that will never run.
        expect(requests).toHaveLength(1);
        expect(rejections).toEqual([]);
        expect(settlements).toEqual([expect.objectContaining({ phase: 'offline' })]);
    });

    it('settles an in-flight invalidation when the controller is disposed', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        let finishInitial!: (value: ReturnType<typeof result>) => void;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: (request) => {
                requests.push(request);
                return new Promise((resolve) => { finishInitial = resolve; });
            },
        });

        const initial = controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        let settled = false;
        const rejections: unknown[] = [];
        const invalidation = controller.invalidate().then(
            () => { settled = true; },
            (error: unknown) => { rejections.push(error); },
        );

        controller.dispose();
        expect(requests[0]?.signal.aborted).toBe(true);
        finishInitial(result(['stale']));
        await initial;
        await invalidation;

        // Disposal drops the queued refresh. The promise a caller already holds
        // must still resolve, so the `void controller.invalidate()` leaves cannot
        // leak a forever-pending chain or an unhandled rejection past teardown.
        expect(requests).toHaveLength(1);
        expect(settled).toBe(true);
        expect(rejections).toEqual([]);
    });

    it('never applies a late replacement after its settled membership lifetime is disposed', async () => {
        let finishReplacement!: (value: ReturnType<typeof result>) => void;
        let requestCount = 0;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: () => {
                requestCount += 1;
                if (requestCount === 1) {
                    return Promise.resolve(result(['account-a'], {
                        nextCursor: 'account-a-next',
                        hasNext: true,
                    }));
                }
                return new Promise((resolve) => { finishReplacement = resolve; });
            },
        });

        await controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        const replacement = controller.refresh();
        controller.dispose();
        finishReplacement(result(['account-a-late'], {
            nextCursor: 'late-next',
            hasNext: true,
        }));
        await replacement;

        expect(controller.getSnapshot()).toMatchObject({
            addresses: [{ serverId: 'home-a', sessionId: 'account-a' }],
            nextCursor: 'account-a-next',
        });
    });

    it('continues attention independently, preserves the ordinary frontier, and stops a repeated cursor', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => {
                requests.push(request);
                if (requests.length === 1) {
                    return result(['first'], {
                        nextCursor: 'ordinary-1',
                        hasNext: true,
                        attentionNextCursor: 'attention-1',
                        attentionHasNext: true,
                    });
                }
                if (requests.length === 2) {
                    return result(['ordinary-row'], {
                        nextCursor: null,
                        hasNext: false,
                    });
                }
                return result(['attention-row'], {
                    attentionNextCursor: 'attention-1',
                    attentionHasNext: true,
                });
            },
        });

        await controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        await controller.loadNext();
        expect(controller.getSnapshot()).toMatchObject({
            nextCursor: null,
            hasNext: false,
            attentionNextCursor: 'attention-1',
            attentionHasNext: true,
        });

        await controller.loadNext();
        expect(requests[2]?.attentionCursor).toBe('attention-1');
        expect('cursor' in requests[2]!).toBe(false);
        expect(controller.getSnapshot()).toMatchObject({
            addresses: [
                { serverId: 'home-a', sessionId: 'first' },
                { serverId: 'home-a', sessionId: 'ordinary-row' },
                { serverId: 'home-a', sessionId: 'attention-row' },
            ],
            phase: 'error',
            failureReason: 'cursor_not_advancing',
            nextCursor: null,
            hasNext: false,
            attentionNextCursor: null,
            attentionHasNext: false,
        });
    });

    it('retains membership while offline and marks an unselected Home explicitly', async () => {
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async () => result(['one']),
        });
        await controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        await controller.update({ query: QUERY_A, selected: true, online: false, supported: true });
        expect(controller.getSnapshot()).toMatchObject({
            phase: 'offline',
            addresses: [{ serverId: 'home-a', sessionId: 'one' }],
        });

        await controller.update({ query: QUERY_A, selected: false, online: true, supported: true });
        expect(controller.getSnapshot()).toMatchObject({
            phase: 'not_selected',
            addresses: [{ serverId: 'home-a', sessionId: 'one' }],
        });
    });

    it('replaces a settled offline corpus immediately on reconnect without reusing either cursor', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        let finishReconnect!: (value: ReturnType<typeof result>) => void;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: (request) => {
                requests.push(request);
                if (requests.length === 1) {
                    return Promise.resolve(result(['stale'], {
                        nextCursor: 'ordinary-next',
                        hasNext: true,
                        attentionNextCursor: 'attention-next',
                        attentionHasNext: true,
                    }));
                }
                return new Promise((resolve) => { finishReconnect = resolve; });
            },
        });
        const online = { query: QUERY_A, selected: true, online: true, supported: true };

        await controller.update(online);
        await controller.update({ ...online, online: false });
        expect(controller.getSnapshot()).toMatchObject({
            phase: 'offline',
            addresses: [{ serverId: 'home-a', sessionId: 'stale' }],
            nextCursor: 'ordinary-next',
            attentionNextCursor: 'attention-next',
        });

        const reconnect = controller.update(online);
        expect(requests).toHaveLength(2);
        expect(requests[1]?.cursor).toBeUndefined();
        expect(requests[1]?.attentionCursor).toBeUndefined();
        expect(controller.getSnapshot()).toMatchObject({
            phase: 'refreshing',
            addresses: [{ serverId: 'home-a', sessionId: 'stale' }],
        });

        finishReconnect(result(['fresh']));
        await reconnect;
        expect(controller.getSnapshot()).toMatchObject({
            phase: 'ready',
            addresses: [{ serverId: 'home-a', sessionId: 'fresh' }],
            nextCursor: null,
            attentionNextCursor: null,
        });
    });

    it('keeps retained membership refreshing while Home transport ownership is transferring', async () => {
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async () => result(['retained']),
        });
        const online = { query: QUERY_A, selected: true, online: true, supported: true };

        await controller.update(online);
        await controller.update({ ...online, online: null });

        expect(controller.getSnapshot()).toMatchObject({
            phase: 'refreshing',
            addresses: [{ serverId: 'home-a', sessionId: 'retained' }],
            failureReason: null,
            failureCode: null,
        });
    });

    it('fails a selected Home closed when filtered listing is unsupported without issuing a request', async () => {
        let requestCount = 0;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async () => {
                requestCount += 1;
                return result(['unexpected']);
            },
        });

        await controller.update({
                        query: QUERY_A,
            selected: true,
            online: true,
            supported: false,
        });

        expect(requestCount).toBe(0);
        expect(controller.getSnapshot()).toMatchObject({
            requestedQueryKey: KEY_A,
            appliedQueryKey: null,
            phase: 'error',
            failureReason: 'unsupported',
            failureCode: 'filtered_session_listing_unavailable',
        });
    });
    it.each([undefined, null, false])('admits no entry point until support is true (%s)', async (supported) => {
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => { requests.push(request); return result(['one']); },
        });
        await controller.update({ query: QUERY_A, selected: true, online: true, supported });
        await controller.refresh();
        void controller.invalidate();
        await controller.loadNext();
        expect(requests).toHaveLength(0);
        expect(controller.getSnapshot()).toMatchObject(supported === false
            ? { phase: 'error', failureReason: 'unsupported' }
            : { phase: 'idle', failureReason: null });
        await controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        expect(controller.getSnapshot().addresses).toEqual([{ serverId: 'home-a', sessionId: 'one' }]);
        expect(requests).toHaveLength(1);
    });

    it.each(['ordinary', 'attention'] as const)('blocks %s continuation and refresh after revocation, then re-enables', async (family) => {
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => {
                requests.push(request);
                return result(['one'], family === 'ordinary'
                    ? { hasNext: true, nextCursor: 'next' }
                    : { attentionHasNext: true, attentionNextCursor: 'attention-next' });
            },
        });
        const input = { query: QUERY_A, selected: true, online: true };
        await controller.update({ ...input, supported: true });
        await controller.update({ ...input, supported: false });
        await controller.loadNext();
        await controller.refresh();
        void controller.invalidate();
        expect(requests).toHaveLength(1);
        expect(controller.getSnapshot().failureReason).toBe('unsupported');
        await controller.update({ ...input, supported: true });
        expect(requests).toHaveLength(2);
        expect(requests[1]?.cursor).toBeUndefined();
        expect(requests[1]?.attentionCursor).toBeUndefined();
        expect(controller.getSnapshot().phase).toBe('ready');
    });

    it('aborts an admitted request and discards queued refresh when support is revoked during fetch', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        let finish!: (value: ReturnType<typeof result>) => void;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: (request) => {
                requests.push(request);
                return requests.length === 1
                    ? new Promise((resolve) => { finish = resolve; })
                    : Promise.resolve(result(['unexpected']));
            },
        });
        const input = { query: QUERY_A, selected: true, online: true };
        const pending = controller.update({ ...input, supported: true });
        const refresh = controller.refresh();
        void controller.invalidate();
        await controller.update({ ...input, supported: null });
        expect(requests[0]?.signal.aborted).toBe(true);
        finish(result(['stale']));
        await Promise.all([pending, refresh]);
        await controller.refresh();
        expect(requests).toHaveLength(1);
        expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', addresses: [], appliedQueryKey: null });
    });

    it('discards an offline request\'s queued refresh without dropping a later committed invalidation', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        let finishInitial!: (value: ReturnType<typeof result>) => void;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: (request) => {
                requests.push(request);
                if (requests.length === 1) {
                    return new Promise((resolve) => { finishInitial = resolve; });
                }
                return Promise.resolve(result([`row-${requests.length}`]));
            },
        });
        const online = { query: QUERY_A, selected: true, online: true, supported: true };

        const initial = controller.update(online);
        const staleRefresh = controller.refresh();
        await controller.update({ ...online, online: false });
        expect(requests[0]?.signal.aborted).toBe(true);
        finishInitial(result(['stale']));
        await Promise.all([initial, staleRefresh]);

        await controller.update(online);
        await Promise.resolve();
        expect(requests).toHaveLength(2);
        expect(controller.getSnapshot()).toMatchObject({
            phase: 'ready',
            addresses: [{ serverId: 'home-a', sessionId: 'row-2' }],
        });

        void controller.invalidate();
        await Promise.resolve();
        expect(requests).toHaveLength(3);
        expect(controller.getSnapshot()).toMatchObject({
            phase: 'ready',
            addresses: [{ serverId: 'home-a', sessionId: 'row-3' }],
        });
    });

    it('serves an archived corpus through its released GET adapter when filtered listing is unavailable', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => {
                requests.push(request);
                return result(request.cursor ? ['archived-2'] : ['archived-1'], {
                    nextCursor: request.cursor ? null : 'cursor-1',
                    hasNext: !request.cursor,
                });
            },
            now: () => 100,
        });

        await controller.update({
                        query: QUERY_ARCHIVED,
            selected: true,
            online: true,
            supported: false,
            ordinaryAdapter: { path: '/v2/sessions/archived', allowV1Fallback: false, membership: 'archived' },
        });
        await controller.loadNext();

        expect(requests.map((request) => request.source)).toEqual([
            { kind: 'ordinary', path: '/v2/sessions/archived', allowV1Fallback: false },
            { kind: 'ordinary', path: '/v2/sessions/archived', allowV1Fallback: false },
        ]);
        expect(requests.every((request) => request.membership === 'archived')).toBe(true);
        expect(requests[1]?.cursor).toBe('cursor-1');
        expect(controller.getSnapshot()).toMatchObject({
            appliedQueryKey: KEY_ARCHIVED,
            addresses: [
                { serverId: 'home-a', sessionId: 'archived-1' },
                { serverId: 'home-a', sessionId: 'archived-2' },
            ],
            phase: 'ready',
            failureReason: null,
        });
    });

    it('advances the ordinary adapter independently on every selected Home', async () => {
        const requestCountByHome = new Map<string, number>();
        const createHome = (serverId: string) => createSessionListQueryHomeController({
            serverId,
            fetchPage: async (request) => {
                const requestCount = (requestCountByHome.get(serverId) ?? 0) + 1;
                requestCountByHome.set(serverId, requestCount);
                return result(
                    serverId === 'home-b' && request.cursor ? ['older-external-session'] : [],
                    {
                        nextCursor: request.cursor ? null : `next:${serverId}`,
                        hasNext: !request.cursor,
                    },
                );
            },
        });
        const homeA = createHome('home-a');
        const homeB = createHome('home-b');
        const ordinaryAdapter = {
            path: '/v2/sessions',
            allowV1Fallback: true,
            membership: 'ordinary',
        } as const;

        await Promise.all([homeA, homeB].map((controller) => controller.update({
            query: QUERY_ORDINARY,
            selected: true,
            online: true,
            supported: false,
            ordinaryAdapter,
        })));
        await Promise.all([homeA.loadNext(), homeB.loadNext()]);

        expect(requestCountByHome).toEqual(new Map([
            ['home-a', 2],
            ['home-b', 2],
        ]));
        expect(homeA.getSnapshot().addresses).toEqual([]);
        expect(homeB.getSnapshot().addresses).toEqual([
            { serverId: 'home-b', sessionId: 'older-external-session' },
        ]);
    });

    it('advances an active local-search corpus by exactly one ordinary page per load-next action', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        const ordinaryQuery: SessionListQueryV1 = {
            v: 1,
            storage: 'active',
            includeInactive: false,
            scope: 'my_work',
            attention: 'any',
            audiences: [],
            tagIds: [],
            includeAttention: true,
        };
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => {
                requests.push(request);
                return result(request.cursor ? ['older-match'] : [], {
                    nextCursor: request.cursor ? null : 'cursor-1',
                    hasNext: !request.cursor,
                });
            },
        });

        await controller.update({
            query: ordinaryQuery,
            selected: true,
            online: true,
            supported: false,
            ordinaryAdapter: { path: '/v2/sessions', allowV1Fallback: true, membership: 'ordinary' },
        });

        expect(controller.getSnapshot()).toMatchObject({
            addresses: [],
            hasNext: true,
            phase: 'ready',
        });

        await controller.loadNext();

        expect(requests).toHaveLength(2);
        expect(requests.map((request) => request.source)).toEqual([
            { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: true },
            { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: true },
        ]);
        expect(requests[1]?.cursor).toBe('cursor-1');
        expect(requests.every((request) => request.membership === 'ordinary')).toBe(true);
        expect(controller.getSnapshot()).toMatchObject({
            addresses: [{ serverId: 'home-a', sessionId: 'older-match' }],
            hasNext: false,
            phase: 'ready',
        });
    });

    it('keeps strict query admission at supported === true when a corpus also has a GET adapter', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => {
                requests.push(request);
                return result(['s1']);
            },
            now: () => 100,
        });

        await controller.update({
                        query: QUERY_ARCHIVED,
            selected: true,
            online: true,
            supported: true,
            ordinaryAdapter: { path: '/v2/sessions/archived', allowV1Fallback: false, membership: 'archived' },
        });

        expect(requests).toHaveLength(1);
        expect(requests[0]?.source.kind).toBe('query');
        expect(requests[0]?.membership).toBe('query');
    });

    it('can hydrate strict-query rows without publishing them as the mounted query membership', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => {
                requests.push(request);
                return result(['personal-1']);
            },
            now: () => 100,
        });

        await controller.update({
            query: QUERY_A,
            selected: true,
            online: true,
            supported: true,
            queryMembership: 'rowOnly',
        });

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            source: { kind: 'query' },
            membership: 'rowOnly',
        });
        expect(controller.getSnapshot()).toMatchObject({
            appliedSourceKind: 'query',
            addresses: [{ serverId: 'home-a', sessionId: 'personal-1' }],
        });
    });

    it('still reports unsupported when a corpus has no released GET adapter', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => {
                requests.push(request);
                return result(['s1']);
            },
            now: () => 100,
        });

        await controller.update({
                        query: QUERY_A,
            selected: true,
            online: true,
            supported: false,
        });

        expect(requests).toHaveLength(0);
        expect(controller.getSnapshot()).toMatchObject({
            phase: 'error',
            failureReason: 'unsupported',
            failureCode: 'filtered_session_listing_unavailable',
        });
    });

    it('never requests attention continuation through the released GET adapter', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => {
                requests.push(request);
                // A released GET response carries no independent attention frontier.
                return result(['archived-1'], { attentionNextCursor: 'attention-1', attentionHasNext: true });
            },
            now: () => 100,
        });

        await controller.update({
                        query: QUERY_ARCHIVED,
            selected: true,
            online: true,
            supported: false,
            ordinaryAdapter: { path: '/v2/sessions/archived', allowV1Fallback: false, membership: 'archived' },
        });
        await controller.loadNext();

        expect(requests).toHaveLength(1);
        expect(requests.every((request) => request.attentionCursor === undefined)).toBe(true);
    });

    it('sends the requested page limit on the initial page and on both continuation families', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => {
                requests.push(request);
                return result([`row-${requests.length}`], {
                    nextCursor: requests.length === 1 ? 'ordinary-1' : null,
                    hasNext: requests.length === 1,
                    attentionNextCursor: requests.length <= 2 ? 'attention-1' : null,
                    attentionHasNext: requests.length <= 2,
                });
            },
        });

        await controller.update({
            query: { ...QUERY_A, limit: 12 },
            selected: true,
            online: true,
            supported: true,
        });
        await controller.loadNext();
        await controller.loadNext();

        expect(requests).toHaveLength(3);
        expect(requests.map((request) => request.limit)).toEqual([12, 12, 12]);
        expect(requests.map((request) => (
            request.source.kind === 'query' ? request.source.body.limit : null
        ))).toEqual([12, 12, 12]);
        expect(requests[1]?.cursor).toBe('ordinary-1');
        expect(requests[2]?.attentionCursor).toBe('attention-1');
    });

    it('derives one query identity from the normalized query, so selector order alone never refetches', async () => {
        const requests: SessionListQueryPageRequest[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async (request) => {
                requests.push(request);
                return result(['one']);
            },
        });

        const reordered: SessionListQueryV1 = {
            ...QUERY_A,
            audiences: [{ kind: 'team', teamId: 'team-b' }, { kind: 'team', teamId: 'team-a' }],
            tagIds: ['tag-b', 'tag-a'],
        };
        const sameCorpus: SessionListQueryV1 = {
            ...QUERY_A,
            audiences: [{ kind: 'team', teamId: 'team-a' }, { kind: 'team', teamId: 'team-b' }],
            tagIds: ['tag-a', 'tag-b'],
        };

        await controller.update({ query: reordered, selected: true, online: true, supported: true });
        const appliedAfterFirst = controller.getSnapshot().appliedQueryKey;
        await controller.update({ query: sameCorpus, selected: true, online: true, supported: true });

        expect(requests).toHaveLength(1);
        expect(controller.getSnapshot().appliedQueryKey).toBe(appliedAfterFirst);
        expect(controller.getSnapshot().requestedQueryKey).toBe(appliedAfterFirst);

        await controller.update({ query: QUERY_B, selected: true, online: true, supported: true });
        expect(requests).toHaveLength(2);
        expect(controller.getSnapshot().appliedQueryKey).not.toBe(appliedAfterFirst);
    });

    it('records which request adapter answered the applied query', async () => {
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async () => result(['one']),
        });

        await controller.update({ query: QUERY_A, selected: true, online: true, supported: true });
        expect(controller.getSnapshot().appliedSourceKind).toBe('query');

        await controller.update({
            query: QUERY_ARCHIVED,
            selected: true,
            online: true,
            supported: false,
            ordinaryAdapter: { path: '/v2/sessions/archived', allowV1Fallback: false, membership: 'archived' },
        });
        expect(controller.getSnapshot()).toMatchObject({
            appliedSourceKind: 'ordinary',
            phase: 'ready',
        });
    });

});
