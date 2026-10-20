import type { Tx } from "@/storage/inTx";
import type { Prisma } from "@prisma/client";
import { AccountStatus, TeamMembershipStatus } from "@/storage/prisma";
import { resolveGrantableTeamForActorInTx } from "@/app/teams/queries";
import { resolveGrantableTeamGroupForActorInTx } from "@/app/teams/groups/groupService";
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

/**
 * Who may be named as the subject of a Session access grant.
 *
 * This is the domain-local shape. The wire vocabulary is the shared
 * `PrincipalRefV1` identity union; the grant service deliberately does not publish
 * a second Session-specific identity union to the network.
 */
export type SessionAccessGrantSubject = Readonly<PrincipalRefV1>;

export type SessionAccessGrantSubjectError =
    | "session_access_subject_not_found"
    | "session_access_subject_ineligible"
    | "session_access_owner_grant_invalid"
    | "session_access_self_grant_invalid";

export type SessionAccessGrantSubjectResolution =
    | Readonly<{ ok: true; subject: SessionAccessGrantSubject }>
    | Readonly<{ ok: false; error: SessionAccessGrantSubjectError }>;

/** Reject Account grant identities that can never be valid, even for an absent-row removal retry. */
export function validateSessionAccessGrantAccountSubjectIdentity(params: Readonly<{
    actorAccountId: string;
    sessionOwnerAccountId: string;
    subjectAccountId: string;
}>): Extract<SessionAccessGrantSubjectError, "session_access_owner_grant_invalid" | "session_access_self_grant_invalid"> | null {
    if (params.subjectAccountId === params.sessionOwnerAccountId) {
        return "session_access_owner_grant_invalid";
    }
    if (params.subjectAccountId === params.actorAccountId) {
        return "session_access_self_grant_invalid";
    }
    return null;
}

/**
 * Resolve a complete Account-subject set with the same collaboration decision as
 * the single-subject mutation path, without turning audience size into an N+1
 * transaction timeout. Results preserve input order and duplicates.
 */
export async function resolveSessionAccessGrantAccountSubjectsInTx(
    tx: Tx,
    params: Readonly<{
        actorAccountId: string;
        sessionOwnerAccountId: string;
        subjectAccountIds: readonly string[];
        hasExistingGrant: boolean;
        removingExistingGrant?: boolean;
    }>,
): Promise<readonly SessionAccessGrantSubjectResolution[]> {
    const identityErrors = new Map<string, SessionAccessGrantSubjectError>();
    for (const subjectAccountId of params.subjectAccountIds) {
        const error = validateSessionAccessGrantAccountSubjectIdentity({
            actorAccountId: params.actorAccountId,
            sessionOwnerAccountId: params.sessionOwnerAccountId,
            subjectAccountId,
        });
        if (error) identityErrors.set(subjectAccountId, error);
    }
    const candidateIds = [...new Set(params.subjectAccountIds.filter((id) => !identityErrors.has(id)))];
    const accounts = candidateIds.length === 0 ? [] : await tx.account.findMany({
        where: { id: { in: candidateIds } },
        select: { id: true, status: true },
    });
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    const eligibleIds = params.removingExistingGrant || params.hasExistingGrant || candidateIds.length === 0
        ? new Set(candidateIds)
        : new Set((await tx.account.findMany({
            where: {
                AND: [
                    { id: { in: candidateIds } },
                    buildSessionAccessCollaborationAccountWhere(params.actorAccountId),
                ],
            },
            select: { id: true },
        })).map((account) => account.id));

    return params.subjectAccountIds.map((accountId): SessionAccessGrantSubjectResolution => {
        const identityError = identityErrors.get(accountId);
        if (identityError) return { ok: false, error: identityError };
        const account = accountsById.get(accountId);
        if (!account) return { ok: false, error: "session_access_subject_not_found" };
        if (params.removingExistingGrant) return { ok: true, subject: { kind: "account", accountId } };
        if (account.status !== AccountStatus.active || !eligibleIds.has(accountId)) {
            return { ok: false, error: "session_access_subject_ineligible" };
        }
        return { ok: true, subject: { kind: "account", accountId } };
    });
}

/**
 * A directly granted Account must be reachable by the actor for some legitimate
 * reason. Accepted friendship is the released source; a current shared Team is the
 * added one, because colleagues on the same Home Team are exactly as legitimate and
 * "friends only" was never an authorization rule, only a discovery rule.
 */
export function buildSessionAccessCollaborationAccountWhere(
    actorAccountId: string,
): Prisma.AccountWhereInput {
    return {
        id: { not: actorAccountId },
        status: AccountStatus.active,
        OR: [
            {
                RelationshipsFrom: {
                    some: { toUserId: actorAccountId, status: "friend" },
                },
            },
            {
                RelationshipsTo: {
                    some: { fromUserId: actorAccountId, status: "friend" },
                },
            },
            {
                teamMemberships: {
                    some: {
                        status: TeamMembershipStatus.active,
                        team: {
                            archivedAt: null,
                            memberships: {
                                some: { accountId: actorAccountId, status: TeamMembershipStatus.active },
                            },
                        },
                    },
                },
            },
        ],
    };
}

/**
 * Resolve and validate one grant subject inside the deciding transaction.
 *
 * Eligibility is re-proved here rather than at request admission because a
 * friendship, membership, Team, or Group can disappear between the picker's
 * suggestion and the commit.
 */
export async function resolveSessionAccessGrantSubjectInTx(
    tx: Tx,
    params: Readonly<{
        actorAccountId: string;
        sessionOwnerAccountId: string;
        subject: SessionAccessGrantSubject;
        /** An existing grant may be edited or downgraded after discovery eligibility ends. */
        hasExistingGrant: boolean;
        /** Removal remains possible after the existing subject becomes inactive or archived. */
        removingExistingGrant?: boolean;
    }>,
): Promise<SessionAccessGrantSubjectResolution> {
    const [resolved] = await resolveSessionAccessGrantSubjectsInTx(tx, {
        ...params,
        subjects: [params.subject],
    });
    return resolved?.eligibility ?? { ok: false, error: "session_access_subject_not_found" };
}

/** Resolve roster subjects together, retaining the writer's distinct removal verdict. */
export async function resolveSessionAccessGrantSubjectsInTx(
    tx: Tx,
    params: Readonly<{
        actorAccountId: string;
        sessionOwnerAccountId: string;
        subjects: readonly SessionAccessGrantSubject[];
        hasExistingGrant: boolean;
        removingExistingGrant?: boolean;
    }>,
): Promise<readonly Readonly<{
    eligibility: SessionAccessGrantSubjectResolution;
    removalEligibility: SessionAccessGrantSubjectResolution;
}>[]> {
    const accountIds = params.subjects.flatMap((subject) => subject.kind === "account" ? [subject.accountId] : []);
    const accountResolutions = await resolveSessionAccessGrantAccountSubjectsInTx(tx, {
        ...params,
        subjectAccountIds: accountIds,
    });
    const accountsById = new Map(accountIds.map((id, index) => [id, accountResolutions[index]!]));
    const teamIds = [...new Set(params.subjects.flatMap((subject) => subject.kind === "team" ? [subject.teamId] : []))];
    const teams = teamIds.length === 0 ? [] : await tx.team.findMany({
        where: { id: { in: teamIds } },
        select: { id: true, archivedAt: true },
    });
    const teamsById = new Map(teams.map((team) => [team.id, team]));
    const groupIds = [...new Set(params.subjects.flatMap((subject) => subject.kind === "group" ? [subject.groupId] : []))];
    const groups = groupIds.length === 0 ? [] : await tx.teamGroup.findMany({
        where: { id: { in: groupIds } },
        select: {
            id: true, teamId: true, archivedAt: true,
            team: { select: { archivedAt: true } },
        },
    });
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const results: { eligibility: SessionAccessGrantSubjectResolution; removalEligibility: SessionAccessGrantSubjectResolution }[] = [];
    for (const subject of params.subjects) {
        let eligibility: SessionAccessGrantSubjectResolution;
        if (subject.kind === "account") {
            eligibility = accountsById.get(subject.accountId) ?? { ok: false, error: "session_access_subject_not_found" };
        } else if (subject.kind === "team") {
            const team = teamsById.get(subject.teamId);
            if (!team) eligibility = { ok: false, error: "session_access_subject_not_found" };
            else if (params.removingExistingGrant) eligibility = { ok: true, subject };
            else if (team.archivedAt !== null || (!params.hasExistingGrant && !await resolveGrantableTeamForActorInTx(tx, {
                actorAccountId: params.actorAccountId, teamId: subject.teamId,
            }))) eligibility = { ok: false, error: "session_access_subject_ineligible" };
            else eligibility = { ok: true, subject };
        } else {
            // The Group row owns its parent Team; never trust the caller's claim.
            const group = groupsById.get(subject.groupId);
            if (!group || group.teamId !== subject.teamId) eligibility = { ok: false, error: "session_access_subject_not_found" };
            else if (params.removingExistingGrant) eligibility = { ok: true, subject };
            else if (group.archivedAt !== null || group.team.archivedAt !== null
                || (!params.hasExistingGrant && !await resolveGrantableTeamGroupForActorInTx(tx, {
                    actorAccountId: params.actorAccountId, teamId: subject.teamId, groupId: subject.groupId,
                }))) eligibility = { ok: false, error: "session_access_subject_ineligible" };
            else eligibility = { ok: true, subject };
        }
        // Ineligibility follows existence and identity validation. Removal skips
        // activity/discovery checks, but never missing or invalid identities.
        const removalEligibility: SessionAccessGrantSubjectResolution = eligibility.ok || eligibility.error === "session_access_subject_ineligible"
            ? { ok: true, subject } : eligibility;
        results.push({ eligibility, removalEligibility });
    }
    return results;
}
