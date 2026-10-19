import * as privacyKit from "privacy-kit";
import type { Prisma } from "@prisma/client";
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { ResourceContextStorageAdapter } from '@/app/session/access/sessionContextInjection';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol/storage/artifactStoredContent";
import { isActiveHomeAccountStatus } from "@happier-dev/protocol/home/governance";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { verifyCurrentMaterializedRunnerPrincipalInTx } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";
import { RECIPIENT_READINESS_SELECT } from "@/app/session/encryption/sessionDataKeyRecipientProjection";
import { backgroundDeliveryAuthentication, resolveQualifiedSessionTeamIdsInTx, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { projectResourceRecipientEnvelope, resourceGrantRelationsSelect, resolveResourceGrantAccessFromFacts,
    resolveResourceGrantAudienceFromFacts, readResourceGrantPrincipalAudienceInTx, type ResourceGrantAccess, type ResourceGrantAccessFacts,
    type ResourceGrantStorageAdapter } from "@/app/teams/resourceGrantAccess";
import type { Tx } from "@/storage/inTx";
import { inReadSnapshot, TransactionReplayRequiredError } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { beforeAccountChangePublication } from '@/app/changes/markAccountChanged';
import { fenceSessionAccountCursorAudienceInTx, readSessionAccountCursorAudienceInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';

type DiscussionMutationAudienceInput = Readonly<{
    discussionId: string; actorAccountId?: string; additionalAccountIds?: readonly string[];
    additionalSessionIds?: readonly string[]; includeParticipantSessions?: boolean;
    additionalGrantPrincipal?: PrincipalRefV1;
    includeDiscussionPublication?: boolean;
}>;

async function readDiscussionParticipantSessionIdsInTx(tx: Tx, input: DiscussionMutationAudienceInput) {
    if (!input.includeParticipantSessions) return [];
    const [participants, edges] = await Promise.all([
        tx.discussionParticipant.findMany({ where: { discussionId: input.discussionId, removedAt: null },
            select: { sessionId: true } }),
        tx.sessionFollowEdge.findMany({ where: { sourceDiscussionId: input.discussionId },
            select: { destinationSessionId: true } }),
    ]);
    return [...participants.flatMap(participant => participant.sessionId ? [participant.sessionId] : []),
        ...edges.map(edge => edge.destinationSessionId)];
}

/** One census serves both pre-attempt preparation and in-transaction admission. */
async function readDiscussionMutationAudienceInTx(tx: Tx, input: DiscussionMutationAudienceInput) {
    const discussion = await tx.discussion.findUnique({ where: { id: input.discussionId }, select: { ownerAccountId: true } });
    const sessionIds = [...new Set([
        ...await readDiscussionParticipantSessionIdsInTx(tx, input),
        ...input.additionalSessionIds ?? [],
    ])];
    const publicationAudience = [
        ...(input.includeDiscussionPublication === false ? [] : await resolveDiscussionAudienceInTx(tx, input.discussionId)),
        ...(discussion && input.additionalGrantPrincipal ? await readResourceGrantPrincipalAudienceInTx(tx, {
            ownerAccountId: discussion.ownerAccountId, principal: input.additionalGrantPrincipal,
        }) : []),
    ];
    const additionalAccountIds = [
        ...(discussion ? [discussion.ownerAccountId] : []),
        ...(input.actorAccountId ? [input.actorAccountId] : []),
        ...input.additionalAccountIds ?? [],
        ...publicationAudience,
    ];
    const audience = await readSessionAccountCursorAudienceInTx(tx, sessionIds, additionalAccountIds);
    return { ownerAccountId: discussion?.ownerAccountId, sessionIds, additionalAccountIds, audience };
}

async function fenceDiscussionMutationAudienceInTx(tx: Tx, input: DiscussionMutationAudienceInput,
    { ownerAccountId, sessionIds, additionalAccountIds, audience }: Awaited<ReturnType<typeof readDiscussionMutationAudienceInTx>>) {
    await fenceSessionAccountCursorAudienceInTx(tx, audience, sessionIds, additionalAccountIds);
    const current = await readDiscussionMutationAudienceInTx(tx, input);
    const admittedAccounts = new Set(audience.accountIds);
    const admittedSessions = new Set(sessionIds);
    if (current.ownerAccountId !== ownerAccountId
        || current.sessionIds.some(sessionId => !admittedSessions.has(sessionId))
        || current.audience.accountIds.some(accountId => !admittedAccounts.has(accountId))) {
        throw new TransactionReplayRequiredError('transaction-account-audience-changed');
    }
    if (input.includeParticipantSessions) {
        // Fanout consumes the actual Follow destinations. A newly observed
        // Session must replay the complete cohort, never acquire a parent lock
        // after this mutation has already taken its child locks.
        beforeAccountChangePublication(tx, audience.accountIds, async client => {
            if ((await readDiscussionParticipantSessionIdsInTx(client, input)).some(sessionId => !admittedSessions.has(sessionId))) {
                throw new TransactionReplayRequiredError('transaction-account-audience-changed');
            }
        });
    }
}

/** Stabilize lifecycle and key authority before a Discussion mutation takes resource locks. */
export async function acquireDiscussionMutationAccountsInTx(tx: Tx, input: DiscussionMutationAudienceInput): Promise<void> {
    await fenceDiscussionMutationAudienceInTx(tx, input, await readDiscussionMutationAudienceInTx(tx, input));
}

/** Refresh outside each mutation attempt, then admit Accounts before any domain reads. */
export async function prepareDiscussionMutationAccounts(input: DiscussionMutationAudienceInput): Promise<(tx: Tx) => Promise<void>> {
    // SQLite already owns its single writer; retain its existing in-transaction census.
    if (getDbProviderFromEnv(process.env, 'postgres') === 'sqlite') {
        return tx => acquireDiscussionMutationAccountsInTx(tx, input);
    }
    const audience = await inReadSnapshot(tx => readDiscussionMutationAudienceInTx(tx, input));
    return tx => fenceDiscussionMutationAudienceInTx(tx, input, audience);
}

export type DiscussionStorageMode = "plain" | "e2ee";
export interface DiscussionContext {
    discussionId: string;
    ownerAccountId: string;
    storageMode: DiscussionStorageMode;
    access: ResourceGrantAccess;
    keyReadiness: boolean;
    dataEncryptionKey: string | null;
}

function discussionAccessFactsSelect(actorAccountId?: string) {
    const relations = resourceGrantRelationsSelect(actorAccountId);
    return {
        id: true, ownerAccountId: true, encryptionMode: true,
        ownerAccount: { select: { ...RECIPIENT_READINESS_SELECT, status: true } },
        ...relations,
        teamGrants: { select: { ...relations.teamGrants.select, team: { select: {
            ...relations.teamGrants.select.team.select, id: true, authenticationPolicy: true,
        } } } },
        groupGrants: { select: { ...relations.groupGrants.select, teamGroup: { select: {
            ...relations.groupGrants.select.teamGroup.select, team: { select: {
                ...relations.groupGrants.select.teamGroup.select.team.select, id: true, authenticationPolicy: true,
            } },
        } } } },
    } as const;
}

async function readDiscussionAccessFactsInTx(tx: Tx, discussionId: string, actorAccountId?: string) {
    return tx.discussion.findUnique({ where: { id: discussionId }, select: discussionAccessFactsSelect(actorAccountId) });
}
type DiscussionAccessFacts = NonNullable<Awaited<ReturnType<typeof readDiscussionAccessFactsInTx>>>;

function discussionGrantFacts(row: DiscussionAccessFacts, qualifiedTeamIds?: ReadonlySet<string>): ResourceGrantAccessFacts {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.ownerAccount);
    return {
        ownerAccountId: row.ownerAccountId,
        encryptionMode: mode.status === "ready" && mode.mode === row.encryptionMode ? mode.mode : null,
        accountGrants: row.accountGrants,
        teamGrants: qualifiedTeamIds ? row.teamGrants.filter(grant => qualifiedTeamIds.has(grant.team.id)) : row.teamGrants,
        groupGrants: qualifiedTeamIds ? row.groupGrants.filter(grant => qualifiedTeamIds.has(grant.teamGroup.team.id)) : row.groupGrants,
    };
}

/** Structural grants are shared policy; request credentials qualify collective arms separately. */
export const discussionGrantStorageAdapter: ResourceGrantStorageAdapter = {
    async readAccessFactsInTx(tx, discussionId, actorAccountId) {
        const row = await readDiscussionAccessFactsInTx(tx, discussionId, actorAccountId);
        return row ? discussionGrantFacts(row) : null;
    },
};

/** Content disclosure additionally consumes the real credential/participant admission owner. */
export const discussionContextStorageAdapter: ResourceContextStorageAdapter = {
    ...discussionGrantStorageAdapter,
    async resolveConfigurerAccessInTx(tx, input) {
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.resourceId,
            accountId: input.actorAccountId, authentication: input.authentication });
        return context?.access ?? null;
    },
};

/** The validated initial roster is the new resource's audience before its atomic insert. */
export function newDiscussionContextStorageAdapter(input: Readonly<{
    resourceId: string; ownerAccountId: string; encryptionMode: DiscussionStorageMode;
    participantAccountIds: readonly string[];
}>): ResourceContextStorageAdapter {
    const facts: ResourceGrantAccessFacts = { ownerAccountId: input.ownerAccountId, encryptionMode: input.encryptionMode,
        accountGrants: input.participantAccountIds.map(accountId => ({ accountId, accessLevel: 'edit', account: { status: 'active' } })),
        teamGrants: [], groupGrants: [] };
    return {
        async readAccessFactsInTx(_tx, resourceId) { return resourceId === input.resourceId ? facts : null; },
        async resolveConfigurerAccessInTx(_tx, request) {
            return request.resourceId === input.resourceId ? resolveResourceGrantAccessFromFacts(facts, request.actorAccountId) : null;
        },
    };
}

function teamsFromFacts(rows: readonly DiscussionAccessFacts[]) {
    return [...new Map(rows.flatMap(row => [
        ...row.teamGrants.map(grant => grant.team), ...row.groupGrants.map(grant => grant.teamGroup.team),
    ]).map(team => [team.id, team])).values()];
}

/** PAT resource ceilings cannot be widened from a Session or Machine to a Discussion. */
export async function isDiscussionAccountCredentialAdmittedInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication; discussionId?: string;
}>): Promise<boolean> {
    if (!await isDiscussionCredentialCurrentInTx(tx, input)) return false;
    const principal = input.authentication.sessionRuntimePrincipal;
    if (!principal) return true;
    if (!input.discussionId) return false;
    return await tx.discussionParticipant.findUnique({ where: { discussionId_sessionId: {
        discussionId: input.discussionId, sessionId: principal.sessionId,
    } }, select: { sessionId: true, removedAt: true } }).then(row => row !== null && row.removedAt === null);
}

export async function isDiscussionCredentialCurrentInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    if (input.authentication.apiTokenGrant?.targets != null) return false;
    const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { status: true, tokenEpoch: true } });
    if (!account || !isActiveHomeAccountStatus(account.status)
        || (input.authentication.tokenEpoch !== undefined && input.authentication.tokenEpoch !== account.tokenEpoch)) return false;
    const principal = input.authentication.sessionRuntimePrincipal;
    if (!principal) return true;
    if (principal.accountId !== input.accountId
        || !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, principal)) return false;
    return true;
}

/** One admission joins persisted mode, live grants, credentials and the caller's own key. */
export async function resolveDiscussionContextInTx(tx: Tx, params: Readonly<{
    discussionId: string; accountId: string; authentication: SessionAccessAuthentication;
}>): Promise<DiscussionContext | null> {
    const contexts = await resolveDiscussionContextsInTx(tx, { ...params, discussionIds: [params.discussionId] });
    return contexts.get(params.discussionId) ?? null;
}

/** Lists and exact reads share one batched capture and the same grant/key projection. */
export async function resolveDiscussionContextsInTx(tx: Tx, params: Readonly<{
    discussionIds: readonly string[]; accountId: string; authentication: SessionAccessAuthentication;
}>): Promise<ReadonlyMap<string, DiscussionContext>> {
    const contexts = new Map<string, DiscussionContext>();
    if (params.discussionIds.length === 0 || !await isDiscussionCredentialCurrentInTx(tx, params)) return contexts;
    const principal = params.authentication.sessionRuntimePrincipal;
    const [rows, account] = await Promise.all([
        tx.discussion.findMany({ where: { id: { in: [...params.discussionIds] } }, select: {
            ...discussionAccessFactsSelect(params.accountId), dataEncryptionKey: true,
            keyEnvelopes: { where: { recipientAccountId: params.accountId }, select: {
                encryptedDataKey: true, recipientContentPublicKeyFingerprint: true,
            } },
            participants: { where: principal ? { sessionId: principal.sessionId, removedAt: null } : { sessionId: { in: [] } }, select: { sessionId: true } },
        } }),
        tx.account.findUnique({ where: { id: params.accountId }, select: RECIPIENT_READINESS_SELECT }),
    ]);
    if (!account) return contexts;
    const qualified = await resolveQualifiedSessionTeamIdsInTx(tx, { accountIds: [params.accountId],
        teams: teamsFromFacts(rows), authentication: params.authentication });
    const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
    for (const row of rows) {
        if (principal && row.participants.length === 0) continue;
        const access = resolveResourceGrantAccessFromFacts(discussionGrantFacts(row, qualified), params.accountId);
        if (!access?.encryptionMode) continue;
        const admittedAccess = principal && access.level !== "view" ? { ...access, level: "edit" as const } : access;
        if (access.encryptionMode === "plain") {
            if (privacyKit.encodeBase64(new Uint8Array(row.dataEncryptionKey)) !== ARTIFACT_PLAIN_DATA_KEY_MARKER) continue;
            contexts.set(row.id, { discussionId: row.id, ownerAccountId: row.ownerAccountId, storageMode: "plain",
                access: admittedAccess, keyReadiness: true, dataEncryptionKey: null });
            continue;
        }
        const envelope = params.accountId === row.ownerAccountId && readiness.status === "available"
            ? { encryptedDataKey: row.dataEncryptionKey, recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint }
            : row.keyEnvelopes[0];
        const key = envelope ? projectResourceRecipientEnvelope(account, envelope, readiness) : null;
        contexts.set(row.id, { discussionId: row.id, ownerAccountId: row.ownerAccountId, storageMode: "e2ee", access: admittedAccess,
            keyReadiness: key !== null, dataEncryptionKey: key ? privacyKit.encodeBase64(key) : null });
    }
    return contexts;
}

/** Narrow before paging using only reachability; shared policy subsequently admits every row. */
export function discussionCandidateWhere(accountId: string): Prisma.DiscussionWhereInput {
    return { OR: [
        { ownerAccountId: accountId },
        { accountGrants: { some: { accountId } } },
        { teamGrants: { some: { team: { memberships: { some: { accountId } } } } } },
        { groupGrants: { some: { teamGroup: { memberships: { some: { teamMembership: { accountId } } } } } } },
    ] };
}

/** A disclosure audience describes entitlement, independently of one request's credentials. */
export async function resolveDiscussionAudienceInTx(tx: Tx, discussionId: string): Promise<string[]> {
    const row = await readDiscussionAccessFactsInTx(tx, discussionId);
    if (!row) return [];
    const facts = discussionGrantFacts(row);
    if (!facts.encryptionMode) return [];
    const candidates = resolveResourceGrantAudienceFromFacts(facts);
    const accounts = await tx.account.findMany({ where: { id: { in: candidates }, status: "active" }, select: { id: true } });
    return accounts.map(account => account.id).sort();
}

/** Set-wise admission serves mentions, private attention and grant-entry cursors. Keys are separate. */
export async function filterDiscussionsWithCurrentReadAccessInTx(tx: Tx, params: Readonly<{
    discussionIds: readonly string[]; accountIds: readonly string[]; authentication?: SessionAccessAuthentication;
}>): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const accountIds = [...new Set(params.accountIds)];
    const result = new Map(accountIds.map(accountId => [accountId, new Set<string>()]));
    if (accountIds.length === 0 || params.discussionIds.length === 0) return result;
    const authentication = params.authentication ?? backgroundDeliveryAuthentication();
    if (authentication.apiTokenGrant?.targets != null
        || ((authentication.authenticationEvidence?.length ?? 0) > 0 && accountIds.length !== 1)) return result;
    const principal = authentication.sessionRuntimePrincipal;
    if (principal && (accountIds.length !== 1 || accountIds[0] !== principal.accountId
        || !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, principal))) return result;
    const [rows, accounts] = await Promise.all([
        tx.discussion.findMany({ where: { id: { in: [...params.discussionIds] } }, select: {
            ...discussionAccessFactsSelect(),
            participants: { where: principal ? { sessionId: principal.sessionId, removedAt: null } : { sessionId: { in: [] } }, select: { sessionId: true } },
        } }),
        tx.account.findMany({ where: { id: { in: accountIds }, status: "active",
            ...(authentication.tokenEpoch === undefined ? {} : { tokenEpoch: authentication.tokenEpoch }) }, select: { id: true } }),
    ]);
    const qualified = await resolveQualifiedSessionTeamIdsInTx(tx, { accountIds, teams: teamsFromFacts(rows), authentication });
    for (const row of rows) {
        if (principal && row.participants.length === 0) continue;
        const facts = discussionGrantFacts(row, qualified);
        if (!facts.encryptionMode) continue;
        for (const account of accounts) {
            if (resolveResourceGrantAccessFromFacts(facts, account.id)) result.get(account.id)?.add(row.id);
        }
    }
    return result;
}

export async function filterAccountsWithCurrentDiscussionReadAccessInTx(tx: Tx, params: Readonly<{
    discussionId: string; accountIds: readonly string[]; authentication?: SessionAccessAuthentication;
}>): Promise<ReadonlySet<string>> {
    const result = await filterDiscussionsWithCurrentReadAccessInTx(tx, { ...params, discussionIds: [params.discussionId] });
    return new Set([...result].filter(([, ids]) => ids.has(params.discussionId)).map(([accountId]) => accountId));
}
