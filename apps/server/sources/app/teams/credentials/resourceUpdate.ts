import { isDeepStrictEqual } from "node:util";
import { z } from 'zod/mini';
import { TeamCredentialDisclosureCeilingV1Schema, TeamCredentialSessionUsePolicyV1Schema, TeamCredentialRequestPolicyV1Schema, TeamCredentialBrokerPlacementV1Schema, TeamCredentialResourceReplacementV1Schema, TeamCredentialResourceUpdateInputV1Schema, TeamCredentialDeliveryModeV1Schema, narrowTeamCredentialDeliveryModeToBrokeredOnlyV1, type TeamCredentialDeliveryModeV1, type TeamCredentialDisclosureCeilingV1, type TeamCredentialSessionUsePolicyV1, type TeamCredentialRequestPolicyV1, type TeamCredentialBrokerPlacementV1, type TeamCredentialResourceReplacementV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { acquireTeamMembershipAccountAdmissionInTx } from "../memberships/membershipService";
import { AccountStatus } from "@/storage/enums.generated";
import { acquireTeamMutationLockInTx, resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { publishTeamChangedInTx } from "../teamChanges";
import { recordTeamCredentialActivityInTx } from "./resourceActivity";
import { readTeamCredentialBrokerPlacement, validateTeamCredentialBrokerPlacementForSaveInTx } from "./brokerPlacementResolver";
import { qualifyTeamCredentialOperationInTx } from "./resourceRead";
import { resolveTeamCredentialResourceSourceInTx } from "./resourceSourceResolver";
import { validateTeamCredentialAudienceDraftInTx } from "./resourceAudience";
import { retainEntitledTeamCredentialRecipientMaterialInTx } from "./recipientMaterial";
import { validateTeamCredentialUsageLimitDraftInTx } from "./resourceLimits";
import {
    findTeamCredentialUsageLimitCapabilityRefusal,
    resolveCurrentTeamCredentialUsageCapabilitiesForResource,
} from "./usageCapabilities";
import {
    isTeamCredentialRequestPolicySupportEvidenceCurrent,
    normalizeTeamCredentialRequestPolicyForPersistence,
    type TeamCredentialRequestPolicySupportEvidence,
} from "./resourceRequestPolicySupport";

export type UpdateTeamCredentialResourceInput = Readonly<{
    resourceId: string; expectedRevision: number; displayName?: string; enabled?: boolean;
    disclosureCeiling?: TeamCredentialDisclosureCeilingV1;
    sessionUsePolicy?: TeamCredentialSessionUsePolicyV1;
    brokerPlacement?: TeamCredentialBrokerPlacementV1 | null;
    requestPolicy?: TeamCredentialRequestPolicyV1 | null;
    replacement?: TeamCredentialResourceReplacementV1;
}>;

export type UpdateTeamCredentialResourceResult =
    | Readonly<{ ok: true; resourceId: string; revision: number }>
    | Readonly<{ ok: false; error: "resource_not_found" | "resource_forbidden" | "resource_changed" | "invalid_resource_input" | "invalid_audience" | "invalid_limit" | "subject_not_in_team" | "token_limit_unavailable" | "cost_limit_unavailable" | "source_replaced_or_missing" | "disclosure_not_allowed" | "broker_unavailable" | "update_required" | "resource_corrupt" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

function parseJson(value: string | null): unknown {
    if (value === null) return null;
    try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function sortedAudience<T extends { deliveryMode: string }>(rows: readonly T[], id: keyof T): readonly (readonly string[])[] {
    return rows.map((row) => [String(row[id]), row.deliveryMode] as const)
        .sort(([left], [right]) => left.localeCompare(right));
}

type ResourceAudience = Pick<TeamCredentialResourceReplacementV1, "allMembersDeliveryMode" | "groupGrants" | "memberGrants">;

/**
 * Applies the protocol's one narrowing rule to a whole audience: the direct
 * half of every grant ends and the broker half stays, so a replacement that
 * narrows the ceiling withdraws exactly what the source-owner PATCH below
 * withdraws. Deliberately authored broker grants pass through unchanged.
 */
function narrowAudienceToBrokeredOnly(audience: ResourceAudience): ResourceAudience {
    const narrowGrant = <T extends { deliveryMode: TeamCredentialDeliveryModeV1 }>(grant: T): T[] => {
        const deliveryMode = narrowTeamCredentialDeliveryModeToBrokeredOnlyV1(grant.deliveryMode);
        return deliveryMode === null ? [] : [{ ...grant, deliveryMode }];
    };
    return {
        allMembersDeliveryMode: narrowTeamCredentialDeliveryModeToBrokeredOnlyV1(audience.allMembersDeliveryMode),
        groupGrants: audience.groupGrants.flatMap(narrowGrant),
        memberGrants: audience.memberGrants.flatMap(narrowGrant),
    };
}

async function applyResourceReplacementInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        authentication: TeamOperationAuthenticationContext;
        resource: NonNullable<Awaited<ReturnType<Tx["teamCredentialResource"]["findUnique"]>>>;
        expectedRevision: number;
        replacement: TeamCredentialResourceReplacementV1;
        requestPolicySupport?: TeamCredentialRequestPolicySupportEvidence;
    }>,
): Promise<UpdateTeamCredentialResourceResult> {
    const parsedReplacement = TeamCredentialResourceReplacementV1Schema.safeParse(input.replacement);
    if (!parsedReplacement.success) return { ok: false, error: "invalid_resource_input" };
    const replacement = parsedReplacement.data;
    const resource = input.resource;
    if (resource.revision !== input.expectedRevision) return { ok: false, error: "resource_changed" };

    const storedSource = readTeamCredentialSourceBinding(resource.sourceBindingJson);
    const storedPolicy = parseJson(resource.requestPolicyJson);
    const storedCeiling = TeamCredentialDisclosureCeilingV1Schema.safeParse(resource.disclosureCeiling);
    const storedSessionPolicy = TeamCredentialSessionUsePolicyV1Schema.safeParse(resource.sessionUsePolicy);
    const storedRequestPolicy = z.nullable(TeamCredentialRequestPolicyV1Schema).safeParse(storedPolicy);
    const storedPlacement = readTeamCredentialBrokerPlacement(resource);
    if (!storedSource.success || !storedCeiling.success || !storedSessionPolicy.success
        || !storedRequestPolicy.success || !storedPlacement.ok) {
        return { ok: false, error: "resource_corrupt" };
    }

    const actor = await resolveTeamActorContextInTx(tx, {
        teamId: resource.teamId,
        actorAccountId: input.actorAccountId,
    });
    const capabilities = actor === null
        ? null
        : resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt });
    const canManageStructurally = capabilities?.manageCredentials === true;
    const isCustodian = resource.custodianAccountId === input.actorAccountId;
    const custodianAccount = isCustodian
        ? await tx.account.findUnique({ where: { id: input.actorAccountId }, select: { status: true } })
        : null;
    const isActiveCustodian = custodianAccount?.status === AccountStatus.active;
    const canActAsCustodian = isCustodian
        && isActiveCustodian
        && capabilities?.offerOwnCredential === true;
    if (!canManageStructurally && !canActAsCustodian) {
        return { ok: false, error: "resource_forbidden" };
    }

    const [currentGroups, currentMembers, currentLimits] = await Promise.all([
        tx.teamCredentialGroupGrant.findMany({
            where: { resourceId: resource.id },
            select: { teamGroupId: true, deliveryMode: true },
        }),
        tx.teamCredentialMemberGrant.findMany({
            where: { resourceId: resource.id },
            select: { teamMembershipId: true, deliveryMode: true },
        }),
        tx.teamCredentialUsageLimit.findMany({ where: { resourceId: resource.id } }),
    ]);
    const audienceChanged = resource.allMembersDeliveryMode !== replacement.allMembersDeliveryMode
        || !isDeepStrictEqual(
            sortedAudience(currentGroups, "teamGroupId"),
            sortedAudience(replacement.groupGrants, "teamGroupId"),
        )
        || !isDeepStrictEqual(
            sortedAudience(currentMembers, "teamMembershipId"),
            sortedAudience(replacement.memberGrants, "teamMembershipId"),
        );
    const managerOwnedChanged = resource.enabled !== replacement.enabled
        || resource.displayName !== replacement.displayName.trim()
        || resource.sessionUsePolicy !== replacement.sessionUsePolicy
        || !isDeepStrictEqual(storedRequestPolicy.data, replacement.requestPolicy)
        || audienceChanged
        || replacement.usageLimitDelta.upserts.length > 0
        || replacement.usageLimitDelta.deleteIds.length > 0;
    const requestPolicyChanged = !isDeepStrictEqual(storedRequestPolicy.data, replacement.requestPolicy);

    type QualificationResult = Awaited<ReturnType<typeof qualifyTeamCredentialOperationInTx>>
        | Readonly<{ ok: false; error: "resource_forbidden" }>;
    let qualification: QualificationResult | undefined;
    const qualify = async (): Promise<QualificationResult> => {
        if (qualification !== undefined) return qualification;
        qualification = actor === null
            ? { ok: false as const, error: "resource_forbidden" as const }
            : await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
        return qualification;
    };
    if (managerOwnedChanged) {
        if (!canManageStructurally) return { ok: false, error: "resource_forbidden" };
        const managerQualification = await qualify();
        if (!managerQualification.ok) return managerQualification;
    }

    const custodianBlock = replacement.custodian;
    if (custodianBlock !== undefined) {
        if (!canActAsCustodian || actor === null) {
            return { ok: false, error: "resource_forbidden" };
        }
        const custodianQualification = await qualify();
        if (!custodianQualification.ok) return custodianQualification;
    }
    const nextSource = custodianBlock?.source ?? storedSource.data;
    const nextCeiling = custodianBlock?.disclosureCeiling ?? storedCeiling.data;
    const nextPlacement = custodianBlock === undefined ? storedPlacement.placement : custodianBlock.brokerPlacement;
    // The audience a custodian cannot edit arrives unchanged, so narrowing is
    // applied here rather than trusted to the caller: the persisted audience is
    // the one this narrowing leaves, never a direct grant under brokered_only.
    const nextAudience = storedCeiling.data === "direct_allowed" && nextCeiling === "brokered_only"
        ? narrowAudienceToBrokeredOnly(replacement)
        : replacement;
    const nextAudienceChanged = resource.allMembersDeliveryMode !== nextAudience.allMembersDeliveryMode
        || !isDeepStrictEqual(
            sortedAudience(currentGroups, "teamGroupId"),
            sortedAudience(nextAudience.groupGrants, "teamGroupId"),
        )
        || !isDeepStrictEqual(
            sortedAudience(currentMembers, "teamMembershipId"),
            sortedAudience(nextAudience.memberGrants, "teamMembershipId"),
        );
    const source = await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: resource.custodianAccountId,
        source: nextSource,
    });
    if (source.status !== "current") return { ok: false, error: "source_replaced_or_missing" };
    // Widening brokered_only -> direct_allowed is the active custodian's own
    // consent (it only arrives inside the custodian block), so the one rule
    // left is the source's ability to export direct material at all.
    if (resource.disclosureCeiling === "brokered_only" && nextCeiling === "direct_allowed"
        && source.directExportSupport === "unsupported") {
        return { ok: false, error: "disclosure_not_allowed" };
    }
    const nextRequestPolicy = requestPolicyChanged && replacement.requestPolicy !== null
        ? input.requestPolicySupport
            && isTeamCredentialRequestPolicySupportEvidenceCurrent({
                evidence: input.requestPolicySupport,
                source: nextSource,
                sourceCurrentness: source.requestPolicyCurrentness,
            })
            ? normalizeTeamCredentialRequestPolicyForPersistence({
                policy: replacement.requestPolicy,
                models: input.requestPolicySupport.models,
            })
            : null
        : replacement.requestPolicy;
    if (replacement.requestPolicy !== null && nextRequestPolicy === null) {
        return { ok: false, error: "update_required" };
    }
    const requestedModes = [
        nextAudience.allMembersDeliveryMode,
        ...nextAudience.groupGrants.map((grant) => grant.deliveryMode),
        ...nextAudience.memberGrants.map((grant) => grant.deliveryMode),
    ];
    if (source.directExportSupport === "unsupported"
        && requestedModes.some((mode) => mode === "direct" || mode === "both")) {
        return { ok: false, error: "disclosure_not_allowed" };
    }
    const audience = await validateTeamCredentialAudienceDraftInTx(tx, {
        teamId: resource.teamId,
        disclosureCeiling: nextCeiling,
        brokerPlacement: nextPlacement,
        audience: nextAudience,
    });
    if (!audience.ok) return audience;
    // Retained direct-only placement does not block withdrawal or repair, but
    // selecting another location is always validated, even without brokered grants.
    if (!isDeepStrictEqual(nextPlacement, storedPlacement.placement)
        || requestedModes.some(mode => mode !== null && mode !== "direct")) {
        const placement = await validateTeamCredentialBrokerPlacementForSaveInTx(tx, {
            custodianAccountId: resource.custodianAccountId,
            placement: nextPlacement,
        });
        if (!placement.ok) return placement;
    }
    const deleteIds = new Set(replacement.usageLimitDelta.deleteIds);
    const existingLimitsById = new Map(currentLimits.map((limit) => [limit.id, limit]));
    if ([...deleteIds].some((id) => !existingLimitsById.has(id))) return { ok: false, error: "invalid_limit" };
    const limitIdentity = (limit: Readonly<{ subjectKind: string; subjectId: string; period: string; metric: string }>) => (
        JSON.stringify([limit.subjectKind, limit.subjectId, limit.period, limit.metric])
    );
    const existingLimitsByIdentity = new Map(currentLimits.map((limit) => [limitIdentity(limit), limit]));
    const seenUpsertIds = new Set<string>();
    const seenUpsertIdentities = new Set<string>();
    const validatedUpserts: Array<Readonly<{
        existingId: string | null;
        subjectKind: string;
        subjectId: string;
        period: string;
        metric: string;
        maximum: string;
        enabled: boolean;
    }>> = [];
    const usageCapabilities = resolveCurrentTeamCredentialUsageCapabilitiesForResource({
        allMembersDeliveryMode: nextAudience.allMembersDeliveryMode,
        groupGrants: nextAudience.groupGrants,
        memberGrants: nextAudience.memberGrants,
        sessionUsePolicy: replacement.sessionUsePolicy,
    });
    for (const limit of replacement.usageLimitDelta.upserts) {
        const identity = limitIdentity(limit);
        if (seenUpsertIdentities.has(identity) || (limit.id !== undefined && seenUpsertIds.has(limit.id))) {
            return { ok: false, error: "invalid_limit" };
        }
        seenUpsertIdentities.add(identity);
        if (limit.id !== undefined) seenUpsertIds.add(limit.id);
        const byId = limit.id === undefined ? null : existingLimitsById.get(limit.id) ?? null;
        const byIdentity = existingLimitsByIdentity.get(identity) ?? null;
        if (limit.id !== undefined && byId === null) return { ok: false, error: "invalid_limit" };
        if (byId !== null && limitIdentity(byId) !== identity) return { ok: false, error: "invalid_limit" };
        if (byId !== null && byIdentity !== null && byIdentity.id !== byId.id) return { ok: false, error: "invalid_limit" };
        const existing = byId ?? byIdentity;
        if (existing !== null && deleteIds.has(existing.id)) return { ok: false, error: "invalid_limit" };
        const validated = await validateTeamCredentialUsageLimitDraftInTx(tx, {
            teamId: resource.teamId,
            limit,
            usageCapabilities,
        });
        if (!validated.ok) {
            if (validated.error === "subject_not_in_team") {
                return { ok: false, error: "subject_not_in_team" };
            }
            if (validated.error === "token_limit_unavailable") {
                return { ok: false, error: "token_limit_unavailable" };
            }
            if (validated.error === "cost_limit_unavailable") {
                return { ok: false, error: "cost_limit_unavailable" };
            }
            return { ok: false, error: "invalid_limit" };
        }
        validatedUpserts.push({
            existingId: existing?.id ?? null,
            subjectKind: limit.subjectKind,
            subjectId: limit.subjectId,
            period: limit.period,
            metric: limit.metric,
            maximum: validated.maximum,
            enabled: limit.enabled,
        });
    }
    const replacedLimitIds = new Set(validatedUpserts.flatMap((limit) => limit.existingId === null ? [] : [limit.existingId]));
    const retainedLimitRefusal = findTeamCredentialUsageLimitCapabilityRefusal(
        currentLimits.filter((limit) => !deleteIds.has(limit.id) && !replacedLimitIds.has(limit.id)),
        usageCapabilities,
    );
    if (retainedLimitRefusal) return { ok: false, error: retainedLimitRefusal };

    const sourceChanged = !isDeepStrictEqual(storedSource.data, nextSource);
    const directAuthorityChanged = sourceChanged
        || resource.disclosureCeiling !== nextCeiling
        || (resource.enabled && !replacement.enabled);
    // `revision` is the authority revision: selection mutations and fresh
    // broker opens use it as their CAS precondition, and every request presents
    // the revision it evaluated against the current resource. Accepted Session
    // bindings and established operations are not locked to it. It advances
    // only when an authority fact changes; a display-name edit keeps it (the CAS
    // precondition still applies).
    const authorityChanged = sourceChanged
        || resource.disclosureCeiling !== nextCeiling
        || !isDeepStrictEqual(storedPlacement.placement, nextPlacement)
        || resource.enabled !== replacement.enabled
        || resource.sessionUsePolicy !== replacement.sessionUsePolicy
        || requestPolicyChanged
        || nextAudienceChanged
        || replacement.usageLimitDelta.upserts.length > 0
        || replacement.usageLimitDelta.deleteIds.length > 0;
    const nextRevision = authorityChanged ? input.expectedRevision + 1 : input.expectedRevision;
    const updated = await tx.teamCredentialResource.updateMany({
        where: { id: resource.id, revision: input.expectedRevision },
        data: {
            enabled: replacement.enabled,
            displayName: replacement.displayName.trim(),
            sourceBindingJson: JSON.stringify(nextSource),
            disclosureCeiling: nextCeiling,
            sessionUsePolicy: replacement.sessionUsePolicy,
            requestPolicyJson: nextRequestPolicy === null ? null : JSON.stringify(nextRequestPolicy),
            brokerMachineId: nextPlacement?.kind === "machine" ? nextPlacement.machineId : null,
            brokerPoolId: nextPlacement?.kind === "machine_pool" ? nextPlacement.poolId : null,
            allMembersDeliveryMode: nextAudience.allMembersDeliveryMode,
            ...(directAuthorityChanged ? { directSourceVersionsJson: null } : {}),
            revision: nextRevision,
        },
    });
    if (updated.count !== 1) return { ok: false, error: "resource_changed" };
    if (nextAudienceChanged) {
        await Promise.all([
            tx.teamCredentialGroupGrant.deleteMany({ where: { resourceId: resource.id } }),
            tx.teamCredentialMemberGrant.deleteMany({ where: { resourceId: resource.id } }),
        ]);
        if (nextAudience.groupGrants.length > 0) {
            await tx.teamCredentialGroupGrant.createMany({
                data: nextAudience.groupGrants.map((grant) => ({ resourceId: resource.id, ...grant })),
            });
        }
        if (nextAudience.memberGrants.length > 0) {
            await tx.teamCredentialMemberGrant.createMany({
                data: nextAudience.memberGrants.map((grant) => ({ resourceId: resource.id, ...grant })),
            });
        }
    }
    if (deleteIds.size > 0) {
        await tx.teamCredentialUsageLimit.deleteMany({
            where: { resourceId: resource.id, id: { in: [...deleteIds] } },
        });
    }
    for (const limit of validatedUpserts) {
        if (limit.existingId !== null) {
            await tx.teamCredentialUsageLimit.update({
                where: { id: limit.existingId },
                data: { maximum: limit.maximum, enabled: limit.enabled },
            });
        } else {
            await tx.teamCredentialUsageLimit.create({ data: {
                resourceId: resource.id,
                subjectKind: limit.subjectKind,
                subjectId: limit.subjectId,
                period: limit.period,
                metric: limit.metric,
                maximum: limit.maximum,
                enabled: limit.enabled,
            } });
        }
    }
    if (directAuthorityChanged) {
        await tx.teamCredentialRecipientMaterial.deleteMany({ where: { resourceId: resource.id } });
    } else if (nextAudienceChanged) {
        await retainEntitledTeamCredentialRecipientMaterialInTx(tx, { resourceId: resource.id });
    }
    await recordTeamCredentialActivityInTx(tx, {
        teamId: resource.teamId,
        resourceId: resource.id,
        kind: "resource_updated",
        actor: { kind: "account", accountId: input.actorAccountId },
        subjectDisplayName: replacement.displayName.trim(),
    });
    await publishTeamChangedInTx(tx, {
        teamId: resource.teamId,
        additionalAccountIds: [resource.custodianAccountId, input.actorAccountId],
    });
    return { ok: true, resourceId: resource.id, revision: nextRevision };
}

export async function updateTeamCredentialResourceInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        patch: UpdateTeamCredentialResourceInput;
        authentication: TeamOperationAuthenticationContext;
        requestPolicySupport?: TeamCredentialRequestPolicySupportEvidence;
    }>,
): Promise<UpdateTeamCredentialResourceResult> {
    const parsedPatch = TeamCredentialResourceUpdateInputV1Schema.safeParse(input.patch);
    if (!parsedPatch.success) return { ok: false, error: "invalid_resource_input" };
    const patch = parsedPatch.data;
    if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 0
        || (patch.displayName !== undefined && (!patch.displayName.trim() || patch.displayName.trim().length > 120))
        || (patch.disclosureCeiling !== undefined && !TeamCredentialDisclosureCeilingV1Schema.safeParse(patch.disclosureCeiling).success)
        || (patch.sessionUsePolicy !== undefined && !TeamCredentialSessionUsePolicyV1Schema.safeParse(patch.sessionUsePolicy).success)
        || (patch.requestPolicy !== undefined && !z.nullable(TeamCredentialRequestPolicyV1Schema).safeParse(patch.requestPolicy).success)) {
        return { ok: false, error: "invalid_resource_input" };
    }
    const resourceIdentity = await tx.teamCredentialResource.findUnique({ where: { id: patch.resourceId }, select: { custodianAccountId: true, teamId: true } });
    if (!resourceIdentity) return { ok: false, error: "resource_not_found" };
    const materializedRecipients = await tx.teamCredentialRecipientMaterial.findMany({
        where: { resourceId: patch.resourceId }, select: { recipientAccountId: true }, distinct: ["recipientAccountId"],
    });
    const recheckAdmission = await acquireTeamMembershipAccountAdmissionInTx(tx, {
        teamId: resourceIdentity.teamId,
        accountIds: [input.actorAccountId, resourceIdentity.custodianAccountId, ...materializedRecipients.map(row => row.recipientAccountId)],
        membershipIds: patch.replacement?.memberGrants.map(grant => grant.teamMembershipId) ?? [],
    });
    await acquireTeamMutationLockInTx(tx, resourceIdentity.teamId);
    await recheckAdmission();
    const resource = await tx.teamCredentialResource.findUnique({ where: { id: patch.resourceId } });
    if (!resource) return { ok: false, error: "resource_not_found" };
    if (resource.custodianAccountId !== resourceIdentity.custodianAccountId) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    if (patch.replacement !== undefined) {
        return applyResourceReplacementInTx(tx, {
            actorAccountId: input.actorAccountId,
            authentication: input.authentication,
            resource,
            expectedRevision: patch.expectedRevision,
            replacement: patch.replacement,
            requestPolicySupport: input.requestPolicySupport,
        });
    }
    const isCustodian = resource.custodianAccountId === input.actorAccountId;
    const actor = await resolveTeamActorContextInTx(tx, { teamId: resource.teamId, actorAccountId: input.actorAccountId });
    const canManageStructurally = actor !== null
        && resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).manageCredentials;
    const custodianAccount = isCustodian
        ? await tx.account.findUnique({ where: { id: input.actorAccountId }, select: { status: true } })
        : null;
    const isActiveCustodian = custodianAccount?.status === AccountStatus.active;
    if (!canManageStructurally && !isActiveCustodian) return { ok: false, error: "resource_forbidden" };
    // A broker Machine is part of the private source binding. Team managers may
    // administer policy and audience, but they neither receive nor set another
    // Account's Machine identity.
    if (patch.brokerPlacement !== undefined && !isCustodian) {
        return { ok: false, error: "resource_forbidden" };
    }
    // The ceiling is consent owned by the source custodian. Team management
    // may shape audiences within it, but may neither widen nor narrow the
    // source owner's permanent disclosure decision.
    if (patch.disclosureCeiling !== undefined && !isCustodian) {
        return { ok: false, error: "resource_forbidden" };
    }
    const requiresManagerAuthority = !isCustodian
        || patch.displayName !== undefined
        || patch.requestPolicy !== undefined
        || patch.sessionUsePolicy !== undefined
        || patch.enabled === true;
    if (requiresManagerAuthority && !canManageStructurally) return { ok: false, error: "resource_forbidden" };
    const qualification = requiresManagerAuthority
        ? actor === null
            ? { ok: false as const, error: "resource_forbidden" as const }
            : await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication)
        : { ok: true as const };
    if (!qualification.ok) return qualification;
    const canManage = canManageStructurally && qualification.ok;
    if (resource.revision !== patch.expectedRevision) return { ok: false, error: "resource_changed" };
    const ceiling = TeamCredentialDisclosureCeilingV1Schema.safeParse(patch.disclosureCeiling ?? resource.disclosureCeiling);
    const sessionPolicy = TeamCredentialSessionUsePolicyV1Schema.safeParse(patch.sessionUsePolicy ?? resource.sessionUsePolicy);
    const storedRequestPolicy = (() => {
        if (resource.requestPolicyJson === null) return null;
        try { return JSON.parse(resource.requestPolicyJson) as unknown; } catch { return undefined; }
    })();
    const requestPolicy = z.nullable(TeamCredentialRequestPolicyV1Schema).safeParse(
        patch.requestPolicy === undefined ? storedRequestPolicy : patch.requestPolicy,
    );
    if (!ceiling.success || !sessionPolicy.success || !requestPolicy.success) return { ok: false, error: "resource_corrupt" };
    if (sessionPolicy.data !== resource.sessionUsePolicy) {
        const [groupGrants, memberGrants, limits] = await Promise.all([
            tx.teamCredentialGroupGrant.findMany({ where: { resourceId: resource.id }, select: { deliveryMode: true } }),
            tx.teamCredentialMemberGrant.findMany({ where: { resourceId: resource.id }, select: { deliveryMode: true } }),
            tx.teamCredentialUsageLimit.findMany({ where: { resourceId: resource.id }, select: { metric: true, enabled: true } }),
        ]);
        const limitRefusal = findTeamCredentialUsageLimitCapabilityRefusal(limits, resolveCurrentTeamCredentialUsageCapabilitiesForResource({
            allMembersDeliveryMode: resource.allMembersDeliveryMode,
            groupGrants,
            memberGrants,
            sessionUsePolicy: sessionPolicy.data,
        }));
        if (limitRefusal) return { ok: false, error: limitRefusal };
    }
    const requestPolicyChanged = !isDeepStrictEqual(storedRequestPolicy, requestPolicy.data);
    let nextRequestPolicy = requestPolicy.data;
    if (requestPolicyChanged && requestPolicy.data !== null) {
        const storedSource = readTeamCredentialSourceBinding(resource.sourceBindingJson);
        if (!storedSource.success) return { ok: false, error: "resource_corrupt" };
        const currentSource = await resolveTeamCredentialResourceSourceInTx(tx, {
            custodianAccountId: resource.custodianAccountId,
            source: storedSource.data,
        });
        if (currentSource.status !== "current") return { ok: false, error: "source_replaced_or_missing" };
        nextRequestPolicy = input.requestPolicySupport
            && isTeamCredentialRequestPolicySupportEvidenceCurrent({
                evidence: input.requestPolicySupport,
                source: storedSource.data,
                sourceCurrentness: currentSource.requestPolicyCurrentness,
            })
            ? normalizeTeamCredentialRequestPolicyForPersistence({
                policy: requestPolicy.data,
                models: input.requestPolicySupport.models,
            })
            : null;
        if (nextRequestPolicy === null) return { ok: false, error: "update_required" };
    }
    if (!canManage) {
        const changesManagerOwnedField = patch.displayName !== undefined
            || patch.requestPolicy !== undefined
            || patch.sessionUsePolicy !== undefined
            || patch.enabled === true;
        if (changesManagerOwnedField) return { ok: false, error: "resource_forbidden" };
    }
    const isWideningDisclosure = resource.disclosureCeiling === "brokered_only" && ceiling.data === "direct_allowed";
    if (isWideningDisclosure) {
        // Widening is the active source custodian's own consent; the source
        // must still be current and able to export direct material.
        if (!isActiveCustodian) return { ok: false, error: "resource_forbidden" };
        const storedSource = readTeamCredentialSourceBinding(resource.sourceBindingJson);
        if (!storedSource.success) return { ok: false, error: "resource_corrupt" };
        const currentSource = await resolveTeamCredentialResourceSourceInTx(tx, {
            custodianAccountId: resource.custodianAccountId,
            source: storedSource.data,
        });
        if (currentSource.status !== "current") return { ok: false, error: "source_replaced_or_missing" };
        if (currentSource.directExportSupport === "unsupported") return { ok: false, error: "disclosure_not_allowed" };
    }
    const isLoweringDisclosure = resource.disclosureCeiling === "direct_allowed"
        && ceiling.data === "brokered_only";
    const storedAllMembersDeliveryMode = z.nullable(TeamCredentialDeliveryModeV1Schema)
        .safeParse(resource.allMembersDeliveryMode);
    if (isLoweringDisclosure && !storedAllMembersDeliveryMode.success) return { ok: false, error: "resource_corrupt" };
    const storedPlacement = readTeamCredentialBrokerPlacement(resource);
    if (!storedPlacement.ok) return { ok: false, error: "resource_corrupt" };
    const parsedPlacement = z.nullable(TeamCredentialBrokerPlacementV1Schema).safeParse(
        patch.brokerPlacement === undefined ? storedPlacement.placement : patch.brokerPlacement,
    );
    if (!parsedPlacement.success) return { ok: false, error: "resource_corrupt" };
    const brokerMachineId = parsedPlacement.data?.kind === "machine" ? parsedPlacement.data.machineId : null;
    const brokerPoolId = parsedPlacement.data?.kind === "machine_pool" ? parsedPlacement.data.poolId : null;
    const existingBrokerAudience = resource.allMembersDeliveryMode !== null && resource.allMembersDeliveryMode !== "direct"
        || (await tx.teamCredentialGroupGrant.count({ where: { resourceId: resource.id, deliveryMode: { in: ["brokered", "both"] } } })) > 0
        || (await tx.teamCredentialMemberGrant.count({ where: { resourceId: resource.id, deliveryMode: { in: ["brokered", "both"] } } })) > 0;
    // Save readiness answers "may this placement be selected", so it is asked of
    // a placement this patch actually selects. A patch that only takes authority
    // away — disabling the resource, or narrowing its ceiling — keeps whatever
    // placement is already stored, and must not be blocked by that placement's
    // Machine having been revoked, replaced or removed: withdrawal is exactly
    // the custodian's recovery when the broker is gone, and `resourceDelete`
    // already works. Every other patch, and any newly selected placement, is
    // validated normally.
    const keepsStoredPlacement = brokerMachineId === resource.brokerMachineId
        && brokerPoolId === resource.brokerPoolId;
    const reducesAuthorityOnly = keepsStoredPlacement
        && !isWideningDisclosure
        && !(patch.enabled === true && !resource.enabled)
        && sessionPolicy.data === resource.sessionUsePolicy
        && !requestPolicyChanged
        && (patch.enabled === false || isLoweringDisclosure);
    if (!reducesAuthorityOnly) {
        if (existingBrokerAudience && brokerMachineId === null && brokerPoolId === null) return { ok: false, error: "broker_unavailable" };
        const placement = await validateTeamCredentialBrokerPlacementForSaveInTx(tx, {
            custodianAccountId: resource.custodianAccountId,
            placement: parsedPlacement.data,
        });
        if (!placement.ok) return placement;
    }
    // See applyResourceReplacementInTx: only authority facts advance `revision`.
    const authorityChanged = (patch.enabled !== undefined && patch.enabled !== resource.enabled)
        || ceiling.data !== resource.disclosureCeiling
        || sessionPolicy.data !== resource.sessionUsePolicy
        || requestPolicyChanged
        || brokerMachineId !== resource.brokerMachineId
        || brokerPoolId !== resource.brokerPoolId;
    const nextRevision = authorityChanged ? patch.expectedRevision + 1 : patch.expectedRevision;
    const updated = await tx.teamCredentialResource.updateMany({ where: { id: resource.id, revision: patch.expectedRevision }, data: {
        ...(patch.displayName === undefined ? {} : { displayName: patch.displayName.trim() }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        disclosureCeiling: ceiling.data, sessionUsePolicy: sessionPolicy.data,
        requestPolicyJson: nextRequestPolicy === null ? null : JSON.stringify(nextRequestPolicy),
        brokerMachineId, brokerPoolId, revision: nextRevision,
        // Narrowing the ceiling withdraws consent to direct disclosure through
        // the protocol's one narrowing rule: it keeps the broker half of a
        // `both` audience and ends a direct-only one, and never mints broker
        // authority the custodian never granted.
        ...(isLoweringDisclosure && storedAllMembersDeliveryMode.success
            ? { allMembersDeliveryMode: narrowTeamCredentialDeliveryModeToBrokeredOnlyV1(storedAllMembersDeliveryMode.data) }
            : {}),
    } });
    if (updated.count !== 1) return { ok: false, error: "resource_changed" };
    if (isLoweringDisclosure) {
        // Every stored grant mode moves exactly where the same rule sends it.
        await Promise.all(TeamCredentialDeliveryModeV1Schema.options.flatMap((deliveryMode) => {
            const narrowed = narrowTeamCredentialDeliveryModeToBrokeredOnlyV1(deliveryMode);
            if (narrowed === deliveryMode) return [];
            const where = { resourceId: resource.id, deliveryMode };
            return narrowed === null
                ? [tx.teamCredentialGroupGrant.deleteMany({ where }), tx.teamCredentialMemberGrant.deleteMany({ where })]
                : [
                    tx.teamCredentialGroupGrant.updateMany({ where, data: { deliveryMode: narrowed } }),
                    tx.teamCredentialMemberGrant.updateMany({ where, data: { deliveryMode: narrowed } }),
                ];
        }));
    }
    if (patch.enabled === false || isLoweringDisclosure) {
        await tx.teamCredentialRecipientMaterial.deleteMany({ where: { resourceId: resource.id } });
        await tx.teamCredentialResource.update({
            where: { id: resource.id },
            data: { directSourceVersionsJson: null },
        });
    }
    await recordTeamCredentialActivityInTx(tx, {
        teamId: resource.teamId, resourceId: resource.id, kind: "resource_updated",
        actor: { kind: "account", accountId: input.actorAccountId }, subjectDisplayName: patch.displayName?.trim() ?? resource.displayName,
    });
    await publishTeamChangedInTx(tx, { teamId: resource.teamId, additionalAccountIds: [resource.custodianAccountId, input.actorAccountId] });
    return { ok: true, resourceId: resource.id, revision: nextRevision };
}
