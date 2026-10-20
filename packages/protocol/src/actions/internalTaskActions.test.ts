import { expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';

it('publishes the canonical personal-task Actions and removes the replaced todo Action identities', () => {
  for (const id of ['tasks.internal.list', 'tasks.internal.create', 'tasks.internal.edit', 'tasks.internal.transition', 'tasks.internal.reorder', 'tasks.internal.session.link']) {
    expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
  }
  expect(ActionIdSchema.safeParse('todos.reorder').success).toBe(false);
  expect(ActionIdSchema.safeParse('todos.session.link').success).toBe(false);
});
