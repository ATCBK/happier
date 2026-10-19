import { z } from 'zod/mini';

/** No implicit truncation: callers may choose a page size, otherwise all admitted rows are returned. */
export const FollowListPageRequestV1Schema = z.strictObject({
  cursor: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.positive())),
});
export const FollowListPageQueryV1Schema = z.strictObject({
  cursor: FollowListPageRequestV1Schema.shape.cursor,
  limit: z.optional(z.coerce.number().check(z.int(), z.positive())),
});
export type FollowListPageRequestV1 = z.infer<typeof FollowListPageRequestV1Schema>;
export const FollowListPageResultFieldsV1 = {
  continuation: z.optional(z.string().check(z.minLength(1))),
} as const;

const cursorSchema = z.strictObject({ v: z.literal(1), scope: z.string(), after: z.string() });

/** Source owners page their authorized corpus; a cursor never grants access or freezes membership. */
export function pageFollowListV1<T>(input: FollowListPageRequestV1 & Readonly<{
  scope: string;
  rows: readonly T[];
  key: (row: T) => string;
}>): Readonly<{ rows: T[]; continuation?: string }> {
  const request = FollowListPageRequestV1Schema.parse({ cursor: input.cursor, limit: input.limit });
  let after: string | undefined;
  if (request.cursor !== undefined) {
    const cursor = cursorSchema.parse(JSON.parse(request.cursor));
    if (cursor.scope !== input.scope) throw new Error('follow_list_cursor_scope_mismatch');
    after = cursor.after;
  }
  const ordered = input.rows.map(row => ({ row, key: input.key(row) }))
    .filter(entry => after === undefined || entry.key > after)
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const selected = request.limit === undefined ? ordered : ordered.slice(0, request.limit);
  const last = selected.at(-1);
  return { rows: selected.map(entry => entry.row), ...(last && selected.length < ordered.length
    ? { continuation: JSON.stringify({ v: 1, scope: input.scope, after: last.key }) } : {}) };
}

export function appendFollowListPageQueryV1(path: string, request: FollowListPageRequestV1): string {
  const query = new URLSearchParams();
  if (request.cursor !== undefined) query.set('cursor', request.cursor);
  if (request.limit !== undefined) query.set('limit', String(request.limit));
  return query.size ? `${path}?${query}` : path;
}
