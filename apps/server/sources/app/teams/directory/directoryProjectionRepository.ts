import { acquireTeamMutationAccountAdmissionInTx, withTeamSessionAccessEffectsInTx } from "../memberships/sessionAccessEffects";
import { publishTeamChangedInTx } from "../teamChanges";
import { acquireTeamMutationLockInTx } from "../actorContext";
import { inTx, type Tx } from "@/storage/inTx";
import {
    acquireExternalSourceAccountAdmissionInTx,
    applyExternalGroupContributionInTx,
    applyExternalManagedGroupInTx,
    applyExternalTeamMembershipInTx,
    directoryGroupContributorIdentityWhere,
    removeExternalGroupBindingInTx,
} from "../memberships/externalFacts";
import { projectDirectorySyncFreshness } from "./directorySourceProjection";
import type { DirectoryGroup, DirectoryGroupMember, DirectoryPerson } from "./directorySourceEvidence";
import {
    isDirectorySourceAllowedInTx,
    isDirectorySourceCompletedEvidenceAllowedInTx,
    isDirectorySourceKindAllowedInTx,
} from "./directorySourcePolicy";
import type { ExpectedDirectorySourceCurrentness } from "./directorySourcePolicy";
import { publishDirectorySourceStatusTransitionInTx } from "./directorySourceService";

export type DirectoryProjectionWriteResult =
    | Readonly<{ applied: true }>
    | Readonly<{ applied: false; reason: "stale_run" }>;

type DirectoryProjectionPage = Readonly<{
    sourceId: string;
    reconcileRunId: string;
    people?: readonly DirectoryPerson[];
    groups?: readonly DirectoryGroup[];
    groupMembers?: readonly DirectoryGroupMember[];
}>;

export type InitializingWorkosProjectionEvent = DirectoryProjectionPage & Readonly<{
    expectedPosition:
        | Readonly<{ eventCursor: string }>
        | Readonly<{ eventCursor: null; eventRangeStart: Date }>;
    eventId: string;
    attemptId?: string;
    deletedPeople?: readonly DirectoryPerson[];
    deletedGroups?: readonly DirectoryGroup[];
    replaceGroupMembers?: readonly Readonly<{
        externalGroupId: string;
    }>[];
}>;

export type InitializingWorkosGroupMemberEventPage = Readonly<{
    sourceId: string;
    reconcileRunId: string;
    expectedPosition: InitializingWorkosProjectionEvent["expectedPosition"];
    eventId: string;
    attemptId: string;
    externalGroupId: string;
    people: readonly DirectoryPerson[];
}>;

function normalizeOptionalText(value: string | undefined): string | null {
    if (value === undefined) return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalEmail(value: string | undefined): string | null {
    return normalizeOptionalText(value)?.toLowerCase() ?? null;
}

function preserveOptionalOpaqueId(value: string | undefined): string | null {
    return value === undefined || value.length === 0 ? null : value;
}

async function applyPerson(tx: Tx, params: DirectoryProjectionPage, person: DirectoryPerson): Promise<void> {
    const externalUpdatedAt = person.externalUpdatedAt ?? null;
    const observation = {
        externalSubjectId: preserveOptionalOpaqueId(person.externalSubjectId),
        normalizedEmail: normalizeOptionalEmail(person.email),
        displayName: normalizeOptionalText(person.displayName),
        externalLogin: normalizeOptionalText(person.login),
        state: person.active ? "active" as const : "suspended" as const,
        externalUpdatedAt,
    };
    await tx.teamProvisionedIdentity.upsert({
        where: {
            directorySourceId_externalUserId: {
                directorySourceId: params.sourceId,
                externalUserId: person.externalUserId,
            },
        },
        create: {
            // The source relation materializes both directorySourceId and its
            // Team discriminator, which keeps any later membership binding on
            // the same Team at the database boundary.
            source: { connect: { id: params.sourceId } },
            externalUserId: person.externalUserId,
            ...observation,
            lastSeenReconcileRunId: params.reconcileRunId,
        },
        update: { lastSeenReconcileRunId: params.reconcileRunId },
    });
    await tx.teamProvisionedIdentity.updateMany({
        where: {
            directorySourceId: params.sourceId,
            externalUserId: person.externalUserId,
            ...(externalUpdatedAt === null
                ? { externalUpdatedAt: null }
                : { OR: [{ externalUpdatedAt: null }, { externalUpdatedAt: { lt: externalUpdatedAt } }] }),
        },
        data: observation,
    });
}

async function applyGroup(tx: Tx, params: DirectoryProjectionPage, group: DirectoryGroup): Promise<void> {
    const externalUpdatedAt = group.externalUpdatedAt ?? null;
    const observation = {
        externalDisplayName: group.displayName,
        state: "active" as const,
        externalUpdatedAt,
    };
    await tx.teamDirectoryGroup.upsert({
        where: {
            directorySourceId_externalGroupId: {
                directorySourceId: params.sourceId,
                externalGroupId: group.externalGroupId,
            },
        },
        create: {
            directorySourceId: params.sourceId,
            externalGroupId: group.externalGroupId,
            ...observation,
            lastSeenReconcileRunId: params.reconcileRunId,
        },
        update: { lastSeenReconcileRunId: params.reconcileRunId },
    });
    await tx.teamDirectoryGroup.updateMany({
        where: {
            directorySourceId: params.sourceId,
            externalGroupId: group.externalGroupId,
            ...(externalUpdatedAt === null
                ? { externalUpdatedAt: null }
                : { OR: [{ externalUpdatedAt: null }, { externalUpdatedAt: { lt: externalUpdatedAt } }] }),
        },
        data: observation,
    });
}

async function applyDeletedPerson(
    tx: Tx,
    params: DirectoryProjectionPage,
    person: DirectoryPerson,
): Promise<void> {
    await applyPerson(tx, params, person);
    const externalUpdatedAt = person.externalUpdatedAt ?? null;
    const deleted = await tx.teamProvisionedIdentity.updateMany({
        where: {
            directorySourceId: params.sourceId,
            externalUserId: person.externalUserId,
            ...(externalUpdatedAt === null
                ? {}
                : { OR: [{ externalUpdatedAt: null }, { externalUpdatedAt: { lte: externalUpdatedAt } }] }),
        },
        data: { state: "deleted", lastSeenReconcileRunId: params.reconcileRunId },
    });
    if (deleted.count === 1) {
        await tx.teamDirectoryGroupMember.deleteMany({
            where: {
                directorySourceId: params.sourceId,
                externalUserId: person.externalUserId,
            },
        });
    }
}

async function applyDeletedGroup(
    tx: Tx,
    params: DirectoryProjectionPage,
    group: DirectoryGroup,
): Promise<void> {
    await applyGroup(tx, params, group);
    const externalUpdatedAt = group.externalUpdatedAt ?? null;
    const deleted = await tx.teamDirectoryGroup.updateMany({
        where: {
            directorySourceId: params.sourceId,
            externalGroupId: group.externalGroupId,
            ...(externalUpdatedAt === null
                ? {}
                : { OR: [{ externalUpdatedAt: null }, { externalUpdatedAt: { lte: externalUpdatedAt } }] }),
        },
        data: { state: "deleted", lastSeenReconcileRunId: params.reconcileRunId },
    });
    if (deleted.count === 1) {
        await tx.teamDirectoryGroupMember.deleteMany({
            where: {
                directorySourceId: params.sourceId,
                externalGroupId: group.externalGroupId,
            },
        });
    }
}

function workosEventStageMarker(eventId: string, attemptId?: string): string {
    return `workos-event:${eventId}:${attemptId ?? "self-contained"}`;
}

async function stageKnownGroupMembers(
    tx: Tx,
    params: Readonly<{
        sourceId: string;
        externalGroupId: string;
        people: readonly DirectoryPerson[];
        marker: string;
        personReconcileRunId: string;
    }>,
): Promise<void> {
    const externalUserIds = [...new Set(params.people.map((person) => person.externalUserId))];
    for (const person of params.people) {
        await applyPerson(tx, {
            sourceId: params.sourceId,
            reconcileRunId: params.personReconcileRunId,
        }, person);
    }
    for (const externalUserId of externalUserIds) {
        await tx.teamDirectoryGroupMember.upsert({
            where: {
                directorySourceId_externalGroupId_externalUserId: {
                    directorySourceId: params.sourceId,
                    externalGroupId: params.externalGroupId,
                    externalUserId,
                },
            },
            create: {
                directorySourceId: params.sourceId,
                externalGroupId: params.externalGroupId,
                externalUserId,
                lastSeenReconcileRunId: params.marker,
            },
            update: { lastSeenReconcileRunId: params.marker },
        });
    }
}

async function replaceGroupMembers(
    tx: Tx,
    params: DirectoryProjectionPage & Readonly<{ attemptId?: string }>,
    replacement: Readonly<{ externalGroupId: string }>,
    eventId: string,
): Promise<void> {
    const marker = workosEventStageMarker(eventId, params.attemptId);
    await tx.teamDirectoryGroupMember.deleteMany({
        where: {
            directorySourceId: params.sourceId,
            externalGroupId: replacement.externalGroupId,
            NOT: { lastSeenReconcileRunId: marker },
        },
    });
    await tx.teamDirectoryGroupMember.updateMany({
        where: {
            directorySourceId: params.sourceId,
            externalGroupId: replacement.externalGroupId,
            lastSeenReconcileRunId: marker,
        },
        data: { lastSeenReconcileRunId: params.reconcileRunId },
    });
}

async function applyProjectionPageInTx(tx: Tx, params: DirectoryProjectionPage): Promise<void> {
    for (const person of params.people ?? []) await applyPerson(tx, params, person);
    for (const group of params.groups ?? []) await applyGroup(tx, params, group);
    for (const member of params.groupMembers ?? []) {
        await tx.teamDirectoryGroupMember.upsert({
            where: {
                directorySourceId_externalGroupId_externalUserId: {
                    directorySourceId: params.sourceId,
                    externalGroupId: member.externalGroupId,
                    externalUserId: member.externalUserId,
                },
            },
            create: {
                directorySourceId: params.sourceId,
                externalGroupId: member.externalGroupId,
                externalUserId: member.externalUserId,
                lastSeenReconcileRunId: params.reconcileRunId,
            },
            update: { lastSeenReconcileRunId: params.reconcileRunId },
        });
    }
}

async function applyWorkosProjectionEventInTx(
    tx: Tx,
    params: InitializingWorkosProjectionEvent,
    eventId: string,
): Promise<void> {
    await applyProjectionPageInTx(tx, params);
    for (const person of params.deletedPeople ?? []) await applyDeletedPerson(tx, params, person);
    for (const group of params.deletedGroups ?? []) await applyDeletedGroup(tx, params, group);
    for (const replacement of params.replaceGroupMembers ?? []) {
        await replaceGroupMembers(tx, params, replacement, eventId);
    }
}

export async function commitInitializingWorkosProjectionEvent(
    _params: InitializingWorkosProjectionEvent,
): Promise<DirectoryProjectionWriteResult> {
    const params = _params;
    const eventId = params.eventId.trim();
    if (eventId.length === 0) throw new TypeError("WorkOS event ID must be non-empty");
    return await inTx(async (tx): Promise<DirectoryProjectionWriteResult> => {
        if (!await isDirectorySourceKindAllowedInTx(tx, "workos_directory")) {
            return { applied: false, reason: "stale_run" };
        }
        const position = params.expectedPosition.eventCursor === null
            ? { eventCursor: null, eventRangeStart: params.expectedPosition.eventRangeStart }
            : { eventCursor: params.expectedPosition.eventCursor };
        const sourceWhere = {
            id: params.sourceId,
            kind: "workos_directory" as const,
            state: "initializing" as const,
            activeReconcileRunId: params.reconcileRunId,
            ...position,
        };
        const current = await tx.teamDirectorySource.findFirst({
            where: sourceWhere,
            select: { id: true },
        });
        if (!current) return { applied: false, reason: "stale_run" };

        await applyWorkosProjectionEventInTx(tx, params, eventId);
        const advanced = await tx.teamDirectorySource.updateMany({
            where: sourceWhere,
            data: { eventCursor: eventId, eventRangeStart: null },
        });
        if (advanced.count !== 1) {
            // A concurrent replacement must roll back the projection writes from
            // this event rather than committing them without its opaque cursor.
            throw new StaleProjectionRunError();
        }
        return { applied: true };
    }, { isolationLevel: "ReadCommitted" /* The final full source/run/position CAS rolls back every child write when stale. */ }).catch((error: unknown) => {
        if (error instanceof StaleProjectionRunError) return { applied: false, reason: "stale_run" };
        throw error;
    });
}

/**
 * Stage one bounded current-membership page without advancing the WorkOS
 * cursor. The final event transaction removes rows not stamped by this event,
 * restores the reconcile-run stamp, and advances the cursor atomically.
 */
export async function stageInitializingWorkosGroupMemberEventPage(
    params: InitializingWorkosGroupMemberEventPage,
): Promise<DirectoryProjectionWriteResult> {
    const eventId = params.eventId.trim();
    if (eventId.length === 0) throw new TypeError("WorkOS event ID must be non-empty");
    return await inTx(async (tx): Promise<DirectoryProjectionWriteResult> => {
        if (!await isDirectorySourceKindAllowedInTx(tx, "workos_directory")) {
            return { applied: false, reason: "stale_run" };
        }
        const position = params.expectedPosition.eventCursor === null
            ? { eventCursor: null, eventRangeStart: params.expectedPosition.eventRangeStart }
            : { eventCursor: params.expectedPosition.eventCursor };
        const current = await tx.teamDirectorySource.findFirst({
            where: {
                id: params.sourceId,
                kind: "workos_directory",
                state: "initializing",
                activeReconcileRunId: params.reconcileRunId,
                ...position,
            },
            select: { id: true },
        });
        if (!current) return { applied: false, reason: "stale_run" };

        await stageKnownGroupMembers(tx, {
            sourceId: params.sourceId,
            externalGroupId: params.externalGroupId,
            people: params.people,
            marker: workosEventStageMarker(eventId, params.attemptId),
            personReconcileRunId: params.reconcileRunId,
        });
        return { applied: true };
    }, { isolationLevel: "Serializable" /* A source/run read must remain current throughout staged child projection writes. */ });
}

export async function stageActiveWorkosGroupMemberEventPage(
    params: Omit<InitializingWorkosGroupMemberEventPage, "reconcileRunId">,
): Promise<DirectoryProjectionWriteResult> {
    const eventId = params.eventId.trim();
    if (eventId.length === 0) throw new TypeError("WorkOS event ID must be non-empty");
    return await inTx(async (tx): Promise<DirectoryProjectionWriteResult> => {
        if (!await isDirectorySourceKindAllowedInTx(tx, "workos_directory")) {
            return { applied: false, reason: "stale_run" };
        }
        const position = params.expectedPosition.eventCursor === null
            ? { eventCursor: null, eventRangeStart: params.expectedPosition.eventRangeStart }
            : { eventCursor: params.expectedPosition.eventCursor };
        await tx.teamDirectorySource.updateMany({
            where: {
                id: params.sourceId,
                kind: "workos_directory",
                state: "active",
                activeReconcileRunId: null,
                manualSyncRequestedAt: null,
                ...position,
            },
            data: {
                activeReconcileRunId: params.attemptId,
                activeReconcileStartedAt: new Date(),
            },
        });
        const current = await tx.teamDirectorySource.findFirst({
            where: {
                id: params.sourceId,
                kind: "workos_directory",
                state: "active",
                activeReconcileRunId: params.attemptId,
                manualSyncRequestedAt: null,
                ...position,
            },
            select: { id: true },
        });
        if (!current) return { applied: false, reason: "stale_run" };

        await stageKnownGroupMembers(tx, {
            sourceId: params.sourceId,
            externalGroupId: params.externalGroupId,
            people: params.people,
            marker: workosEventStageMarker(eventId, params.attemptId),
            personReconcileRunId: workosEventStageMarker(eventId, params.attemptId),
        });
        return { applied: true };
    }, { isolationLevel: "Serializable" /* Later staged pages must remain in the same active source/run as their child writes. */ });
}

class StaleProjectionRunError extends Error {}
/**
 * A projection write found its own ownership model broken — a bound identity
 * that lost its source, a Group binding that disappeared mid-reconcile. Retrying
 * the same provider read cannot repair any of these, so the worker classifies it
 * as a non-retryable source refusal rather than an upstream outage.
 */
export class DirectoryProjectionInvariantError extends Error {}

async function hasCurrentProjectionRun(tx: Tx, params: Pick<DirectoryProjectionPage, "sourceId" | "reconcileRunId">) {
    const source = await tx.teamDirectorySource.findFirst({
        where: {
            id: params.sourceId,
            state: "initializing",
            activeReconcileRunId: params.reconcileRunId,
        },
        select: { kind: true },
    });
    return source !== null && await isDirectorySourceKindAllowedInTx(tx, source.kind);
}

export async function commitDirectoryProjectionPage(params: DirectoryProjectionPage): Promise<DirectoryProjectionWriteResult> {
    return await inTx(async (tx): Promise<DirectoryProjectionWriteResult> => {
        if (!await hasCurrentProjectionRun(tx, params)) return { applied: false, reason: "stale_run" };
        await applyProjectionPageInTx(tx, params);
        return { applied: true };
    }, { isolationLevel: "Serializable" /* A source/run read must remain current throughout child projection writes. */ });
}

export async function finalizeDirectoryProjection(params: Readonly<{
    sourceId: string;
    reconcileRunId: string;
}>): Promise<DirectoryProjectionWriteResult> {
    return await inTx(async (tx) => {
        if (!await hasCurrentProjectionRun(tx, params)) return { applied: false, reason: "stale_run" };
        await tx.teamDirectoryGroupMember.deleteMany({
            where: {
                directorySourceId: params.sourceId,
                OR: [
                    { lastSeenReconcileRunId: null },
                    { lastSeenReconcileRunId: { not: params.reconcileRunId } },
                ],
            },
        });
        await tx.teamProvisionedIdentity.updateMany({
            where: {
                directorySourceId: params.sourceId,
                OR: [
                    { lastSeenReconcileRunId: null },
                    { lastSeenReconcileRunId: { not: params.reconcileRunId } },
                ],
            },
            data: { state: "deleted" },
        });
        await tx.teamDirectoryGroup.updateMany({
            where: {
                directorySourceId: params.sourceId,
                OR: [
                    { lastSeenReconcileRunId: null },
                    { lastSeenReconcileRunId: { not: params.reconcileRunId } },
                ],
            },
            data: { state: "deleted" },
        });
        return { applied: true };
    }, { isolationLevel: "Serializable" /* Finalization removes stale child rows only for the observed current source/run. */ });
}

type NativeDirectoryProjectionContext = Readonly<{
    teamId: string;
    team: Readonly<{ defaultSessionHistoryAccess: import("@/storage/enums.generated").SessionHistoryAccess }>;
}>;

/**
 * Applying one source's facts for named Accounts only. Sign-in binding uses it
 * so admitting one person never rewrites a whole directory inside an
 * interactive transaction; Group metadata stays with the reconciler, which is
 * the only owner of a complete observation.
 */
type NativeDirectoryProjectionScope = Readonly<{ accountIds: readonly string[] }>;

/** Reports whether the delta it applied already woke the Team's readers. */
async function applyNativeDirectoryFactsInTx(
    tx: Tx,
    current: NativeDirectoryProjectionContext,
    sourceId: string,
    scope?: NativeDirectoryProjectionScope,
): Promise<boolean> {
    const identities = await tx.teamProvisionedIdentity.findMany({
        where: {
            directorySourceId: sourceId,
            boundAccountId: scope ? { in: [...scope.accountIds] } : { not: null },
        },
        select: {
            externalUserId: true,
            boundAccountId: true,
            state: true,
        },
    });
    const bindings = await tx.teamExternalGroupBinding.findMany({
        where: { directorySourceId: sourceId },
        select: {
            id: true,
            teamGroupId: true,
            externalGroupId: true,
            group: { select: { memberships: { select: { teamMembership: { select: { accountId: true } } } } } },
        },
    });
    const accountIds = scope
        ? [...scope.accountIds]
        : [
            ...identities.flatMap(identity => identity.boundAccountId ?? []),
            ...bindings.flatMap(binding => binding.group.memberships.map(member => member.teamMembership.accountId)),
        ];
    const inScope = (accountId: string) => scope === undefined || scope.accountIds.includes(accountId);
    // The whole delta is one Team change. Every leaf below is told not to
    // publish, the affected Accounts are accumulated, and the audience is
    // woken exactly once at the end instead of once per materialized row.
    const changedAccountIds = new Set<string>();
    let teamChanged = false;
    await withTeamSessionAccessEffectsInTx(tx, { teamId: current.teamId, accountIds }, async (sessionAccessImpacts) => {
        for (const identity of identities) {
            if (!identity.boundAccountId) continue;
            const applied = await applyExternalTeamMembershipInTx(tx, {
                teamId: current.teamId,
                accountId: identity.boundAccountId,
                source: {
                    kind: "directory_source",
                    directorySourceId: sourceId,
                    externalUserId: identity.externalUserId,
                },
                desired: identity.state === "deleted" ? "absent" : identity.state,
                historyAccess: current.team.defaultSessionHistoryAccess,
                sessionAccessImpacts,
                publishChange: false,
            });
            if (applied.status === "source_not_found") {
                throw new DirectoryProjectionInvariantError("bound identity lost its directory source");
            }
            // Only a corrupt binding — an identity whose manager pointer names
            // somebody else's membership — is an invariant here. A membership
            // native administration or another directory owns answers
            // `managed_elsewhere`: no lifetime change, and this source's own
            // Group rosters are still materialized against it below.
            if (applied.status === "management_conflict") {
                throw new DirectoryProjectionInvariantError("bound identity disagrees with its Team membership owner");
            }
            // An archived Team deliberately suppresses new admission while
            // retained removals in the same complete observation still apply.
            if (applied.status === "team_archived") continue;
            if (applied.status === "applied") {
                teamChanged = true;
                changedAccountIds.add(applied.accountId);
            }
        }

        for (const binding of bindings) {
            const projectedGroup = await tx.teamDirectoryGroup.findUnique({
                where: {
                    directorySourceId_externalGroupId: {
                        directorySourceId: sourceId,
                        externalGroupId: binding.externalGroupId,
                    },
                },
                select: { state: true, externalDisplayName: true },
            });
            if (!scope) {
                if (!projectedGroup || projectedGroup.state !== "active") {
                    const removed = await removeExternalGroupBindingInTx(tx, {
                        teamId: current.teamId,
                        bindingId: binding.id,
                        sessionAccessImpacts,
                        publishChange: false,
                    });
                    if (removed.status === "already_absent") {
                        throw new DirectoryProjectionInvariantError("directory Group binding disappeared during reconciliation");
                    }
                    teamChanged = true;
                    for (const accountId of removed.affectedAccountIds) changedAccountIds.add(accountId);
                    continue;
                }
                const metadata = await applyExternalManagedGroupInTx(tx, {
                    teamId: current.teamId,
                    externalGroupBindingId: binding.id,
                    desired: "active",
                    sessionAccessImpacts,
                    sourceDisplayName: projectedGroup.externalDisplayName,
                    publishChange: false,
                });
                if (metadata.status === "binding_not_found") {
                    throw new DirectoryProjectionInvariantError("directory Group binding lost its target");
                }
                if (metadata.status === "applied") teamChanged = true;
            } else if (projectedGroup?.state !== "active") {
                // A Group the last complete observation did not confirm cannot
                // contribute a roster member during sign-in.
                continue;
            }

            const projectedMembers = await tx.teamDirectoryGroupMember.findMany({
                where: {
                    directorySourceId: sourceId,
                    externalGroupId: binding.externalGroupId,
                    // The bound Account is the whole address: natively
                    // managed and second-source people keep contributing.
                    // A deactivated person does so only while this source
                    // owns (and so suspends) their lifetime; otherwise the
                    // existing contribution is withdrawn below.
                    identity: directoryGroupContributorIdentityWhere(),
                },
                select: { identity: { select: { boundAccountId: true } } },
            });
            const desiredAccountIds = new Set(
                projectedMembers
                    .flatMap((member) => member.identity.boundAccountId ?? [])
                    .filter(inScope),
            );
            // Team removal above cascades its contributions. Read the surviving
            // roster now, while the access before-state remains the outer capture.
            const currentContributions = await tx.teamGroupMembershipExternalContribution.findMany({
                where: { externalGroupBindingId: binding.id },
                select: { membership: { select: { teamMembership: { select: { accountId: true } } } } },
            });
            const existingAccountIds = new Set(
                currentContributions
                    .map((contribution) => contribution.membership.teamMembership.accountId)
                    .filter(inScope),
            );
            for (const accountId of desiredAccountIds) {
                const contribution = await applyExternalGroupContributionInTx(tx, {
                    teamId: current.teamId,
                    groupId: binding.teamGroupId,
                    accountId,
                    externalGroupBindingId: binding.id,
                    desired: "present",
                    historyAccess: current.team.defaultSessionHistoryAccess,
                    sessionAccessImpacts,
                    publishChange: false,
                });
                // An archived native target retains no dormant new member. Its
                // projection stays current and a later active reconciliation
                // may materialize the relationship after explicit restore.
                if (contribution.status === "group_archived") continue;
                // A projected person whose Team lifetime nobody has created —
                // or whose owning source has just offboarded them — contributes
                // nothing. Group rosters hang on the membership; they never
                // invent one.
                if (contribution.status === "not_team_member") continue;
                if (contribution.status !== "ok") {
                    throw new DirectoryProjectionInvariantError("directory Group contribution lost its binding or Team membership");
                }
                if (contribution.outcome !== "unchanged") {
                    teamChanged = true;
                    changedAccountIds.add(accountId);
                }
            }
            for (const accountId of existingAccountIds) {
                if (desiredAccountIds.has(accountId)) continue;
                const contribution = await applyExternalGroupContributionInTx(tx, {
                    teamId: current.teamId,
                    groupId: binding.teamGroupId,
                    accountId,
                    externalGroupBindingId: binding.id,
                    desired: "absent",
                    historyAccess: current.team.defaultSessionHistoryAccess,
                    sessionAccessImpacts,
                    publishChange: false,
                });
                if (contribution.status !== "ok") {
                    throw new DirectoryProjectionInvariantError("existing directory Group contribution became invalid");
                }
                if (contribution.outcome !== "unchanged") {
                    teamChanged = true;
                    changedAccountIds.add(accountId);
                }
            }
        }
    });
    if (!teamChanged) return false;
    await publishTeamChangedInTx(tx, {
        teamId: current.teamId,
        additionalAccountIds: [...changedAccountIds],
    });
    return true;
}

/**
 * Materialize one Account's share of a directory source's committed evidence.
 *
 * Readiness is the gate: only a source that is `active` with no outstanding
 * full-run token has a complete validated projection, so an interrupted import
 * or repair can never turn a staged observation into access — not through
 * sign-in, and not through a later binding edit. The write itself goes through
 * the same canonical external-fact owners the reconciler uses.
 */
export async function applyReadyDirectorySourceFactsForAccountInTx(
    tx: Tx,
    params: Readonly<{ sourceId: string; teamId: string; accountId: string }>,
): Promise<boolean> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: params.teamId, accountIds: [params.accountId], affectedAccountIds: [params.accountId], membershipChange: { kind: "teamMembership", teamId: params.teamId } });
    const current = await tx.teamDirectorySource.findFirst({
        where: {
            id: params.sourceId,
            teamId: params.teamId,
        },
        select: {
            id: true,
            teamId: true,
            kind: true,
            state: true,
            activeReconcileRunId: true,
            team: { select: { defaultSessionHistoryAccess: true } },
        },
    });
    if (!current) return false;
    if (!await isDirectorySourceCompletedEvidenceAllowedInTx(tx, current)) return false;
    await applyNativeDirectoryFactsInTx(tx, current, params.sourceId, { accountIds: [params.accountId] });
    return true;
}

export async function commitActiveWorkosProjectionEvent(
    params: Omit<InitializingWorkosProjectionEvent, "reconcileRunId"> & Readonly<{
        completedAt?: Date;
        expectedCurrentness?: ExpectedDirectorySourceCurrentness;
        env?: NodeJS.ProcessEnv;
    }>,
): Promise<DirectoryProjectionWriteResult> {
    const eventId = params.eventId.trim();
    if (eventId.length === 0) throw new TypeError("WorkOS event ID must be non-empty");
    const completedAt = params.completedAt ?? new Date();
    return await inTx(async (tx): Promise<DirectoryProjectionWriteResult> => {
        const admission = await acquireExternalSourceAccountAdmissionInTx(tx, { owner: { kind: "directory_source", directorySourceId: params.sourceId } });
        if (!admission) return { applied: false, reason: "stale_run" };
        await acquireTeamMutationLockInTx(tx, admission.teamId);
        await admission.recheck();
        if (!await isDirectorySourceAllowedInTx(tx, { id: params.sourceId, kind: "workos_directory" }, params.expectedCurrentness, params.env)) {
            return { applied: false, reason: "stale_run" };
        }
        const position = params.expectedPosition.eventCursor === null
            ? { eventCursor: null, eventRangeStart: params.expectedPosition.eventRangeStart }
            : { eventCursor: params.expectedPosition.eventCursor };
        const sourceWhere = {
            id: params.sourceId,
            kind: "workos_directory" as const,
            state: "active" as const,
            activeReconcileRunId: params.attemptId ?? null,
            manualSyncRequestedAt: null,
            ...position,
        };
        const current = await tx.teamDirectorySource.findFirst({
            where: sourceWhere,
            select: {
                id: true,
                teamId: true,
                state: true,
                lastErrorCode: true,
                team: { select: { defaultSessionHistoryAccess: true } },
            },
        });
        if (!current) return { applied: false, reason: "stale_run" };

        await applyWorkosProjectionEventInTx(tx, {
            ...params,
            reconcileRunId: workosEventStageMarker(eventId, params.attemptId),
        }, eventId);
        const published = await applyNativeDirectoryFactsInTx(tx, current, params.sourceId);
        const advanced = await tx.teamDirectorySource.updateMany({
            where: sourceWhere,
            data: {
                eventCursor: eventId,
                eventRangeStart: null,
                activeReconcileRunId: null,
                activeReconcileStartedAt: null,
                lastSuccessAt: completedAt,
                lastErrorCode: null,
                consecutiveFailureCount: 0,
                retryNotBefore: null,
            },
        });
        if (advanced.count !== 1) throw new StaleProjectionRunError();
        // An applied event is an upstream person, Group or roster change the
        // directory People/Groups lists show even when it changes no native
        // fact (an unbound person, an unmapped Group). It is driven by upstream
        // change, not a timer, so wake the Team once for it.
        if (!published) await publishTeamChangedInTx(tx, { teamId: current.teamId });
        return { applied: true };
    }, { isolationLevel: "ReadCommitted" /* The outer Team guard owns the roster/binding union; the final source CAS rejects stale event positions. */ }).catch((error: unknown) => {
        if (error instanceof StaleProjectionRunError) return { applied: false, reason: "stale_run" };
        throw error;
    });
}

export async function completeActiveWorkosEmptyPoll(params: Readonly<{
    sourceId: string;
    expectedPosition: InitializingWorkosProjectionEvent["expectedPosition"];
    completedAt?: Date;
    expectedCurrentness?: ExpectedDirectorySourceCurrentness;
    env?: NodeJS.ProcessEnv;
}>): Promise<DirectoryProjectionWriteResult> {
    const completedAt = params.completedAt ?? new Date();
    const position = params.expectedPosition.eventCursor === null
        ? { eventCursor: null, eventRangeStart: params.expectedPosition.eventRangeStart }
        : { eventCursor: params.expectedPosition.eventCursor };
    return await inTx(async (tx) => {
        if (!await isDirectorySourceAllowedInTx(tx, { id: params.sourceId, kind: "workos_directory" }, params.expectedCurrentness, params.env)) {
            return { applied: false, reason: "stale_run" };
        }
        const where = {
            id: params.sourceId,
            kind: "workos_directory" as const,
            state: "active" as const,
            activeReconcileRunId: null,
            manualSyncRequestedAt: null,
            ...position,
        };
        const before = await tx.teamDirectorySource.findFirst({
            where,
            select: { teamId: true, kind: true, state: true, lastErrorCode: true, lastSuccessAt: true },
        });
        if (!before) return { applied: false, reason: "stale_run" };
        const updated = await tx.teamDirectorySource.updateMany({
            where,
            data: {
                lastSuccessAt: completedAt,
                lastErrorCode: null,
                consecutiveFailureCount: 0,
                retryNotBefore: null,
            },
        });
        if (updated.count !== 1) return { applied: false, reason: "stale_run" };
        // A poll on an already-fresh source only moves the success horizon on
        // a timer, and waking every Team reader for that is pure fanout. A poll
        // that makes a stale or never-synced source fresh changes the shown
        // freshness, and clearing a recorded failure is the recovery an
        // administrator is watching for.
        if (projectDirectorySyncFreshness(before, completedAt) !== "fresh") {
            await publishTeamChangedInTx(tx, { teamId: before.teamId });
        } else {
            await publishDirectorySourceStatusTransitionInTx(tx, {
                teamId: before.teamId,
                before,
                after: { state: before.state, lastErrorCode: null },
            });
        }
        return { applied: true };
    }, { isolationLevel: "ReadCommitted" /* The full state/run/manual-request/position CAS admits this source-only completion. */ });
}

/**
 * Atomically activate one complete projection and its native effects.
 *
 * Projection rows remain evidence. Account bindings and Group bindings are the
 * only bridges into native authorization, and every mutation crosses the
 * canonical external-fact adapters before the source's success cursor becomes
 * visible. A failed transaction therefore publishes neither partial access nor
 * a success marker for access that was not applied.
 */
export async function completeDirectoryProjection(params: Readonly<{
    sourceId: string;
    reconcileRunId: string;
    observedManualSyncRequestedAt: Date | null;
    completedAt?: Date;
    expectedCurrentness?: ExpectedDirectorySourceCurrentness;
    env?: NodeJS.ProcessEnv;
}>): Promise<DirectoryProjectionWriteResult> {
    const completedAt = params.completedAt ?? new Date();
    return await inTx(async (tx): Promise<DirectoryProjectionWriteResult> => {
        const admission = await acquireExternalSourceAccountAdmissionInTx(tx, { owner: { kind: "directory_source", directorySourceId: params.sourceId } });
        if (!admission) return { applied: false, reason: "stale_run" };
        await acquireTeamMutationLockInTx(tx, admission.teamId);
        await admission.recheck();
        const current = await tx.teamDirectorySource.findFirst({
            where: {
                id: params.sourceId,
                state: "initializing",
                activeReconcileRunId: params.reconcileRunId,
            },
            select: {
                id: true,
                teamId: true,
                kind: true,
                state: true,
                lastErrorCode: true,
                manualSyncRequestedAt: true,
                team: { select: { defaultSessionHistoryAccess: true } },
            },
        });
        if (!current) return { applied: false, reason: "stale_run" };
        if (!await isDirectorySourceAllowedInTx(tx, current, params.expectedCurrentness, params.env)) {
            return { applied: false, reason: "stale_run" };
        }

        await tx.teamDirectoryGroupMember.deleteMany({
            where: {
                directorySourceId: params.sourceId,
                OR: [
                    { lastSeenReconcileRunId: null },
                    { lastSeenReconcileRunId: { not: params.reconcileRunId } },
                ],
            },
        });
        await tx.teamProvisionedIdentity.updateMany({
            where: {
                directorySourceId: params.sourceId,
                OR: [
                    { lastSeenReconcileRunId: null },
                    { lastSeenReconcileRunId: { not: params.reconcileRunId } },
                ],
            },
            data: { state: "deleted" },
        });
        await tx.teamDirectoryGroup.updateMany({
            where: {
                directorySourceId: params.sourceId,
                OR: [
                    { lastSeenReconcileRunId: null },
                    { lastSeenReconcileRunId: { not: params.reconcileRunId } },
                ],
            },
            data: { state: "deleted" },
        });

        const published = await applyNativeDirectoryFactsInTx(tx, current, params.sourceId);

        const clearObservedManualRequest = params.observedManualSyncRequestedAt !== null
            && current.manualSyncRequestedAt !== null
            && current.manualSyncRequestedAt.getTime() <= params.observedManualSyncRequestedAt.getTime();
        const completed = await tx.teamDirectorySource.updateMany({
            where: {
                id: params.sourceId,
                state: "initializing",
                activeReconcileRunId: params.reconcileRunId,
            },
            data: {
                state: "active",
                activeReconcileRunId: null,
                activeReconcileStartedAt: null,
                lastSuccessAt: completedAt,
                lastFullReconcileAt: completedAt,
                lastErrorCode: null,
                consecutiveFailureCount: 0,
                retryNotBefore: null,
                ...(clearObservedManualRequest ? { manualSyncRequestedAt: null } : {}),
            },
        });
        if (completed.count !== 1) throw new StaleProjectionRunError();
        // `initializing -> active` is always a status transition, so a complete
        // reconciliation wakes the Team's readers even when the observation
        // changed no native fact.
        if (!published) {
            await publishDirectorySourceStatusTransitionInTx(tx, {
                teamId: current.teamId,
                before: current,
                after: { state: "active", lastErrorCode: null },
            });
        }
        return { applied: true };
    }, { isolationLevel: "ReadCommitted" /* The outer Team guard owns contribution effects; the final run CAS rejects pause/reset while preserving newer requests. */ }).catch((error: unknown) => {
        if (error instanceof StaleProjectionRunError) return { applied: false, reason: "stale_run" };
        throw error;
    });
}
