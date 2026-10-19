import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { decodeV2SessionListCursorV1, decodeV2SessionListCursorV2 } from './cursor.js';

// Shared with the ordinary V2 HTTP page. Selector counts remain subject to the
// transport/database boundaries, not an additional query-language quota.
export const SESSION_LIST_PAGE_DEFAULT_LIMIT = 50;
export const SESSION_LIST_PAGE_MAX_LIMIT = 200;

export const SessionListScopeV1Schema = lazyZodSchema(() => z.enum([
  'my_work', 'assigned_to_me', 'following', 'involving_me', 'all_accessible',
]));
export type SessionListScopeV1 = z.infer<typeof SessionListScopeV1Schema>;

export const SessionAttentionFilterV1Schema = lazyZodSchema(() => z.enum(['any', 'needs_my_attention']));
export type SessionAttentionFilterV1 = z.infer<typeof SessionAttentionFilterV1Schema>;

/** Authorized clients project this facet from Session metadata, not server-readable work state. */
export const SessionBotFilterV1Schema = lazyZodSchema(() => z.enum(['bot', 'ordinary']));
export type SessionBotFilterV1 = z.infer<typeof SessionBotFilterV1Schema>;

const SelectorIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

// Each identity/selection object is closed, independently of the query envelope.
export const SessionAudienceSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('outside_teams') }),
  z.strictObject({ kind: z.literal('team'), teamId: SelectorIdSchema }),
  z.strictObject({ kind: z.literal('group'), teamId: SelectorIdSchema, groupId: SelectorIdSchema }),
]));
export type SessionAudienceSelectionV1 = Readonly<z.infer<typeof SessionAudienceSelectionV1Schema>>;

function audienceKey(audience: SessionAudienceSelectionV1): string {
  switch (audience.kind) {
    case 'outside_teams': return JSON.stringify([audience.kind]);
    case 'team': return JSON.stringify([audience.kind, audience.teamId]);
    case 'group': return JSON.stringify([audience.kind, audience.teamId, audience.groupId]);
  }
}

const AudienceSelectionsSchema = lazyZodSchema(() => z.pipe(z.array(SessionAudienceSelectionV1Schema).check(z.refine((values) => new Set(values.map(audienceKey)).size === values.length, {
    message: 'Duplicate audience selectors',
  })), z.transform((values) => {
    const teams = new Set(values.filter((value) => value.kind === 'team').map((value) => value.teamId));
    return values
      .filter((value) => value.kind !== 'group' || !teams.has(value.teamId))
      .sort((a, b) => {
        const left = audienceKey(a);
        const right = audienceKey(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
  })));

const TagIdsSchema = lazyZodSchema(() => z.pipe(z.array(SelectorIdSchema).check(z.refine((values) => new Set(values).size === values.length, { message: 'Duplicate tag selectors' })), z.transform((values) => values.sort())));

const FolderIdsSchema = lazyZodSchema(() => z.pipe(z.array(SelectorIdSchema).check(z.refine((values) => new Set(values).size === values.length, { message: 'Duplicate folder selectors' })), z.transform((values) => values.sort())));

const CursorSchema = lazyZodSchema(() => z.string().check(z.refine((value) => decodeV2SessionListCursorV2(value) !== null || decodeV2SessionListCursorV1(value) !== null, { message: 'Invalid cursor format' })));

/** V1 is a closed Home-local selection contract, independent of package SemVer. */
export const SessionListQueryV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  storage: z.enum(['active', 'archived']),
  includeInactive: z.boolean(),
  scope: SessionListScopeV1Schema,
  attention: SessionAttentionFilterV1Schema,
  // The server returns the structural candidate corpus and its original cursors.
  // Clients apply this selection only after authorized metadata hydration.
  bot: z.optional(SessionBotFilterV1Schema),
  /** Relation facts are selected by the Home owner before pagination. */
  coordinator: z.optional(z.literal('coordinator')),
  audiences: AudienceSelectionsSchema,
  tagIds: TagIdsSchema,
  folderIds: z.optional(FolderIdsSchema),
  underSessionId: z.optional(SelectorIdSchema),
  cursor: z.optional(CursorSchema),
  attentionCursor: z.optional(CursorSchema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(SESSION_LIST_PAGE_MAX_LIMIT))),
  includeAttention: z.optional(z.boolean()),
}).check(z.refine((value) => value.cursor === undefined || value.attentionCursor === undefined, { message: 'cursor and attentionCursor cannot be combined', path: ['attentionCursor'] })));

export type SessionListQueryV1 = Readonly<Omit<z.infer<typeof SessionListQueryV1Schema>, 'audiences' | 'tagIds' | 'folderIds'> & {
  audiences: readonly SessionAudienceSelectionV1[];
  tagIds: readonly string[];
  folderIds?: readonly string[];
}>;

/** Bot selection never asks a server to inspect encrypted metadata, including older strict servers. */
export function buildSessionListServerQueryV1(query: SessionListQueryV1): Omit<SessionListQueryV1, 'bot'> {
  if (query.bot === undefined) return query;
  const { bot: _bot, ...structuralQuery } = query;
  return structuralQuery;
}

export const SessionListUnavailableQueryV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.literal('not_found'),
  code: z.literal('filtered_session_listing_unavailable'),
  reason: z.enum(['audience', 'scope', 'following', 'coordinator']),
}));

export type SessionListUnavailableQueryV1 = Readonly<z.infer<typeof SessionListUnavailableQueryV1Schema>>;
