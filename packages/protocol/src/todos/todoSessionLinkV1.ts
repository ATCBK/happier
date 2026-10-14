import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
const scopeIdentity = z.strictObject({ serverId: z.string().check(z.minLength(1)), accountId: z.string().check(z.minLength(1)) });
const sessionIdentity = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scopeIdentity, { sessionId: z.string().check(z.minLength(1)) }));
const linkedSession = z.strictObject({ title: z.string(), linkedAt: z.number(), session: z.optional(sessionIdentity) });
/** The existing todo.<id> record, including released bare Session-key links. */
export const TodoItemV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), title: z.string(), done: z.boolean(), createdAt: z.number(), updatedAt: z.number(),
  completedAt: z.optional(z.number()), linkedSessions: z.optional(z.record(z.string(), linkedSession)),
}));
export const TodoItemV1StoredSchema = createStoredReadSchema(TodoItemV1Schema);
export type TodoItemV1 = z.infer<typeof TodoItemV1Schema>;
export const TodoSessionLinkInputV1Schema = lazyZodSchema(() => z.strictObject({
  scope: scopeIdentity, taskId: z.string().check(z.minLength(1)), session: sessionIdentity,
}));
export type TodoSessionLinkInputV1 = z.infer<typeof TodoSessionLinkInputV1Schema>;
export const TodoSessionLinkOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('linked') }),
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('refused'), reason: z.enum(['task_deleted', 'task_scope_mismatch', 'invalid_input']) }),
  z.strictObject({ status: z.literal('unknown'), reason: z.literal('task_link_failed') }),
]));
export type TodoSessionLinkOutputV1 = z.infer<typeof TodoSessionLinkOutputV1Schema>;
export class TodoSessionLinkErrorV1 extends Error {
  constructor(readonly code: 'task_deleted' | 'task_scope_mismatch' | 'task_link_failed', readonly cause?: unknown) {
    super(code); this.name = 'TodoSessionLinkError';
  }
}
export type TodoSessionLinkJsonPortV1 = Readonly<{
  read: () => Promise<Readonly<{ value: unknown; version: number }>>;
  compareAndSet: (value: unknown, version: number) => Promise<
    | Readonly<{ success: true; version: number }>
    | Readonly<{ success: false; value: unknown; version: number }>>;
}>;
/** Existing length-prefixed identity; persisted keys do not change in this extraction. */
export function buildTodoSessionLinkKeyV1(session: TodoSessionLinkInputV1['session']): string {
  return [session.serverId, session.accountId, session.sessionId].map(part => `${part.length}:${part}`).join('');
}
/** One semantic KV/CAS owner, shared by accepted creation and Action execution. Never marks Done. */
export async function applyTodoSessionLinkV1(input: TodoSessionLinkInputV1, port: TodoSessionLinkJsonPortV1,
  options: Readonly<{ requireCurrent: () => void; title?: string; publish?: (todo: TodoItemV1, version: number) => void }>): Promise<void> {
  const check = options.requireCurrent;
  try {
    check(); let row = await port.read(); check();
    const key = buildTodoSessionLinkKeyV1(input.session);
    while (true) {
      if (row.value === null) throw new TodoSessionLinkErrorV1('task_deleted');
      const todo = TodoItemV1StoredSchema.parse(row.value);
      if (todo.id !== input.taskId) throw new TodoSessionLinkErrorV1('task_link_failed');
      check();
      const predecessor = todo.linkedSessions?.[input.session.sessionId];
      if (todo.linkedSessions?.[key]?.session || (input.scope.serverId === input.session.serverId
        && input.scope.accountId === input.session.accountId && predecessor && predecessor.session === undefined)) {
        options.publish?.(todo, row.version); return;
      }
      const updated: TodoItemV1 = { ...todo, updatedAt: Date.now(), linkedSessions: { ...todo.linkedSessions,
        [key]: { title: options.title ?? todo.title, linkedAt: Date.now(), session: input.session } } };
      check(); const result = await port.compareAndSet(updated, row.version); check();
      if (result.success) { options.publish?.(updated, result.version); return; }
      row = result;
    }
  } catch (error) {
    if (error instanceof TodoSessionLinkErrorV1) throw error;
    throw new TodoSessionLinkErrorV1('task_link_failed', error);
  }
}
export function projectTodoSessionLinkFailureV1(error: unknown): TodoSessionLinkOutputV1 {
  if (error instanceof TodoSessionLinkErrorV1 && error.code !== 'task_link_failed') return { status: 'refused', reason: error.code };
  // A failed write can have been accepted; the same intent is safe to retry.
  return { status: 'unknown', reason: 'task_link_failed' };
}
