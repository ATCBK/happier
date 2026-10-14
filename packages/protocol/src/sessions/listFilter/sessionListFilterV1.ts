import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { readSessionBotV1 } from '../identity/sessionBotV1.js';
import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '../../workspaces/workspaceRefV1.js';
import { projectWorkspaceRefV1, resolveWorkspaceRefV1, type WorkspaceRefResolutionContextV1 } from '../../workspaces/workspaceRefResolutionV1.js';

import {
    SessionAttentionFilterV1Schema,
    SessionBotFilterV1Schema,
    SessionAudienceSelectionV1Schema,
    SessionListScopeV1Schema,
    type SessionAttentionFilterV1,
    type SessionBotFilterV1,
    type SessionListScopeV1,
    type SessionAudienceSelectionV1,
} from '../listing/query.js';

export type QualifiedAudienceSelection = Readonly<{ serverId: string }> & SessionAudienceSelectionV1;
export type QualifiedTagAddress = Readonly<{ serverId: string; tagId: string }>;

export const SessionListShowV1Schema = lazyZodSchema(() => z.enum(['sessions', 'runs', 'both']));
export const SessionListStartedByV1Schema = lazyZodSchema(() => z.enum(['you', 'triggers', 'agents']));

/** Serializable selection shared by the Sessions list and inline Board filters. */
export type SessionListFilterV1 = Readonly<{
    show: z.infer<typeof SessionListShowV1Schema>;
    startedBy: readonly z.infer<typeof SessionListStartedByV1Schema>[];
    scope: SessionListScopeV1;
    attention: SessionAttentionFilterV1;
    bot?: SessionBotFilterV1;
    homeServerIds: readonly string[];
    audiences: readonly QualifiedAudienceSelection[];
    tagIds: readonly QualifiedTagAddress[];
    source: 'all' | 'persisted' | 'direct';
}>;

export type SessionListFilterDefaultsInputV1 = Partial<SessionListFilterV1>;

/** Owner metadata only. Account/Team admission and corpus membership belong to the list producer. */
export function matchSessionProjectFilterV1(
    metadata: unknown,
    serverId: string,
    project: QualifiedProjectKeyV1,
    workspaceRefs?: readonly WorkspaceRefV1[],
    context: WorkspaceRefResolutionContextV1 = {},
): 'match' | 'miss' | 'unavailable' {
    const home = context.normalizeServerId ?? ((id: string) => id.trim());
    if (home(serverId) !== home(project.serverId)) return 'miss';
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'unavailable';
    const record = metadata as Readonly<Record<string, unknown>>;
    if (record.projectId !== undefined && record.projectId !== null) {
        if (typeof record.projectId !== 'string' || !record.projectId.trim()) return 'unavailable';
        return record.projectId === project.projectKey ? 'match' : 'miss';
    }
    const checkoutId = record.workspaceId;
    if (checkoutId !== undefined && checkoutId !== null && (typeof checkoutId !== 'string' || !checkoutId.trim())) return 'unavailable';
    const target = typeof checkoutId === 'string'
        ? { serverId, id: checkoutId }
        : typeof record.machineId === 'string' && typeof record.path === 'string'
            ? { serverId, machineId: record.machineId, rootPath: record.path }
            : null;
    if (!target) return 'miss';
    if (workspaceRefs === undefined) return 'unavailable';
    const resolved = resolveWorkspaceRefV1(workspaceRefs, target, context);
    if (resolved.kind === 'ambiguous' || resolved.kind === 'invalid') return 'unavailable';
    return resolved.kind === 'resolved' && projectWorkspaceRefV1(resolved.ref).projectKey === project.projectKey ? 'match' : 'miss';
}

/** Metadata must already be authorized/opened; a locked candidate is never an ordinary Session. */
export function matchSessionBotFilterV1(
    metadata: unknown,
    filter?: SessionBotFilterV1,
): 'match' | 'miss' | 'unavailable' {
    if (filter === undefined) return 'match';
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'unavailable';
    const candidate = (metadata as Readonly<Record<string, unknown>>).bot;
    const marker = readSessionBotV1(candidate);
    if (candidate !== undefined && marker === null) return 'unavailable';
    return (marker !== null) === (filter === 'bot') ? 'match' : 'miss';
}

function normalizeId(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
}

export function normalizeSessionListFilterHomeIds(values: readonly string[] | undefined): string[] {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const raw of values ?? []) {
        const value = normalizeId(raw);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        next.push(value);
    }
    return next;
}

function normalizeAudience(audience: QualifiedAudienceSelection): QualifiedAudienceSelection | null {
    const serverId = normalizeId(audience.serverId);
    if (!serverId) return null;
    if (audience.kind === 'outside_teams') return { serverId, kind: 'outside_teams' };
    const teamId = normalizeId(audience.teamId);
    if (!teamId) return null;
    if (audience.kind === 'team') return { serverId, kind: 'team', teamId };
    const groupId = normalizeId(audience.groupId);
    return groupId ? { serverId, kind: 'group', teamId, groupId } : null;
}

export function buildQualifiedAudienceSelectionKey(audience: QualifiedAudienceSelection): string {
    if (audience.kind === 'outside_teams') return JSON.stringify([normalizeId(audience.serverId), audience.kind]);
    if (audience.kind === 'team') {
        return JSON.stringify([normalizeId(audience.serverId), audience.kind, normalizeId(audience.teamId)]);
    }
    return JSON.stringify([
        normalizeId(audience.serverId), audience.kind, normalizeId(audience.teamId), normalizeId(audience.groupId),
    ]);
}

export function buildQualifiedTagAddressKey(address: QualifiedTagAddress): string {
    return JSON.stringify([normalizeId(address.serverId), normalizeId(address.tagId)]);
}

export function normalizeSessionListFilterAudiences(
    values: readonly QualifiedAudienceSelection[] | undefined,
): QualifiedAudienceSelection[] {
    const seen = new Set<string>();
    const next: QualifiedAudienceSelection[] = [];
    for (const value of values ?? []) {
        const normalized = normalizeAudience(value);
        if (!normalized) continue;
        const key = buildQualifiedAudienceSelectionKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(normalized);
    }
    return next;
}

export function normalizeSessionListFilterTagIds(values: readonly QualifiedTagAddress[] | undefined): QualifiedTagAddress[] {
    const seen = new Set<string>();
    const next: QualifiedTagAddress[] = [];
    for (const value of values ?? []) {
        const serverId = normalizeId(value.serverId);
        const tagId = normalizeId(value.tagId);
        if (!serverId || !tagId) continue;
        const normalized = { serverId, tagId };
        const key = buildQualifiedTagAddressKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(normalized);
    }
    return next;
}

/** Retains the live list's defaults, identity qualification, order and deduplication. */
export function normalizeSessionListFilterV1(input: SessionListFilterDefaultsInputV1 = {}): SessionListFilterV1 {
    return {
        show: input.show ?? 'both',
        startedBy: [...new Set<SessionListFilterV1['startedBy'][number]>(input.startedBy ?? ['you'])],
        scope: input.scope ?? 'my_work',
        attention: input.attention ?? 'any',
        ...(input.bot === undefined ? {} : { bot: input.bot }),
        homeServerIds: normalizeSessionListFilterHomeIds(input.homeServerIds),
        audiences: normalizeSessionListFilterAudiences(input.audiences),
        tagIds: normalizeSessionListFilterTagIds(input.tagIds),
        source: input.source ?? 'all',
    };
}

const SelectionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const QualifiedAudienceSelectionSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionAudienceSelectionV1Schema._zod.def.options[0], { serverId: SelectionIdSchema })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionAudienceSelectionV1Schema._zod.def.options[1], { serverId: SelectionIdSchema })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionAudienceSelectionV1Schema._zod.def.options[2], { serverId: SelectionIdSchema })),
]));

/** V1 selection envelope and nested qualified identities are closed; UI state is never serialized. */
export const SessionListFilterFieldsV1Schema = lazyZodSchema(() => z.strictObject({
    show: SessionListShowV1Schema,
    startedBy: z.array(SessionListStartedByV1Schema),
    scope: SessionListScopeV1Schema,
    attention: SessionAttentionFilterV1Schema,
    bot: z.optional(SessionBotFilterV1Schema),
    homeServerIds: z.array(z.string()),
    audiences: z.array(QualifiedAudienceSelectionSchema),
    tagIds: z.array(z.strictObject({ serverId: SelectionIdSchema, tagId: SelectionIdSchema })),
    source: z.enum(['all', 'persisted', 'direct']),
}));

export const SessionListFilterV1Schema = lazyZodSchema(() => z.pipe(SessionListFilterFieldsV1Schema, z.transform((value): SessionListFilterV1 => normalizeSessionListFilterV1(value))));
