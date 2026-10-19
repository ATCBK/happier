import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeRawMessage } from '@happier-dev/session-core';
import type { Message } from '@happier-dev/session-core/messages';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { SESSION_INPUT_AUTHORITY_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderHook, flushHookEffects, createDeferred } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useSelectedSessionMessageReply } = await import('./useSelectedSessionMessageReply');
beforeEach(async () => { await homes.reset(); });
afterEach(standardCleanup);

function returnedMessage(): Message {
    const normalized = normalizeRawMessage('returned-committed', 'returned-local', 20, {
        role: 'user', content: { type: 'text', text: 'The answer' }, meta: {
            [SESSION_INPUT_AUTHORITY_META_KEY]: { v: 1, producer: 'sessionAction',
                permission: { admittedPermissionCeiling: 'read-only' }, returnedAnswer: {
                    requestSessionId: 'receiver', requestLocalId: 'question/1', outcome: 'answer', delivery: 'wake',
                } },
        },
    });
    if (!normalized) throw new Error('Expected a normalized returned message');
    const message = reducer(createReducer(), [normalized]).messages[0];
    if (!message) throw new Error('Expected a rendered returned message');
    return message;
}

async function setup() {
    const serverId = await homes.addHome({ name: 'Original', serverUrl: 'https://selected-reply.test', accountId: 'alice', currentAccount: true });
    return { scope: { serverId, accountId: 'alice' }, sessionId: 'asker', message: returnedMessage(), active: true };
}

function answerOriginal(serverId: string, outcome: object = { kind: 'answer', result: { sessionId: 'receiver', messageId: 'exact-answer' } }) {
    homes.answer(serverId, '/v2/sessions/receiver/messages/by-local-id/question%2F1', { body: { message: {
        id: 'committed-question', seq: 5, localId: 'question/1', createdAt: 10,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Original question' } } },
    } } });
    homes.answer(serverId, '/v2/sessions/receiver/messages/by-local-id/question%2F1/reply', { body: {
        v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'inline', outcome },
    } });
}

describe('selected Session request reply', () => {
    it('resolves a real rendered return to the committed original request and exact answer without scanning history', async () => {
        const params = await setup();
        answerOriginal(params.scope.serverId);
        const hook = await renderHook(useSelectedSessionMessageReply, { initialProps: params });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', model: {
            request: { sessionId: 'receiver', localId: 'question/1' },
            requestRef: { kind: 'session', session: { serverId: params.scope.serverId, sessionId: 'receiver' }, messageId: 'committed-question' },
            resultRef: { kind: 'session', session: { serverId: params.scope.serverId, sessionId: 'receiver' }, messageId: 'exact-answer' },
            reply: { status: 'available', progress: { outcome: { kind: 'answer' } } },
            delivery: { status: 'answered' },
        } });
        expect(homes.requests.filter(request => request.path.includes('/messages')).map(request => request.path).sort()).toEqual([
            '/v2/sessions/receiver/messages/by-local-id/question%2F1',
            '/v2/sessions/receiver/messages/by-local-id/question%2F1/reply',
        ]);
    });

    it('does no work while unselected and reads actual pass state on selection without promoting it to answered', async () => {
        const params = await setup();
        answerOriginal(params.scope.serverId, { kind: 'pass' });
        const hook = await renderHook(useSelectedSessionMessageReply, { initialProps: { ...params, active: false } });
        expect(hook.getCurrent()).toEqual({ status: 'inactive' });
        expect(homes.requests.filter(request => request.path.includes('/messages'))).toEqual([]);
        await hook.rerender(params);
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', model: {
            resultRef: null, reply: { status: 'available', progress: { outcome: { kind: 'pass' } } }, delivery: { status: null },
        } });
    });

    it('drops retired selection reads and never substitutes the local id for a missing committed request', async () => {
        const params = await setup();
        answerOriginal(params.scope.serverId);
        const ready = createDeferred<void>();
        const release = createDeferred<void>();
        homes.answer(params.scope.serverId, '/v2/sessions/receiver/messages/by-local-id/question%2F1/reply', { select: async () => {
            ready.resolve();
            await release.promise;
            return { body: { v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'inline', outcome: { kind: 'pass' } } } };
        } });
        const hook = await renderHook(useSelectedSessionMessageReply, { initialProps: params });
        await ready.promise;
        await hook.rerender({ ...params, active: false });
        release.resolve();
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent()).toEqual({ status: 'inactive' });
        answerOriginal(params.scope.serverId, { kind: 'failed' });
        homes.answer(params.scope.serverId, '/v2/sessions/receiver/messages/by-local-id/question%2F1', { status: 404, body: { error: 'not_found' } });
        await hook.rerender(params);
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', model: {
            requestRef: null, requestMessage: null, resultRef: null,
            reply: { status: 'available', progress: { outcome: { kind: 'failed' } } }, delivery: { status: null },
        } });
    });

    it('reads a selected original input once, preserves its data during explicit refresh and accepts no unrelated transcript replacement', async () => {
        const params = await setup();
        const original = { kind: 'user-text', id: 'render-id', realID: 'actual-question', localId: 'own-question', createdAt: 10, text: 'Question' } satisfies Message;
        const selected = { ...params, sessionId: 'own-session', message: original, refreshKey: 0 };
        const path = '/v2/sessions/own-session/messages/by-local-id/own-question';
        homes.answer(params.scope.serverId, path, { body: { message: {
            id: 'actual-question', seq: 1, localId: 'own-question', createdAt: 10, content: { t: 'encrypted', c: 'opaque-content' },
        } } });
        homes.answer(params.scope.serverId, `${path}/reply`, { body: { v: 1, status: 'available', progress: {
            v: 1, mode: 'wait', disposition: 'observing',
        } } });
        const hook = await renderHook(useSelectedSessionMessageReply, { initialProps: selected });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', refreshing: false, model: {
            request: { sessionId: 'own-session', localId: 'own-question' }, requestMessage: { content: { t: 'encrypted', c: 'opaque-content' } },
            resultRef: null, reply: { progress: { disposition: 'observing' } },
        } });
        const prior = hook.getCurrent();
        const requests = homes.requests.length;
        await hook.rerender({ ...selected, message: { ...original } });
        expect(hook.getCurrent()).toBe(prior);
        expect(homes.requests).toHaveLength(requests);
        const ready = createDeferred<void>();
        const release = createDeferred<void>();
        homes.answer(params.scope.serverId, `${path}/reply`, { select: async () => {
            ready.resolve();
            await release.promise;
            return { body: { v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'inline', outcome: { kind: 'cancelled' } } } };
        } });
        await hook.rerender({ ...selected, refreshKey: 1 });
        await ready.promise;
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', refreshing: true, model: { reply: { progress: { disposition: 'observing' } } } });
        release.resolve();
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', refreshing: false, model: {
            reply: { progress: { outcome: { kind: 'cancelled' } } }, delivery: { status: null },
        } });
    });

    it('retires the whole selected read if Account authority changes after the committed row already arrived', async () => {
        const params = await setup();
        answerOriginal(params.scope.serverId);
        const ready = createDeferred<void>();
        const release = createDeferred<void>();
        homes.answer(params.scope.serverId, '/v2/sessions/receiver/messages/by-local-id/question%2F1/reply', { select: async () => {
            ready.resolve();
            await release.promise;
            return { body: { v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'inline', outcome: { kind: 'pass' } } } };
        } });
        const hook = await renderHook(useSelectedSessionMessageReply, { initialProps: params });
        await ready.promise;
        await flushHookEffects({ cycles: 20 });
        await homes.switchAccount(params.scope.serverId, 'bob');
        release.resolve();
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', model: {
            requestMessage: null, requestRef: null, resultRef: null, reply: { status: 'unavailable' },
        } });
    });
});
