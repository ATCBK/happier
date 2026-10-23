import type { Tx } from "@/storage/inTx";
import { acquireTeamMutationAccountAdmissionInTx } from "../memberships/sessionAccessEffects";

import { applyReadyDirectorySourceFactsForAccountInTx } from "./directoryProjectionRepository";
import { readDirectorySourceCompletedEvidenceAllowedByIdsInTx } from "./directorySourcePolicy";

/**
 * Bind a provisioned directory person to the Account that just proved the
 * matching provider identity (Teams Lane 03 child 05 §6.3).
 *
 * Directory people exist before Accounts. The bridge between the two is
 * immutable provider evidence and nothing else: the WorkOS IdP subject observed
 * on a successful SSO profile, or the immutable GitHub user id. Email, login,
 * and display name are review hints here, never authority, so an equal address
 * can never adopt somebody else's provisioned row.
 *
 * Binding is deliberately conservative. A subject that matches nothing, matches
 * more than one row in the same source, or belongs to another Account stays
 * unbound and recoverable rather than guessing. Binding alone also grants
 * nothing: native Team access follows only from a source whose complete
 * projection is current, which the projection owner rechecks in this same
 * transaction.
 */
export type DirectoryProvisionedIdentityMatch =
    | Readonly<{
        kind: "workos_directory";
        teamIdentityConnectionId: string;
        externalSubjectId: string | null;
    }>
    | Readonly<{
        kind: "github_organization";
        githubAppInstallationId: string;
        externalUserId: string;
    }>;

export type DirectoryProvisionedBindResult = Readonly<{
    boundIdentityIds: readonly string[];
    nativeFactsApplied: boolean;
}>;

const UNBOUND: DirectoryProvisionedBindResult = { boundIdentityIds: [], nativeFactsApplied: false };

/** Read current exact directory people for one immutable provider identity fact. */
export async function readDirectoryProvisionedIdentityCandidatesInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; match: DirectoryProvisionedIdentityMatch }>,
) {
    const evidence = input.match.kind === "workos_directory"
        ? {
            source: {
                teamId: input.teamId,
                kind: "workos_directory" as const,
                teamIdentityConnectionId: input.match.teamIdentityConnectionId,
            },
            externalSubjectId: input.match.externalSubjectId ?? "",
        }
        : {
            source: {
                teamId: input.teamId,
                kind: "github_organization" as const,
                githubAppInstallationId: input.match.githubAppInstallationId,
            },
            externalUserId: input.match.externalUserId,
        };
    if ("externalSubjectId" in evidence ? !evidence.externalSubjectId : !evidence.externalUserId) return [];
    const candidates = await tx.teamProvisionedIdentity.findMany({
        where: {
            source: {
                ...evidence.source,
            },
            ...("externalSubjectId" in evidence
                ? { externalSubjectId: evidence.externalSubjectId }
                : { externalUserId: evidence.externalUserId }),
        },
        select: {
            id: true,
            directorySourceId: true,
            boundAccountId: true,
            source: { select: { id: true, kind: true, state: true, activeReconcileRunId: true } },
        },
        orderBy: [{ directorySourceId: "asc" }, { externalUserId: "asc" }],
    });
    const ready: Array<Readonly<{
        id: string;
        directorySourceId: string;
        boundAccountId: string | null;
    }>> = [];
    const allowedSources = await readDirectorySourceCompletedEvidenceAllowedByIdsInTx(tx, {
        sources: candidates.map(candidate => candidate.source),
    });
    for (const candidate of candidates) {
        if (allowedSources.get(candidate.source.id) !== true) continue;
        ready.push({
            id: candidate.id,
            directorySourceId: candidate.directorySourceId,
            boundAccountId: candidate.boundAccountId,
        });
    }
    return ready;
}

export type ProviderReplacementProvisionedIdentityRebindPreparation =
    | Readonly<{ status: "ready"; identityIds: readonly string[] }>
    | Readonly<{ status: "conflict"; teamIds: readonly string[] }>;

/**
 * Moves every directory identity bound to a provider-reset Account while
 * preserving its source and membership-lifetime references.
 *
 * The preflight validates both sides of the binding: every provisioned
 * identity attached to one of the transferred memberships must still be bound
 * to the replaced Account, and every admitted identity bound to that Account
 * must reference one of those same-Team membership lifetimes. Returning a
 * conflict before the update lets the enclosing replacement transaction refuse
 * an ambiguous merge without creating the new Account or moving any authority
 * fact.
 */
export async function prepareProvisionedIdentityRebindForAccountReplacementInTx(
    tx: Tx,
    input: Readonly<{
        oldAccountId: string;
        memberships: readonly Readonly<{ id: string; teamId: string }>[];
    }>,
): Promise<ProviderReplacementProvisionedIdentityRebindPreparation> {
    const membershipTeamById = new Map(input.memberships.map((membership) => [membership.id, membership.teamId]));
    const membershipIds = [...membershipTeamById.keys()];
    const boundToOld = await tx.teamProvisionedIdentity.findMany({
        where: { boundAccountId: input.oldAccountId },
        select: { id: true, teamMembershipId: true, source: { select: { teamId: true } } },
    });
    const attachedToTransferredMemberships = membershipIds.length === 0
        ? []
        : await tx.teamProvisionedIdentity.findMany({
            where: { teamMembershipId: { in: membershipIds } },
            select: { boundAccountId: true, teamMembershipId: true, source: { select: { teamId: true } } },
        });

    const conflictTeamIds = new Set<string>();
    for (const identity of boundToOld) {
        if (identity.teamMembershipId === null) continue;
        const membershipTeamId = membershipTeamById.get(identity.teamMembershipId) ?? null;
        if (membershipTeamId !== identity.source.teamId) {
            conflictTeamIds.add(membershipTeamId ?? identity.source.teamId);
        }
    }
    for (const identity of attachedToTransferredMemberships) {
        const membershipTeamId = identity.teamMembershipId === null
            ? null
            : membershipTeamById.get(identity.teamMembershipId) ?? null;
        if (identity.boundAccountId !== input.oldAccountId || membershipTeamId !== identity.source.teamId) {
            conflictTeamIds.add(membershipTeamId ?? identity.source.teamId);
        }
    }
    if (conflictTeamIds.size > 0) {
        return { status: "conflict", teamIds: [...conflictTeamIds].sort() };
    }

    return { status: "ready", identityIds: boundToOld.map((identity) => identity.id).sort() };
}

export async function rebindPreparedProvisionedIdentitiesForAccountReplacementInTx(
    tx: Tx,
    input: Readonly<{
        oldAccountId: string;
        replacementAccountId: string;
        identityIds: readonly string[];
    }>,
): Promise<void> {
    if (input.identityIds.length === 0) return;
    const moved = await tx.teamProvisionedIdentity.updateMany({
        where: { id: { in: [...input.identityIds] }, boundAccountId: input.oldAccountId },
        data: { boundAccountId: input.replacementAccountId },
    });
    if (moved.count !== input.identityIds.length) {
        throw new Error("Provisioned identity binding changed during provider Account replacement");
    }
}

export async function bindDirectoryProvisionedIdentitiesInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        teamId: string;
        match: DirectoryProvisionedIdentityMatch;
    }>,
): Promise<DirectoryProvisionedBindResult> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.accountId], affectedAccountIds: [input.accountId], membershipChange: { kind: "teamMembership", teamId: input.teamId } });
    const candidates = await readDirectoryProvisionedIdentityCandidatesInTx(tx, input);

    const ambiguousSourceIds = new Set(
        candidates
            .map((candidate) => candidate.directorySourceId)
            .filter((sourceId, index, all) => all.indexOf(sourceId) !== index),
    );

    const boundIdentityIds: string[] = [];
    const sourceIds: string[] = [];
    for (const candidate of candidates) {
        if (ambiguousSourceIds.has(candidate.directorySourceId)) continue;
        if (candidate.boundAccountId !== null && candidate.boundAccountId !== input.accountId) continue;
        if (candidate.boundAccountId === null) {
            await tx.teamProvisionedIdentity.update({
                where: { id: candidate.id },
                data: { boundAccountId: input.accountId },
            });
        }
        boundIdentityIds.push(candidate.id);
        sourceIds.push(candidate.directorySourceId);
    }
    if (boundIdentityIds.length === 0) return UNBOUND;

    let nativeFactsApplied = false;
    for (const sourceId of sourceIds) {
        const applied = await applyReadyDirectorySourceFactsForAccountInTx(tx, {
            sourceId,
            teamId: input.teamId,
            accountId: input.accountId,
        });
        nativeFactsApplied = nativeFactsApplied || applied;
    }
    return { boundIdentityIds, nativeFactsApplied };
}
