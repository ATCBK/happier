import { describe, expect, it } from 'vitest';

import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';

import { decodeTodoStoredContent, encodeTodoStoredContent, TodoStoredContentUnavailableError } from './todoStoredContent';

describe('Todo stored reader', () => {
    const todo = { id: 'task-a', title: 'Retained task', done: false, createdAt: 1, updatedAt: 2 };
    const read = (key: string, value: unknown) => decodeTodoStoredContent({
        key, encoded: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: value }),
        expectedMode: 'plain', encryption: null,
    });

    it('projects stored index and nested task fields while canonical writes stay strict', async () => {
        const index = { undoneOrder: ['task-a'], completedOrder: [] };
        const session = { serverId: 'home-a', accountId: 'account-a', sessionId: 'session-a' };
        const link = { title: 'Linked', linkedAt: 3, session };
        const retained = { ...todo, retired: true, linkedSessions: { 'session-a': {
            ...link, retired: true, session: { ...session, retired: true },
        } } };
        await expect(read('todo.index', { ...index, retired: true })).resolves.toEqual({ kind: 'index', value: index });
        await expect(read('todo.task-a', retained)).resolves.toEqual({
            kind: 'item', todoId: 'task-a', value: { ...todo, linkedSessions: { 'session-a': link } },
        });
        await expect(encodeTodoStoredContent({ key: 'todo.task-a', mode: 'plain', value: retained, encryption: null }))
            .rejects.toBeInstanceOf(TodoStoredContentUnavailableError);
        await expect(read('todo.other', retained)).rejects.toBeInstanceOf(TodoStoredContentUnavailableError);
        await expect(read('todo.task-a', { ...retained, done: 'no' })).rejects.toBeInstanceOf(TodoStoredContentUnavailableError);
    });
});
