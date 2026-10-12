import { describe, expect, it } from 'vitest';

import {
  applyTodoSessionLinkV1, buildTodoSessionLinkKeyV1, TodoItemV1Schema,
  TodoSessionLinkInputV1Schema, type TodoItemV1,
} from './todoSessionLinkV1.js';

describe('stored Todo session linking', () => {
  it('links retained rows with retired fields and writes only the canonical shape after a CAS retry', async () => {
    const session = { serverId: 'home', accountId: 'account', sessionId: 'new-session' };
    const input = { scope: { serverId: 'home', accountId: 'account' }, taskId: 'task', session };
    const todo = { id: 'task', title: 'Task', done: false, createdAt: 1, updatedAt: 2,
      retired: true, linkedSessions: { previous: { title: 'Previous', linkedAt: 1, retired: true } } };
    const retried = { ...todo, linkedSessions: { ...todo.linkedSessions,
      concurrent: { title: 'Concurrent', linkedAt: 2, retired: true,
        session: { serverId: 'home', accountId: 'account', sessionId: 'concurrent', retired: true } } } };
    const written: unknown[] = [];
    let published: TodoItemV1 | undefined;
    await applyTodoSessionLinkV1(input, {
      read: async () => ({ value: todo, version: 1 }),
      compareAndSet: async (value, version) => {
        written.push(value);
        return version === 1 ? { success: false, value: retried, version: 2 }
          : { success: true, version: 3 };
      },
    }, { requireCurrent: () => {}, publish: value => { published = value; } });
    expect(written).toHaveLength(2);
    expect(published?.done).toBe(false);
    expect(published?.linkedSessions).toMatchObject({
      previous: { title: 'Previous', linkedAt: 1 },
      concurrent: { title: 'Concurrent', linkedAt: 2, session: { serverId: 'home', accountId: 'account', sessionId: 'concurrent' } },
      [buildTodoSessionLinkKeyV1(session)]: { title: 'Task', session },
    });
    expect(TodoItemV1Schema.safeParse(published).success).toBe(true);
    expect(published).not.toHaveProperty('retired');
    expect(published?.linkedSessions?.previous).not.toHaveProperty('retired');
    expect(published?.linkedSessions?.concurrent.session).not.toHaveProperty('retired');
    expect(TodoItemV1Schema.safeParse(todo).success).toBe(false);
    expect(TodoSessionLinkInputV1Schema.safeParse({ ...input, retired: true }).success).toBe(false);
  });

  it('still refuses malformed known stored fields', async () => {
    await expect(applyTodoSessionLinkV1({ scope: { serverId: 'home', accountId: 'account' }, taskId: 'task',
      session: { serverId: 'home', accountId: 'account', sessionId: 'new-session' } }, {
      read: async () => ({ value: { id: 'task', title: 'Task', done: 'false', createdAt: 1, updatedAt: 2, retired: true }, version: 1 }),
      compareAndSet: async () => { throw new Error('Malformed rows must not be written'); },
    }, { requireCurrent: () => {} })).rejects.toMatchObject({ code: 'task_link_failed' });
  });
});
