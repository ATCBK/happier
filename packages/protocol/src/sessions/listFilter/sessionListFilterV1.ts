import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { readSessionBotV1 } from '../identity/sessionBotV1.js';
import { deriveSessionCoordinatorV1, type SessionCoordinatorFactsV1 } from '../follow/sessionCoordinatorV1.js';
import { QualifiedProjectKeyV1Schema, type QualifiedProjectKeyV1, type WorkspaceRefV1 } from '../../workspaces/workspaceRefV1.js';
import { SessionAwarenessPresentationStateV1Schema, type SessionAwarenessPresentationStateV1 } from '../awareness/presentationV1.js';
import { projectWorkspaceRefV1, resolveWorkspaceRefV1, type WorkspaceRefResolutionContextV1 } from '../../workspaces/workspaceRefResolutionV1.js';
import type { SessionAwarenessOriginV1 } from '../awareness/projectionV1.js';

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
    coordinator?: 'coordinator';
    projects?: Readonly<{ include: readonly QualifiedProjectKeyV1[]; exclude: readonly QualifiedProjectKeyV1[] }>;
    statuses?: readonly SessionAwarenessPresentationStateV1[];
    underSessionId?: string;
    homeServerIds: readonly string[];
    audiences: readonly QualifiedAudienceSelection[];
    tagIds: readonly QualifiedTagAddress[];
    source: 'all' | 'persisted' | 'direct';
}>;

export type SessionListFilterDefaultsInputV1 = Partial<SessionListFilterV1>;

/**
 * Session identity/relations, Project and status cannot select Runs (a Run's destination is not its owner Session's
 * Project or status); consumers need no Run reader for a known-empty kind.
 */
export function canSessionListFilterIncludeRunsV1(
    filter: Pick<SessionListFilterV1, 'show' | 'bot' | 'coordinator' | 'projects' | 'statuses'>,
): boolean {
    return filter.show !== 'sessions' && filter.bot === undefined && filter.coordinator === undefined
        && !filter.statuses?.length && !filter.projects?.include.length && !filter.projects?.exclude.length;
}

export type SessionListFilterMatchV1 = 'match' | 'miss' | 'unavailable';
export type SessionListStartedByFactV1 = SessionListFilterV1['startedBy'][number] | 'other_account' | 'non_person';

/** Immutable creation provenance and Account identity, never a title, Bot marker or hosting daemon. */
export function readSessionListStartedByV1(input: Readonly<{
    origin?: SessionAwarenessOriginV1;
    ownerAccountId?: string;
    viewerAccountId?: string;
}>): SessionListStartedByFactV1 | undefined {
    if (input.origin && input.origin.kind !== 'none') return 'non_person';
    if (!input.origin || !input.ownerAccountId || !input.viewerAccountId) return undefined;
    return input.ownerAccountId === input.viewerAccountId ? 'you' : 'other_account';
}

/** Facts are authorized by the caller; unknown facts stay absent, never guessed from labels. */
export type SessionListFilterFactsV1 = SessionCoordinatorFactsV1 & Readonly<{
    serverId: string;
    kind: 'session' | 'run';
    startedBy?: SessionListStartedByFactV1;
    attentionRequired?: boolean;
    scopeMatches?: Partial<Readonly<Record<SessionListScopeV1, boolean>>>;
    underSessionMatches?: boolean;
    metadata?: unknown;
    /** When presentation metadata differs, only the opened owner view may establish Project identity. */
    projectMetadata?: unknown;
    status?: SessionAwarenessPresentationStateV1;
    audiences?: readonly SessionAudienceSelectionV1[];
    tagIds?: readonly string[];
    source?: 'persisted' | 'direct';
    workspaceRefs?: readonly WorkspaceRefV1[];
    workspaceContext?: WorkspaceRefResolutionContextV1;
}>;

/** Shared by lists, Boards, rule previews and occurrence matching. No fact lookup or graph traversal. */
export function matchSessionListFilterV1(filter: SessionListFilterV1, facts: SessionListFilterFactsV1): SessionListFilterMatchV1 {
    if (facts.kind === 'run' && !canSessionListFilterIncludeRunsV1(filter)) return 'miss';
    const normalizeHome = facts.workspaceContext?.normalizeServerId ?? ((value: string) => value.trim());
    const sameHome = (value: string) => normalizeHome(value) === normalizeHome(facts.serverId);
    const results: SessionListFilterMatchV1[] = [];
    const known = (value: boolean | undefined): SessionListFilterMatchV1 => value === undefined ? 'unavailable' : value ? 'match' : 'miss';
    results.push(known(filter.homeServerIds.some(sameHome)));
    results.push(known(filter.show === 'both' || (filter.show === 'runs') === (facts.kind === 'run')));
    results.push(filter.startedBy.length === 0 ? 'miss'
        : ['you', 'agents', 'triggers'].every(value => filter.startedBy.some(selected => selected === value)) ? 'match'
        : facts.startedBy === undefined ? 'unavailable'
        : facts.startedBy === 'non_person' ? filter.startedBy.some(value => value !== 'you') ? 'unavailable' : 'miss'
        : known(facts.startedBy !== 'other_account' && filter.startedBy.includes(facts.startedBy)));
    if (filter.scope !== 'all_accessible') results.push(known(facts.scopeMatches?.[filter.scope]));
    if (filter.underSessionId !== undefined) results.push(known(facts.underSessionMatches));
    if (filter.attention !== 'any') results.push(known(facts.attentionRequired));
    if (filter.source !== 'all') results.push(facts.source === undefined ? 'unavailable' : known(filter.source === facts.source));
    if (filter.bot !== undefined) results.push(matchSessionBotFilterV1(facts.metadata, filter.bot));
    if (filter.coordinator !== undefined) results.push(known(deriveSessionCoordinatorV1(facts)));
    if (filter.statuses?.length) results.push(facts.status === undefined ? 'unavailable' : known(filter.statuses.includes(facts.status)));
    if (filter.audiences.length) results.push(facts.audiences === undefined ? 'unavailable' : known(filter.audiences.some(selection => sameHome(selection.serverId) && facts.audiences!.some(audience => {
        if (selection.kind === 'outside_teams') return audience.kind === 'outside_teams';
        if (audience.kind === 'outside_teams' || audience.teamId !== selection.teamId) return false;
        return selection.kind === 'team' || audience.kind === 'group' && audience.groupId === selection.groupId;
    }))));
    if (filter.tagIds.length) results.push(facts.tagIds === undefined ? 'unavailable' : known(filter.tagIds.some(tag => sameHome(tag.serverId) && facts.tagIds!.includes(tag.tagId))));
    if (filter.projects) {
        const matches = (project: QualifiedProjectKeyV1) => matchSessionProjectFilterV1(Object.hasOwn(facts, 'projectMetadata') ? facts.projectMetadata : facts.metadata, facts.serverId, project, facts.workspaceRefs, facts.workspaceContext);
        const included = filter.projects.include.map(matches);
        if (included.length) results.push(included.includes('match') ? 'match' : included.includes('unavailable') ? 'unavailable' : 'miss');
        const excluded = filter.projects.exclude.map(matches);
        if (excluded.length) results.push(excluded.includes('match') ? 'miss' : excluded.includes('unavailable') ? 'unavailable' : 'match');
    }
    return results.includes('miss') ? 'miss' : results.includes('unavailable') ? 'unavailable' : 'match';
}

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
        : typeof record.machineId === 'string' && typeof record.path === 'string' && record.path.trim().length > 0
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

function normalizeProjects(values: readonly QualifiedProjectKeyV1[]): QualifiedProjectKeyV1[] {
    const seen = new Set<string>();
    return values.flatMap(value => {
        const serverId = normalizeId(value.serverId);
        const projectKey = normalizeId(value.projectKey);
        const key = JSON.stringify([serverId, projectKey]);
        if (!serverId || !projectKey || seen.has(key)) return [];
        seen.add(key);
        return [{ serverId, projectKey }];
    });
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
        ...(input.coordinator === undefined ? {} : { coordinator: input.coordinator }),
        ...(input.projects === undefined ? {} : { projects: { include: normalizeProjects(input.projects.include), exclude: normalizeProjects(input.projects.exclude) } }),
        ...(input.statuses === undefined ? {} : { statuses: [...new Set(input.statuses)] }),
        ...(normalizeId(input.underSessionId) ? { underSessionId: normalizeId(input.underSessionId) } : {}),
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
    coordinator: z.optional(z.literal('coordinator')),
    projects: z.optional(z.strictObject({ include: z.array(QualifiedProjectKeyV1Schema), exclude: z.array(QualifiedProjectKeyV1Schema) })),
    statuses: z.optional(z.array(SessionAwarenessPresentationStateV1Schema)),
    underSessionId: z.optional(SelectionIdSchema),
    homeServerIds: z.array(z.string()),
    audiences: z.array(QualifiedAudienceSelectionSchema),
    tagIds: z.array(z.strictObject({ serverId: SelectionIdSchema, tagId: SelectionIdSchema })),
    source: z.enum(['all', 'persisted', 'direct']),
}));

export const SessionListFilterV1Schema: z.ZodMiniType<SessionListFilterV1, SessionListFilterV1> = lazyZodSchema(
    () => z.pipe(SessionListFilterFieldsV1Schema, z.transform((value): SessionListFilterV1 => normalizeSessionListFilterV1(value))),
);
