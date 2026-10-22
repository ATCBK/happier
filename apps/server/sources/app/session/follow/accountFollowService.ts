import { AccountSessionFollowV1Schema, OtherAccountFollowV1Schema, EXPLICIT_SESSION_UNFOLLOW_STATE_V1, projectSessionFollowFactsV1, normalizeAccountFollowNotificationChoiceV1, projectAccountFollowNotificationLevelV1, SessionAutoFollowPreferencesV1Schema, type AccountFollowRelationV1, type AccountSessionFollowV1, type OtherAccountFollowV1, type SessionAutoFollowPreferencesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { SetSessionFollowRequestSchema, ReplaceSessionVoiceInclusionsRequestSchema, type SetSessionFollowRequest, type GetSessionFollowResponse } from '@happier-dev/protocol/sessions/follow/api';
import { compareSessionFollowFrontierProgressV1, encodePersistedSessionFollowFrontierV1, isSessionFollowConsumptionWithinCurrentV1, isSessionFollowFrontierEqualV1, isSessionFollowTurnEqualV1, parsePersistedSessionFollowFrontierV1, projectSessionFollowFrontierFromSourceV1, type SessionFollowFrontierV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';
import { pageFollowListV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowListV1';
import { VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@happier-dev/protocol/sessions/control/contract';

import { resolveEffectiveSessionAccess, resolveStructuralSessionAccessForAccountsInTx } from "@/app/session/access/sessionAccess";
import { backgroundDeliveryAuthentication, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import {
    beginViewerReadTrackingOnFollowEntryInTx,
    isSessionPersonallyTrackedInTx,
} from "@/app/session/personal/readState";
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { readSnapshotWithCurrentAdmission } from "@/storage/readSnapshotWithCurrentAdmission";
import { markSessionFollowsChangedForAccountsInTx, markSessionFollowsChangedInTx } from "./changes";
import { hasCanonicalFollowProviderInputAcceptanceInTx } from "./providerInputAcceptance";
import { acquireAccountChangePublicationLocksInTx } from "@/app/changes/markAccountChanged";
import { matchesPersonalFollowOnceOccurrenceV1, parsePersistedPersonalFollowOnceV1, projectPersonalFollowCustodyV1, resolveAccountFollowVoiceSelectionV1, type PersonalFollowOnceOccurrenceV1, type PersistedPersonalFollowOnceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { FollowPolicyV1Schema, isFollowPolicyEqualV1, serializeFollowPolicyV1, resolveFollowDeliveryV1, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { deriveSessionFollowOriginalOccurrenceKeyV1, resolveExecutionRunFollowOccurrenceV1, type RunFollowOriginalV1, type SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { sourceForSessionFollowEdgeV1, sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';
import { canReadFollowSourceInTx } from './followSourceAdmission';
import { resolveDiscussionAudienceInTx } from '@/app/discussions/access';
import { resolveWorkflowRunRecipientAccountIdsInTx } from '@/app/workflows/workflowRunAccess';
import { isExecutionRunFollowFrontierWitnessCurrentInTx, type ExecutionRunFollowFrontierWitness } from './executionRunFollowSource';
import { editFollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';
import { isDeliveryMutedInTx, readDeliveryMuteScopesInTx } from './sessionDeliveryMuteService';
import { isFollowDeliveryMutedV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { readAccountFollowCreationPreferencesInTx, updateAccountFollowCreationPreferencesInTx } from './accountFollowCreationPreferences';

export type CurrentAccountVoiceExecutionRunAuthority = Readonly<{
    executionRunId: string;
    occurrenceId: string;
    parentSessionId: string;
    intent: 'voice_agent';
    runtimeState: 'active_turn' | 'idle';
}>;

async function hasCurrentPrivateAccountVoicePublisherInTx(tx: Tx, input: Readonly<{
    accountId: string;
    voiceSessionId: string;
    runtimeAuthority?: CurrentAccountVoiceExecutionRunAuthority;
}>): Promise<boolean> {
    const authority = input.runtimeAuthority;
    if (!authority
        || !authority.executionRunId.trim()
        || !authority.occurrenceId.trim()
        || authority.intent !== 'voice_agent'
        || authority.parentSessionId !== input.voiceSessionId) return false;
    const voiceSession = await tx.session.findUnique({
        where: { id: input.voiceSessionId },
        select: {
            accountId: true,
            archivedAt: true,
            tag: true,
            shares: { select: { id: true }, take: 1 },
            teamGrants: { select: { sessionId: true }, take: 1 },
            groupGrants: { select: { sessionId: true }, take: 1 },
            publicShare: { select: { sessionId: true } },
        },
    });
    return voiceSession?.accountId === input.accountId
        && voiceSession.archivedAt === null
        && voiceSession.tag === VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG
        && voiceSession.shares.length === 0
        && voiceSession.teamGrants.length === 0
        && voiceSession.groupGrants.length === 0
        && voiceSession.publicShare === null;
}

export type AccountFollowFailure = "invalid_parameters" | "account_inactive" | "session_not_found" | "session_archived"
    | "source_not_found" | "source_unavailable";
export type AccountFollowResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: AccountFollowFailure }>;
const FOLLOW_SELECT = {
    sessionId: true,
    sourceKey: true,
    sourceDiscussionId: true,
    sourceExecutionRunSessionId: true,
    sourceExecutionRunId: true,
    sourceWorkflowRunId: true,
    following: true,
    includeInVoice: true,
    voiceDeliveredFrontier: true,
    followPolicy: true,
    notifyOnce: true,
    hasPersistentFollow: true,
} as const;
const ACCOUNT_SELECT = {
    status: true,
    sessionAutoFollowAssigned: true,
    sessionAutoFollowDirect: true,
    sessionAutoFollowTeam: true,
    sessionAutoFollowGroup: true,
} as const;
type AccountPreferencesRow = Readonly<{
    sessionAutoFollowAssigned: boolean;
    sessionAutoFollowDirect: boolean;
    sessionAutoFollowTeam: boolean;
    sessionAutoFollowGroup: boolean;
}>;
function projectPreferences(row: AccountPreferencesRow): SessionAutoFollowPreferencesV1 {
    return {
        assigned: row.sessionAutoFollowAssigned, direct: row.sessionAutoFollowDirect,
        team: row.sessionAutoFollowTeam, group: row.sessionAutoFollowGroup,
    };
}
export function resolveAccountVoiceSelection(row: Readonly<{ includeInVoice: boolean; followPolicy?: string | null }>): Readonly<{ policy?: FollowPolicyV1 }> | null {
    return resolveAccountFollowVoiceSelectionV1({ includeInVoice: row.includeInVoice, ...projectPersonalFollowCustodyV1(row) });
}

function isVoiceInitialSnapshotPending(row: Readonly<{
    following: boolean;
    includeInVoice: boolean;
    followPolicy?: string | null;
    notifyOnce?: string | null;
    hasPersistentFollow?: boolean;
    voiceDeliveredFrontier: string | null;
}> | null): boolean {
    return row?.following === true && resolveAccountVoiceSelection(row) !== null && row.voiceDeliveredFrontier === null;
}

/** Private Voice custody is selected for pending-state calculation, never exposed as an editable preference. */
function projectAccountSessionFollow(row: Readonly<{
    sessionId: string | null;
    following: boolean;
    includeInVoice: boolean;
    followPolicy?: string | null;
    notifyOnce?: string | null;
    hasPersistentFollow?: boolean;
}>): AccountSessionFollowV1 {
    if (!row.sessionId) throw new Error('Session Follow projection lost its Session source');
    const custody = projectPersonalFollowCustodyV1(row);
    return AccountSessionFollowV1Schema.parse({
        sessionId: row.sessionId,
        following: row.following,
        notificationLevel: row.following ? projectAccountFollowNotificationLevelV1(custody.policy) : 'none',
        includeInVoice: row.following && resolveAccountFollowVoiceSelectionV1({ includeInVoice: row.includeInVoice, ...custody }) !== null,
        ...(row.hasPersistentFollow === false ? { persistent: false } : {}),
        ...custody,
    });
}

type OtherAccountSource = Extract<FollowSourceRefV1, { kind: 'discussion' | 'execution_run' | 'workflow_run' }>;
function sourceFromAccountFollow(row: Readonly<{
    sourceKey: string | null; sessionId: string | null;
    sourceDiscussionId: string | null;
    sourceExecutionRunSessionId: string | null; sourceExecutionRunId: string | null; sourceWorkflowRunId: string | null;
}>): OtherAccountSource | null {
    if (!row.sourceKey || row.sessionId !== null) return null;
    const source = sourceForSessionFollowEdgeV1({ ...row, sourceKey: row.sourceKey, sourceSessionId: row.sessionId });
    if (!source || source.kind === 'session') return null;
    if (source.kind === 'discussion' && source.discussionId !== row.sourceDiscussionId) return null;
    if (source.kind !== 'discussion' && row.sourceDiscussionId !== null) return null;
    return source;
}
function projectOtherAccountFollow(row: Readonly<{
    sourceKey: string | null; sessionId: string | null; sourceDiscussionId: string | null;
    sourceExecutionRunSessionId: string | null; sourceExecutionRunId: string | null; sourceWorkflowRunId: string | null;
    following: boolean; hasPersistentFollow: boolean; followPolicy: string | null;
}>): OtherAccountFollowV1 | null {
    const source = sourceFromAccountFollow(row);
    if (!source || !row.followPolicy) return null;
    let value: unknown;
    try { value = JSON.parse(row.followPolicy); } catch { return null; }
    const policy = FollowPolicyV1Schema.safeParse(value);
    return policy.success ? OtherAccountFollowV1Schema.parse({ source, following: row.following,
        persistent: row.hasPersistentFollow, policy: policy.data }) : null;
}

/** One private explicit-Follow read for non-Session source adapters. */
export async function readAccountOtherFollowInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication; source: OtherAccountSource;
}>) {
    const source = input.source;
    if (!await activeAccount(tx, input.accountId) || !await canReadFollowSourceInTx(tx, { ...input, source })) return null;
    const sourceKey = sourceKeyForSessionFollowSourceV1(source);
    const row = await tx.accountSessionFollow.findUnique({ where: { accountId_sourceKey: { accountId: input.accountId, sourceKey } },
        select: { ...FOLLOW_SELECT, deliveredDiscussionSeq: true, deliveredExecutionRunTerminalEventId: true,
            deliveredExecutionRunPermissionKey: true, deliveredWorkflowRunRevision: true } });
    if (!row || !row.following || JSON.stringify(sourceFromAccountFollow(row)) !== JSON.stringify(source)) return null;
    const follow = projectOtherAccountFollow(row);
    return follow ? { ...row, sourceKey, policy: follow.policy } : null;
}

/** Own-Account Run delivery uses the same explicit Follow, source admission and mute owners. */
export async function readAccountRunFollowDeliveryInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication; original: RunFollowOriginalV1;
    event: Extract<SessionFollowInputV1, { original: RunFollowOriginalV1 }>['event'];
}>) {
    const source = input.original.source;
    const row = await readAccountOtherFollowInTx(tx, { ...input, source });
    if (!row || !resolveFollowDeliveryV1({ policies: [row.policy], event: input.event }).selected
        || await isDeliveryMutedInTx(tx, { accountId: input.accountId, receiver: { kind: 'account' },
            candidate: { source, ...(source.kind === 'execution_run' ? { senderSessionId: source.sessionId } : {}) } }) !== false) return null;
    const represented = 'terminalEventId' in input.original
        ? row.deliveredExecutionRunTerminalEventId === input.original.terminalEventId
        : 'permissionRequests' in input.original
        ? row.deliveredExecutionRunPermissionKey === deriveSessionFollowOriginalOccurrenceKeyV1(input.original)
        : (row.deliveredWorkflowRunRevision ?? 0) >= input.original.revision;
    return { sourceKey: row.sourceKey, policy: row.policy, represented,
        deliveredExecutionRunTerminalEventId: row.deliveredExecutionRunTerminalEventId,
        deliveredExecutionRunPermissionKey: row.deliveredExecutionRunPermissionKey,
        deliveredWorkflowRunRevision: row.deliveredWorkflowRunRevision };
}
async function activeAccount(tx: Tx, accountId: string) {
    const account = await tx.account.findUnique({ where: { id: accountId }, select: ACCOUNT_SELECT });
    return account && isActiveHomeAccountStatus(account.status) ? account : null;
}
async function readableSession(tx: Tx, input: Readonly<{ accountId: string; sessionId: string; authentication: SessionAccessAuthentication }>) {
    if ((await resolveEffectiveSessionAccess(tx, input))?.capabilities.readTranscript !== true) return null;
    return await tx.session.findUnique({ where: { id: input.sessionId }, select: { accountId: true, archivedAt: true } });
}

/** Source inspection discloses current members anonymously, plus the caller's own membership only. */
export async function readSessionPersonalFollowerCensusInTx(tx: Tx, input: Readonly<{ accountId: string; sessionId: string }>): Promise<{
    peopleCount: number; follows: AccountSessionFollowV1[];
}> {
    const rows = await tx.accountSessionFollow.findMany({ where: { sessionId: input.sessionId }, select: { ...FOLLOW_SELECT, accountId: true } });
    const candidates = rows.filter(row => {
        const facts = projectSessionFollowFactsV1(row);
        return facts.follows || Boolean(facts.once);
    });
    const access = await resolveStructuralSessionAccessForAccountsInTx(tx, { sessionId: input.sessionId,
        accountIds: candidates.map(row => row.accountId) });
    const members = candidates.filter(row => access.get(row.accountId)?.capabilities.readTranscript === true);
    const own = members.find(row => row.accountId === input.accountId);
    return { peopleCount: members.length, follows: own ? [projectAccountSessionFollow(own)] : [] };
}

/** Reverse generic inspection counts only current source recipients, never reveals their identities. */
export async function readOtherPersonalFollowerCensusInTx(tx: Tx, input: Readonly<{
    accountId: string; source: OtherAccountSource;
}>): Promise<Readonly<{ peopleCount: number; follows: OtherAccountFollowV1[] }>> {
    const rows = await tx.accountSessionFollow.findMany({ where: {
        sourceKey: sourceKeyForSessionFollowSourceV1(input.source), following: true,
    }, select: { ...FOLLOW_SELECT, accountId: true } });
    const candidates = rows.flatMap(row => {
        if (JSON.stringify(sourceFromAccountFollow(row)) !== JSON.stringify(input.source))
            throw new Error('Account Follow Run source digest collision');
        const follow = projectOtherAccountFollow(row);
        return follow ? [{ accountId: row.accountId, follow }] : [];
    });
    let audience: ReadonlySet<string>;
    if (input.source.kind === 'discussion') {
        audience = new Set(await resolveDiscussionAudienceInTx(tx, input.source.discussionId));
    } else if (input.source.kind === 'workflow_run') {
        audience = new Set(await resolveWorkflowRunRecipientAccountIdsInTx(tx, input.source.runId));
    } else {
        const access = await resolveStructuralSessionAccessForAccountsInTx(tx, {
            sessionId: input.source.sessionId, accountIds: candidates.map(row => row.accountId),
        });
        audience = new Set(candidates.filter(row => access.get(row.accountId)?.capabilities.readTranscript === true)
            .map(row => row.accountId));
    }
    const members = candidates.filter(row => audience.has(row.accountId));
    return { peopleCount: members.length,
        follows: members.filter(row => row.accountId === input.accountId).map(row => row.follow) };
}

/** Lists the caller's explicit active choices, filtering sources through current read admission. */
export async function listAccountSessionFollows(input: Readonly<{ accountId: string; authentication: SessionAccessAuthentication; cursor?: string; limit?: number }>): Promise<AccountFollowResult<{ follows: AccountFollowRelationV1[]; continuation?: string }>> {
    return readSnapshotWithCurrentAdmission<AccountFollowResult<{ follows: AccountFollowRelationV1[]; continuation?: string }>>(async tx => {
        if (!await activeAccount(tx, input.accountId)) return { ok: false as const, error: 'account_inactive' as const };
        const rows = await tx.accountSessionFollow.findMany({ where: { accountId: input.accountId, following: true }, select: FOLLOW_SELECT,
            orderBy: [{ sourceKey: 'asc' }, { sessionId: 'asc' }] });
        const follows: AccountFollowRelationV1[] = [];
        for (const row of rows) {
            if (row.sessionId) {
                if (await readableSession(tx, { ...input, sessionId: row.sessionId })) follows.push(projectAccountSessionFollow(row));
            } else {
                const source = sourceFromAccountFollow(row);
                if (!source || !await canReadFollowSourceInTx(tx, { ...input, source })) continue;
                const projected = projectOtherAccountFollow(row);
                if (projected) follows.push(projected);
            }
        }
        return { ok: true as const, value: { follows } };
    }, async (tx, captured) => {
        if (!captured.ok) return captured;
        if (!await activeAccount(tx, input.accountId)) return { ok: false as const, error: 'account_inactive' as const };
        const follows: AccountFollowRelationV1[] = [];
        for (const row of captured.value.follows) {
            if ('sessionId' in row) {
                if (await readableSession(tx, { ...input, sessionId: row.sessionId })) follows.push(row);
            } else if (row.source.kind !== 'rule' && await canReadFollowSourceInTx(tx, { ...input, source: row.source })) follows.push(row);
        }
        try {
            const page = pageFollowListV1({ scope: JSON.stringify([input.accountId, 'following']), rows: follows,
                key: row => 'sessionId' in row
                    ? sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: row.sessionId })
                    : sourceKeyForSessionFollowSourceV1(row.source as OtherAccountSource),
                cursor: input.cursor, limit: input.limit });
            return { ok: true as const, value: { follows: page.rows, ...(page.continuation ? { continuation: page.continuation } : {}) } };
        } catch {
            return { ok: false as const, error: 'invalid_parameters' as const };
        }
    });
}

/** Exact non-Session personal choice; source grant is read from its current owner. */
export async function getOtherAccountFollow(input: Readonly<{
    accountId: string; source: OtherAccountSource; authentication: SessionAccessAuthentication;
}>): Promise<AccountFollowResult<Readonly<{ follow: OtherAccountFollowV1 | null }>>> {
    return readSnapshotWithCurrentAdmission(async tx => {
        if (!await activeAccount(tx, input.accountId)) return { ok: false as const, error: 'account_inactive' as const };
        if (!await canReadFollowSourceInTx(tx, input)) return { ok: false as const, error: 'source_not_found' as const };
        const row = await tx.accountSessionFollow.findUnique({ where: { accountId_sourceKey: {
            accountId: input.accountId, sourceKey: sourceKeyForSessionFollowSourceV1(input.source),
        } }, select: FOLLOW_SELECT });
        if (row && JSON.stringify(sourceFromAccountFollow(row)) !== JSON.stringify(input.source))
            throw new Error('Account Follow Run source digest collision');
        return { ok: true as const, value: { follow: row ? projectOtherAccountFollow(row) : null } };
    }, async (tx, captured) => {
        if (!captured.ok) return captured;
        if (!await activeAccount(tx, input.accountId)) return { ok: false as const, error: 'account_inactive' as const };
        return await canReadFollowSourceInTx(tx, input) ? captured : { ok: false as const, error: 'source_not_found' as const };
    });
}

/** Personal policy uses this AccountSessionFollow row, including suppression and source baselines. */
export async function setOtherAccountFollow(input: Readonly<{
    accountId: string; source: OtherAccountSource; policy: FollowPolicyV1;
    authentication: SessionAccessAuthentication;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
}>): Promise<AccountFollowResult<Readonly<{ changed: boolean; follow: OtherAccountFollowV1 }>>> {
    const parsed = FollowPolicyV1Schema.safeParse(input.policy);
    if (!parsed.success) return { ok: false, error: 'invalid_parameters' };
    return inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: 'account_inactive' };
        if (!await canReadFollowSourceInTx(tx, input)) return { ok: false, error: 'source_not_found' };
        if (input.source.kind === 'discussion') {
            const discussion = await tx.discussion.findUnique({ where: { id: input.source.discussionId }, select: { archivedAt: true } });
            if (!discussion) return { ok: false, error: 'source_not_found' };
            if (discussion.archivedAt !== null) return { ok: false, error: 'session_archived' };
        }
        if (input.source.kind === 'execution_run') {
            const session = await tx.session.findUnique({ where: { id: input.source.sessionId }, select: { archivedAt: true } });
            if (!session) return { ok: false, error: 'source_not_found' };
            if (session.archivedAt !== null) return { ok: false, error: 'session_archived' };
        }
        const sourceKey = sourceKeyForSessionFollowSourceV1(input.source);
        const key = { accountId: input.accountId, sourceKey };
        const existing = await tx.accountSessionFollow.findUnique({ where: { accountId_sourceKey: key }, select: FOLLOW_SELECT });
        if (existing && JSON.stringify(sourceFromAccountFollow(existing)) !== JSON.stringify(input.source))
            throw new Error('Account Follow Run source digest collision');
        const reseed = !existing || !existing.following;
        if (reseed && input.source.kind === 'execution_run') {
            const frontier = input.executionRunFrontier;
            if (!frontier || JSON.stringify(frontier.source) !== JSON.stringify(input.source)
                || !await isExecutionRunFollowFrontierWitnessCurrentInTx(tx, frontier))
                return { ok: false, error: 'source_unavailable' };
        }
        const policy = parsed.data;
        const followPolicy = serializeFollowPolicyV1(policy);
        if (existing && existing.following && existing.hasPersistentFollow && existing.followPolicy !== null
            && isFollowPolicyEqualV1(projectOtherAccountFollow(existing)?.policy ?? { preset: 'quiet' }, policy)) {
            const follow = projectOtherAccountFollow(existing);
            if (!follow) return { ok: false, error: 'source_unavailable' };
            return { ok: true, value: { changed: false, follow } };
        }
        const raw = input.source.kind === 'discussion' ? { sourceDiscussionId: input.source.discussionId }
            : input.source.kind === 'workflow_run' ? { sourceWorkflowRunId: input.source.runId }
            : { sourceExecutionRunSessionId: input.source.sessionId, sourceExecutionRunId: input.source.runId };
        const runFrontier = input.source.kind === 'execution_run' ? input.executionRunFrontier : undefined;
        const runOccurrence = runFrontier ? resolveExecutionRunFollowOccurrenceV1({ ...runFrontier,
            sessionId: runFrontier.source.sessionId, runId: runFrontier.source.runId }) : null;
        const baseline = input.source.kind === 'discussion'
            ? { deliveredDiscussionSeq: (await tx.discussion.findUniqueOrThrow({ where: { id: input.source.discussionId },
                select: { messageSeq: true } })).messageSeq }
            : input.source.kind === 'workflow_run'
                ? { deliveredWorkflowRunRevision: (await tx.automationRun.findUniqueOrThrow({ where: { id: input.source.runId },
                    select: { revision: true } })).revision }
                : { deliveredExecutionRunTerminalEventId: input.executionRunFrontier?.terminalEventId ?? null,
                    deliveredExecutionRunPermissionKey: runOccurrence && 'permissionRequests' in runOccurrence.original
                        ? deriveSessionFollowOriginalOccurrenceKeyV1(runOccurrence.original) : null };
        const row = await tx.accountSessionFollow.upsert({ where: { accountId_sourceKey: key },
            create: { accountId: input.accountId, sourceKey, ...raw, ...baseline,
                following: true, hasPersistentFollow: true,
                includeInVoice: false, followPolicy },
            update: { following: true, hasPersistentFollow: true,
                includeInVoice: false, followPolicy, ...(reseed ? baseline : {}) },
            select: FOLLOW_SELECT });
        if (JSON.stringify(sourceFromAccountFollow(row)) !== JSON.stringify(input.source))
            throw new Error('Account Follow Run source digest collision');
        const follow = projectOtherAccountFollow(row);
        if (!follow) throw new Error('Account Follow source update lost exact identity');
        await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: { changed: true, follow } };
    });
}

/** Explicit generic Unfollow suppresses future effects without requiring a now-lost source grant. */
export async function removeOtherAccountFollow(input: Readonly<{
    accountId: string; source: OtherAccountSource; authentication: SessionAccessAuthentication;
}>): Promise<AccountFollowResult<Readonly<{ changed: boolean }>>> {
    return inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: 'account_inactive' };
        const key = { accountId: input.accountId, sourceKey: sourceKeyForSessionFollowSourceV1(input.source) };
        const existing = await tx.accountSessionFollow.findUnique({ where: { accountId_sourceKey: key }, select: FOLLOW_SELECT });
        if (existing && JSON.stringify(sourceFromAccountFollow(existing)) !== JSON.stringify(input.source))
            throw new Error('Account Follow Run source digest collision');
        if (!existing && !await canReadFollowSourceInTx(tx, input)) return { ok: false, error: 'source_not_found' };
        if (existing?.following === false && existing.hasPersistentFollow) return { ok: true, value: { changed: false } };
        const raw = input.source.kind === 'discussion' ? { sourceDiscussionId: input.source.discussionId }
            : input.source.kind === 'workflow_run' ? { sourceWorkflowRunId: input.source.runId }
            : { sourceExecutionRunSessionId: input.source.sessionId, sourceExecutionRunId: input.source.runId };
        await tx.accountSessionFollow.upsert({ where: { accountId_sourceKey: key },
            create: { ...key, ...raw, following: false, hasPersistentFollow: true,
                includeInVoice: false, followPolicy: serializeFollowPolicyV1({ preset: 'quiet' }) },
            update: { following: false, hasPersistentFollow: true,
                includeInVoice: false, followPolicy: serializeFollowPolicyV1({ preset: 'quiet' }) } });
        await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: { changed: true } };
    });
}

/** Reads only the authenticated Account's personal choice after current Session read admission. */
export async function getAccountSessionFollow(input: Readonly<{ accountId: string; sessionId: string; authentication: SessionAccessAuthentication }>): Promise<AccountFollowResult<GetSessionFollowResponse>> {
    return await readSnapshotWithCurrentAdmission<AccountFollowResult<GetSessionFollowResponse>>(async tx => {
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const session = await readableSession(tx, input);
        if (!session) return { ok: false, error: "session_not_found" };
        const key = { accountId: input.accountId, sessionId: input.sessionId };
        const row = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: key }, select: FOLLOW_SELECT });
        return { ok: true, value: {
            follow: row ? projectAccountSessionFollow(row) : null,
            isSessionOwner: session.accountId === input.accountId,
            capabilities: { manageFollow: true },
            voiceInitialSnapshotPending: isVoiceInitialSnapshotPending(row),
        } };
    }, async (tx, captured) => {
        if (!captured.ok) return captured;
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        return await readableSession(tx, input) ? captured : { ok: false, error: "session_not_found" };
    });
}

/** Replaces a personal Follow choice and seeds newly entered tracking through its canonical owner. */
export async function setAccountSessionFollow(input: Readonly<{
    accountId: string; sessionId: string; preferences: SetSessionFollowRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<AccountFollowResult<Readonly<{
    changed: boolean;
    follow: AccountSessionFollowV1;
    voiceInitialSnapshotPending: boolean;
}>>> {
    const parsed = SetSessionFollowRequestSchema.safeParse(input.preferences);
    if (!parsed.success) return { ok: false, error: "invalid_parameters" };
    const preferences = parsed.data;
    return await inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const session = await readableSession(tx, input);
        if (!session) return { ok: false, error: "session_not_found" };
        if (session.archivedAt !== null) return { ok: false, error: "session_archived" };
        const key = { accountId: input.accountId, sessionId: input.sessionId };
        const existing = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: key }, select: FOLLOW_SELECT });
        const persistentMutation = preferences.policy !== undefined || preferences.notificationLevel !== undefined;
        // Scalar edits are ingress only; persistence has one policy authority.
        const policyWrite = preferences.policy !== undefined ? { followPolicy: JSON.stringify(preferences.policy) }
            : preferences.notificationLevel !== undefined ? { followPolicy: serializeFollowPolicyV1(normalizeAccountFollowNotificationChoiceV1({
                notificationLevel: preferences.notificationLevel, includeInVoice: preferences.includeInVoice === true,
            })) } : {};
        let notifyOnce = existing?.notifyOnce ?? null;
        if (preferences.once !== undefined) {
            if (preferences.once === null) notifyOnce = null;
            else {
                const source = await tx.session.findUniqueOrThrow({ where: { id: input.sessionId }, select: {
                    seq: true, latestReadyEventSeq: true, agentStateVersion: true, latestTurnId: true, latestTurnStatus: true,
                } });
                if (preferences.once.kind === 'turn_finished'
                    && (source.latestTurnId !== preferences.once.sourceTurnId || source.latestTurnStatus !== 'in_progress')) {
                    return { ok: false, error: 'invalid_parameters' };
                }
                const armed: PersistedPersonalFollowOnceV1 = { v: 1, state: 'armed', once: preferences.once,
                    baseline: projectSessionFollowFrontierFromSourceV1(source) };
                // Retrying an unchanged intent does not move its needs-you baseline.
                const previous = parsePersistedPersonalFollowOnceV1(existing?.notifyOnce);
                notifyOnce = previous?.state === 'armed' && JSON.stringify(previous.once) === JSON.stringify(preferences.once)
                    ? existing!.notifyOnce : JSON.stringify(armed);
            }
        }
        const includeInVoice = persistentMutation ? false : existing?.includeInVoice ?? false;
        const following = persistentMutation ? true : existing?.following ?? false;
        const hasPersistentFollow = persistentMutation || existing?.hasPersistentFollow === true;
        const followPolicy = 'followPolicy' in policyWrite ? policyWrite.followPolicy : existing?.followPolicy ?? null;
        if (existing && existing.following === following
            && existing.includeInVoice === includeInVoice && existing.followPolicy === followPolicy && existing.notifyOnce === notifyOnce
            && existing.hasPersistentFollow === hasPersistentFollow) {
            return { ok: true, value: {
                changed: false,
                follow: projectAccountSessionFollow(existing),
                voiceInitialSnapshotPending: isVoiceInitialSnapshotPending(existing),
            } };
        }
        const wasTracked = await isSessionPersonallyTrackedInTx(tx, { ...key, ownerAccountId: session.accountId });
        const voiceSelected = resolveAccountVoiceSelection({ includeInVoice, followPolicy }) !== null;
        const previouslySelected = existing !== null && resolveAccountVoiceSelection(existing) !== null;
        const row = await tx.accountSessionFollow.upsert({
            where: { accountId_sessionId: key },
            create: { ...key, following, hasPersistentFollow, includeInVoice, followPolicy, notifyOnce, voiceDeliveredFrontier: null },
            update: { following, hasPersistentFollow, includeInVoice, followPolicy, notifyOnce,
                ...(!voiceSelected || !previouslySelected
                    ? { voiceDeliveredFrontier: null } : {}) },
            select: FOLLOW_SELECT,
        });
        if (persistentMutation) await beginViewerReadTrackingOnFollowEntryInTx({ tx, ...key, wasTracked, authentication: input.authentication });
        await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: {
            changed: true,
            follow: projectAccountSessionFollow(row),
            voiceInitialSnapshotPending: isVoiceInitialSnapshotPending(row),
        } };
    });
}

/** Explicit Unfollow persists suppression, including after visibility loss, without disclosing a Session. */
export async function removeAccountSessionFollow(input: Readonly<{ accountId: string; sessionId: string; authentication: SessionAccessAuthentication }>): Promise<AccountFollowResult<Readonly<{ changed: boolean }>>> {
    return await inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const key = { accountId: input.accountId, sessionId: input.sessionId };
        const existing = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: key }, select: FOLLOW_SELECT });
        if (!existing && !await readableSession(tx, input)) return { ok: false, error: "session_not_found" };
        if (existing && existing.hasPersistentFollow && !existing.following && existing.notifyOnce === null) return { ok: true, value: { changed: false } };
        const { notificationLevel: _notificationLevel, ...unfollowState } = EXPLICIT_SESSION_UNFOLLOW_STATE_V1;
        const suppressed = { ...unfollowState, hasPersistentFollow: true, followPolicy: null, notifyOnce: null, voiceDeliveredFrontier: null };
        await tx.accountSessionFollow.upsert({ where: { accountId_sessionId: key }, create: { ...key, ...suppressed }, update: suppressed });
        await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: { changed: true } };
    });
}

/**
 * Settles an accepted personal effect against the exact armed intent. The
 * fulfilled source reference keeps that one Inbox item available without
 * changing persistent interest, suppression, Voice or private read state.
 */
export async function consumeAccountSessionFollowOnceInTx(tx: Tx, input: Readonly<{
    accountId: string;
    sessionId: string;
    expectedOnce: string;
    accepted: boolean;
    occurrence: PersonalFollowOnceOccurrenceV1;
}>): Promise<boolean> {
    if (!input.accepted) return false;
    const armed = parsePersistedPersonalFollowOnceV1(input.expectedOnce);
    if (armed?.state !== 'armed' || !matchesPersonalFollowOnceOccurrenceV1({ ...armed, occurrence: input.occurrence })) return false;
    const changed = await tx.accountSessionFollow.updateMany({
        where: { accountId: input.accountId, sessionId: input.sessionId, notifyOnce: input.expectedOnce },
        data: { notifyOnce: JSON.stringify({ ...armed, state: 'fulfilled', occurrence: input.occurrence } satisfies PersistedPersonalFollowOnceV1) },
    });
    if (changed.count !== 1) return false;
    await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
    return true;
}

/** Accepts one source-backed Inbox reference after fresh background admission. */
export async function acceptAccountSessionFollowOnceDelivery(input: Readonly<{
    accountId: string; sessionId: string; expectedOnce: string; occurrence: PersonalFollowOnceOccurrenceV1;
}>): Promise<boolean> {
    return inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return false;
        const session = await readableSession(tx, { ...input, authentication: backgroundDeliveryAuthentication() });
        if (!session || session.archivedAt !== null) return false;
        if (await isDeliveryMutedInTx(tx, {
            receiver: { kind: 'account' }, accountId: input.accountId,
            candidate: { senderSessionId: input.sessionId, source: { kind: 'session', sessionId: input.sessionId } },
        }) !== false) return false;
        return acceptAccountSessionFollowOnceDeliveryInTx(tx, input);
    });
}

/** Caller owns recipient admission and Account publication locks in this transaction. */
export async function acceptAccountSessionFollowOnceDeliveryInTx(tx: Tx, input: Readonly<{
    accountId: string; sessionId: string; expectedOnce: string; occurrence: PersonalFollowOnceOccurrenceV1;
}>): Promise<boolean> {
    const event = input.occurrence.event;
    if (event === 'permission_required' || event === 'user_action_required') {
        // A later encrypted state cannot prove the original request is live.
        const source = await tx.session.findUnique({ where: { id: input.sessionId }, select: { agentStateVersion: true } });
        if (source?.agentStateVersion !== input.occurrence.agentStateVersion) return false;
    } else {
        if (!input.occurrence.turnId || event !== 'ready' && event !== 'failed' && event !== 'cancelled') return false;
        const turn = await tx.sessionTurn.findUnique({ where: { sessionId_turnId: {
            sessionId: input.sessionId, turnId: input.occurrence.turnId,
        } }, select: { status: true } });
        if (turn?.status !== (event === 'ready' ? 'completed' : event)) return false;
    }
    return consumeAccountSessionFollowOnceInTx(tx, { ...input, accepted: true });
}

/** Existing explicit mark-read/settle clears accepted convenience attention only. */
export async function clearFulfilledAccountSessionFollowOnceInTx(tx: Tx, input: Readonly<{
    accountId: string; sessionId: string;
}>): Promise<boolean> {
    const row = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: input }, select: { notifyOnce: true } });
    if (parsePersistedPersonalFollowOnceV1(row?.notifyOnce)?.state !== 'fulfilled') return false;
    const result = await tx.accountSessionFollow.updateMany({ where: { ...input, notifyOnce: row!.notifyOnce }, data: { notifyOnce: null } });
    if (result.count !== 1) return false;
    await markSessionFollowsChangedInTx(tx, input);
    return true;
}

/** Atomically replaces one Home's durable Include in Voice membership. */
export async function replaceAccountSessionVoiceInclusions(input: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
    authentication: SessionAccessAuthentication;
}>): Promise<AccountFollowResult<Readonly<{ changed: boolean; sessionIds: string[] }>>> {
    const parsed = ReplaceSessionVoiceInclusionsRequestSchema.safeParse({ sessionIds: input.sessionIds });
    if (!parsed.success) return { ok: false, error: "invalid_parameters" };
    const sessionIds = [...new Set(parsed.data.sessionIds)].sort();
    return await inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        if (!await activeAccount(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const sessions = new Map<string, Readonly<{ accountId: string; archivedAt: Date | null }>>();
        for (const sessionId of sessionIds) {
            const session = await readableSession(tx, { ...input, sessionId });
            if (!session) return { ok: false, error: "session_not_found" };
            if (session.archivedAt !== null) return { ok: false, error: "session_archived" };
            sessions.set(sessionId, session);
        }
        const desired = new Set(sessionIds);
        const existing = (await tx.accountSessionFollow.findMany({
            where: { accountId: input.accountId, sessionId: { not: null } },
            select: FOLLOW_SELECT,
        })).filter((row): row is typeof row & { sessionId: string } => row.sessionId !== null);
        const existingBySessionId = new Map(existing.map(row => [row.sessionId, row] as const));
        let changed = false;
        for (const row of existing) {
            if (!row.following || desired.has(row.sessionId)) continue;
            if (resolveAccountVoiceSelection(row) === null && !row.includeInVoice) continue;
            const policy = projectPersonalFollowCustodyV1(row).policy;
            await tx.accountSessionFollow.update({
                where: { accountId_sessionId: { accountId: input.accountId, sessionId: row.sessionId } },
                data: { includeInVoice: false, voiceDeliveredFrontier: null,
                    ...(policy ? { followPolicy: JSON.stringify(editFollowPolicyV1(policy, { kind: 'voice', enabled: false })) } : {}) },
            });
            changed = true;
        }
        for (const sessionId of sessionIds) {
            const key = { accountId: input.accountId, sessionId };
            const row = existingBySessionId.get(sessionId);
            if (row?.following && resolveAccountVoiceSelection(row) !== null) continue;
            const policy = row?.following ? projectPersonalFollowCustodyV1(row).policy : undefined;
            const voicePolicy = policy ? editFollowPolicyV1(policy, { kind: 'voice', enabled: true })
                : normalizeAccountFollowNotificationChoiceV1({ notificationLevel: 'none', includeInVoice: true });
            if (row?.following && !row.includeInVoice && policy && voicePolicy && isFollowPolicyEqualV1(policy, voicePolicy)) continue;
            const session = sessions.get(sessionId)!;
            const wasTracked = await isSessionPersonallyTrackedInTx(tx, { ...key, ownerAccountId: session.accountId });
            await tx.accountSessionFollow.upsert({
                where: { accountId_sessionId: key },
                create: { ...key, following: true, includeInVoice: false, followPolicy: serializeFollowPolicyV1(voicePolicy), voiceDeliveredFrontier: null },
                update: {
                    following: true,
                    hasPersistentFollow: true,
                    includeInVoice: false,
                    followPolicy: serializeFollowPolicyV1(voicePolicy),
                    voiceDeliveredFrontier: null,
                },
            });
            await beginViewerReadTrackingOnFollowEntryInTx({ tx, ...key, wasTracked, authentication: input.authentication });
            changed = true;
        }
        if (changed) await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        const effective = await tx.accountSessionFollow.findMany({ where: { accountId: input.accountId, following: true, sessionId: { not: null } },
            select: { sessionId: true, includeInVoice: true, followPolicy: true }, orderBy: { sessionId: 'asc' } });
        return { ok: true, value: { changed, sessionIds: effective.flatMap(row => row.sessionId !== null && resolveAccountVoiceSelection(row) !== null ? [row.sessionId] : []) } };
    });
}

/** Reads relationship default rules and creation policies through their private Account owner. */
export async function getSessionAutoFollowPreferences(input: Readonly<{ accountId: string }>): Promise<AccountFollowResult<SessionAutoFollowPreferencesV1>> {
    return await inReadSnapshot(async tx => {
        const account = await activeAccount(tx, input.accountId);
        return account ? { ok: true, value: { ...projectPreferences(account),
            ...await readAccountFollowCreationPreferencesInTx(tx, input.accountId) } } : { ok: false, error: "account_inactive" };
    });
}

/** Updates default rules and creation policies without scanning or mutating existing Sessions. */
export async function setSessionAutoFollowPreferences(input: Readonly<{
    accountId: string; preferences: SessionAutoFollowPreferencesV1;
}>): Promise<AccountFollowResult<SessionAutoFollowPreferencesV1>> {
    const parsed = SessionAutoFollowPreferencesV1Schema.safeParse(input.preferences);
    if (!parsed.success) return { ok: false, error: "invalid_parameters" };
    const preferences = parsed.data;
    return await inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
        const account = await activeAccount(tx, input.accountId);
        if (!account) return { ok: false, error: "account_inactive" };
        const current = projectPreferences(account);
        const creation = await updateAccountFollowCreationPreferencesInTx(tx, { accountId: input.accountId, patch: {
            ...(preferences.managerPolicy ? { managerPolicy: preferences.managerPolicy } : {}),
            ...(preferences.runReportPolicy ? { runReportPolicy: preferences.runReportPolicy } : {}),
            ...(preferences.discussionReceivePolicy ? { discussionReceivePolicy: preferences.discussionReceivePolicy } : {}),
        } });
        const relationshipsChanged = (['assigned', 'direct', 'team', 'group'] as const).some(key => current[key] !== preferences[key]);
        if (relationshipsChanged) {
            await tx.account.update({ where: { id: input.accountId }, data: {
                sessionAutoFollowAssigned: preferences.assigned, sessionAutoFollowDirect: preferences.direct,
                sessionAutoFollowTeam: preferences.team, sessionAutoFollowGroup: preferences.group,
            } });
        }
        if (relationshipsChanged || creation.changed) await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
        return { ok: true, value: { ...preferences, ...creation.policies } };
    });
}


/** Final effective read loss contracts active interest; explicit user suppression remains intact. */
export async function removeAccountSessionFollowsOnAccessLossInTx(tx: Tx, input: Readonly<{
    sessionId: string; accountIds: readonly string[];
}>): Promise<number> {
    const candidates = await tx.accountSessionFollow.findMany({ where: {
        sessionId: input.sessionId, accountId: { in: [...new Set(input.accountIds)] }, following: true,
    }, select: { accountId: true } });
    if (candidates.length === 0) return 0;
    const access = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: input.sessionId, accountIds: candidates.map(row => row.accountId),
    });
    const revoked = candidates
        .map(row => row.accountId)
        .filter(accountId => access.get(accountId)?.capabilities.readTranscript !== true);
    if (revoked.length === 0) return 0;
    const result = await tx.accountSessionFollow.deleteMany({ where: { sessionId: input.sessionId, accountId: { in: revoked }, following: true } });
    await markSessionFollowsChangedForAccountsInTx(tx, revoked);
    return result.count;
}

const VOICE_SOURCE_SELECT = {
    id: true,
    archivedAt: true,
    seq: true,
    latestReadyEventSeq: true,
    agentStateVersion: true,
    latestTurnId: true,
    latestTurnStatus: true,
    active: true,
} as const;

export type PendingAccountVoiceFollowObservationV1 = Readonly<{
    sourceSessionId: string;
    voiceSessionId: string;
    expected: SessionFollowFrontierV1 | null;
    observed: SessionFollowFrontierV1;
    policy?: FollowPolicyV1;
}>;

/** Content-free Account Voice observer; null means one current snapshot is pending. */
export async function observePendingAccountVoiceFollowInTx(tx: Tx, input: Readonly<{
    accountId: string;
    voiceSessionId: string;
    authentication: SessionAccessAuthentication;
    runtimeAuthority?: CurrentAccountVoiceExecutionRunAuthority;
}>): Promise<readonly PendingAccountVoiceFollowObservationV1[] | null> {
    if (!await activeAccount(tx, input.accountId)) return null;
    if (!await hasCurrentPrivateAccountVoicePublisherInTx(tx, input)) return null;
    const muteScopes = await readDeliveryMuteScopesInTx(tx, { receiver: { kind: 'account' }, accountId: input.accountId });
    if (muteScopes === null) return null;
    const follows = await tx.accountSessionFollow.findMany({
        where: { accountId: input.accountId, following: true, sessionId: { not: null },
            OR: [{ includeInVoice: true }, { followPolicy: { not: null } }] },
        select: { sessionId: true, voiceDeliveredFrontier: true, includeInVoice: true, followPolicy: true },
        orderBy: { sessionId: 'asc' },
    });
    const pending: PendingAccountVoiceFollowObservationV1[] = [];
    for (const follow of follows) {
        if (follow.sessionId === null) continue;
        const selection = resolveAccountVoiceSelection(follow);
        if (selection === null) continue;
        if (follow.sessionId === input.voiceSessionId) continue;
        const source = await tx.session.findUnique({ where: { id: follow.sessionId }, select: VOICE_SOURCE_SELECT });
        if (!source || source.archivedAt !== null) continue;
        if ((await resolveEffectiveSessionAccess(tx, {
            accountId: input.accountId,
            sessionId: source.id,
            authentication: input.authentication,
        }))?.capabilities.readTranscript !== true) continue;
        if (isFollowDeliveryMutedV1(muteScopes, { senderSessionId: source.id, source: { kind: 'session', sessionId: source.id } })) continue;
        const expected = follow.voiceDeliveredFrontier === null
            ? null
            : parsePersistedSessionFollowFrontierV1(follow.voiceDeliveredFrontier);
        // Malformed persisted bytes fail closed; null alone is the pending-current sentinel.
        if (follow.voiceDeliveredFrontier !== null && expected === null) continue;
        const observed = projectSessionFollowFrontierFromSourceV1(source);
        if (expected !== null && compareSessionFollowFrontierProgressV1(expected, observed) !== 'ahead') continue;
        pending.push({ sourceSessionId: source.id, voiceSessionId: input.voiceSessionId, expected, observed, ...selection });
    }
    return pending;
}

export type AccountVoiceFollowAcknowledgeRejection =
    | 'forbidden'
    | 'not_followed'
    | 'session_archived'
    | 'stale_expected_frontier'
    | 'stale_terminal_turn'
    | 'invalid_consumed_frontier'
    | 'provider_acceptance_unverified'
    | 'source_forbidden';

export async function acknowledgeAccountVoiceFollowInTx(tx: Tx, input: Readonly<{
    accountId: string;
    voiceSessionId: string;
    sourceSessionId: string;
    expected: SessionFollowFrontierV1 | null;
    observed: SessionFollowFrontierV1;
    consumed: SessionFollowFrontierV1;
    policy?: FollowPolicyV1;
    acceptance: Readonly<{ localInputId: string; userMessageSeq: number | null }>;
    authentication: SessionAccessAuthentication;
    runtimeAuthority?: CurrentAccountVoiceExecutionRunAuthority;
}>): Promise<Readonly<{ ok: true; delivered: SessionFollowFrontierV1 }>
    | Readonly<{ ok: false; rejection: AccountVoiceFollowAcknowledgeRejection }>> {
    if (!await activeAccount(tx, input.accountId)) return { ok: false, rejection: 'forbidden' };
    if (!await hasCurrentPrivateAccountVoicePublisherInTx(tx, input)) return { ok: false, rejection: 'forbidden' };
    if (
        !input.acceptance
        || typeof input.acceptance.localInputId !== 'string'
        || input.acceptance.localInputId.trim().length === 0
        || !(
            input.acceptance.userMessageSeq === null
            || Number.isSafeInteger(input.acceptance.userMessageSeq) && input.acceptance.userMessageSeq >= 0
        )
    ) return { ok: false, rejection: 'provider_acceptance_unverified' };
    if (!await hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
        destinationSessionId: input.voiceSessionId,
        localInputId: input.acceptance.localInputId,
        userMessageSeq: input.acceptance.userMessageSeq,
    })) return { ok: false, rejection: 'provider_acceptance_unverified' };
    const source = await tx.session.findUnique({ where: { id: input.sourceSessionId }, select: VOICE_SOURCE_SELECT });
    if (!source) return { ok: false, rejection: 'not_followed' };
    if (source.archivedAt !== null) return { ok: false, rejection: 'session_archived' };
    if ((await resolveEffectiveSessionAccess(tx, {
        accountId: input.accountId,
        sessionId: source.id,
        authentication: input.authentication,
    }))?.capabilities.readTranscript !== true) return { ok: false, rejection: 'source_forbidden' };
    const key = { accountId: input.accountId, sessionId: input.sourceSessionId };
    const follow = await tx.accountSessionFollow.findUnique({
        where: { accountId_sessionId: key },
        select: { following: true, includeInVoice: true, voiceDeliveredFrontier: true, followPolicy: true },
    });
    const selection = follow?.following ? resolveAccountVoiceSelection(follow) : null;
    if (!follow || selection === null) return { ok: false, rejection: 'not_followed' };
    if (selection.policy ? !input.policy || !isFollowPolicyEqualV1(selection.policy, input.policy) : input.policy !== undefined) {
        return { ok: false, rejection: 'stale_expected_frontier' };
    }
    if (await isDeliveryMutedInTx(tx, { receiver: { kind: 'account' }, accountId: input.accountId,
        candidate: { senderSessionId: source.id, source: { kind: 'session', sessionId: source.id } } }) !== false) {
        return { ok: false, rejection: 'not_followed' };
    }
    const stored = follow.voiceDeliveredFrontier === null
        ? null
        : parsePersistedSessionFollowFrontierV1(follow.voiceDeliveredFrontier);
    if (follow.voiceDeliveredFrontier !== null && stored === null) return { ok: false, rejection: 'stale_expected_frontier' };
    if (stored === null ? input.expected !== null : input.expected === null || !isSessionFollowFrontierEqualV1(stored, input.expected)) {
        return { ok: false, rejection: 'stale_expected_frontier' };
    }
    const current = projectSessionFollowFrontierFromSourceV1(source);
    const baseline = input.expected ?? { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    if (!isSessionFollowConsumptionWithinCurrentV1({
        expected: baseline,
        observed: input.observed,
        consumed: input.consumed,
        current,
    })) {
        return { ok: false, rejection: 'invalid_consumed_frontier' };
    }
    if (!isSessionFollowTurnEqualV1(current.turn, input.consumed.turn)) {
        return { ok: false, rejection: 'stale_terminal_turn' };
    }
    const written = await tx.accountSessionFollow.updateMany({
        where: {
            ...key,
            following: true,
            includeInVoice: follow.includeInVoice,
            followPolicy: follow.followPolicy,
            voiceDeliveredFrontier: follow.voiceDeliveredFrontier,
        },
        data: { voiceDeliveredFrontier: encodePersistedSessionFollowFrontierV1(input.consumed) },
    });
    return written.count === 1
        ? { ok: true, delivered: input.consumed }
        : { ok: false, rejection: 'stale_expected_frontier' };
}
