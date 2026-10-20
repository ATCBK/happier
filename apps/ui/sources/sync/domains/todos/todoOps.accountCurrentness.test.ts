import { afterEach, describe, expect, it } from 'vitest';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { fetchTodos } = await import('./todoOps');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => { await connection?.dispose(); });

describe('Todo reads through Account currentness', () => {
    it('refuses Todo reads and preserves prior state when an old Home lacks Account currentness', async () => {
        let currentnessUnavailable = false;
        const todoRequests: Array<{ path: string; method: string }> = [];
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://todo-currentness.example.test',
            accountId: 'todo-account',
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/account/encryption/currentness') {
                    if (currentnessUnavailable) {
                        todoRequests.push({ path, method: init?.method ?? 'GET' });
                        return Response.json({ error: 'not-found' }, { status: 404 });
                    }
                    return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                }
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'todo-account' });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v2/sessions/active' || path === '/v2/sessions/query') return Response.json({
                    sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                });
                if (path === '/v1/machines' || path === '/v1/artifacts') return Response.json([]);
                if (path === '/v1/friends') return Response.json({ friends: [] });
                if (path === '/v1/kv') {
                    if (currentnessUnavailable) todoRequests.push({ path, method: init?.method ?? 'GET' });
                    return Response.json({ items: [] });
                }
                if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
                if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
                return null;
            },
        });
        await expect.poll(() => storage.getState().isDataReady).toBe(true);
        const priorState = { todos: {}, undoneOrder: [], doneOrder: [], versions: {} };
        storage.getState().applyTodos(priorState);
        currentnessUnavailable = true;

        await expect(fetchTodos(connection.credentials)).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
            reason: 'account_currentness_unavailable',
        });
        expect(todoRequests).toEqual([{ path: '/v1/account/encryption/currentness', method: 'GET' }]);
        expect(storage.getState().todoState).toEqual(priorState);
    });
});
