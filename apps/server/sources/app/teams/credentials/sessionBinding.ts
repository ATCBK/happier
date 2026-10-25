import { SessionTeamCredentialBindingIntentsV1Schema, encodeSessionTeamCredentialSlotKeyV1, type SessionTeamCredentialBindingIntentListV1, type SessionTeamCredentialSlotV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { type SessionTeamCredentialBindingRejectionV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import { type TeamCredentialRouteV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import type { RequiredSessionTeamCredentialV1, SessionTeamCredentialBindingConsequenceV1 } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { assertSessionTeamReadableGrantInTx } from "@/app/session/access/sessionAccess";
import { putSessionAccessGrantInTx, sessionAccessGrantMutationCursorLockOptions } from "@/app/session/access/sessionAccessGrantService";
import { acquireSessionAccessTransitionCursorLocksInTx } from "@/app/session/access/sessionAccessTransitionEffects";
import {
    qualifySessionTeamAuthenticationInTx,
    type SessionAccessAuthentication,
} from "@/app/session/access/sessionAccessAuthentication";
import { resolveTeamCredentialBrokerMachineForSaveInTx } from "./brokerMachineEligibility";
import {
    readTeamCredentialBrokerPlacement,
    resolveTeamCredentialBrokerPlacementFingerprint,
    admitTeamCredentialBrokerMachineForResourceInTx,
    admitTeamCredentialBrokerPoolForBrokeredUseInTx,
    type TeamCredentialBrokerPlacementSelection,
} from "./brokerPlacementResolver";
import { resolveTeamCredentialEntitlementInTx, type TeamCredentialEntitlementDecision } from "./resourceAccess";
import { resolveTeamCredentialResourceSourceInTx, type TeamCredentialResourceSourceResolution } from "./resourceSourceResolver";

export type SessionTeamCredentialBindingRejection =
    SessionTeamCredentialBindingRejectionV1;

export type SessionTeamCredentialBindingWriteResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: SessionTeamCredentialBindingRejection }>;

function key(slot: SessionTeamCredentialSlotV1): Uint8Array {
    return encodeSessionTeamCredentialSlotKeyV1(slot);
}

function persistedSlotKind(slot: SessionTeamCredentialSlotV1, deliveryMode: TeamCredentialRouteV1): string {
    return `${slot.kind}:${deliveryMode}`;
}

/** Persist accepted Session selection intent in the same transaction as its owner. */
export async function writeSessionTeamCredentialBindingsInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        intents: unknown;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    const parsed = SessionTeamCredentialBindingIntentsV1Schema.safeParse(input.intents);
    if (!parsed.success || !input.sessionId) return { ok: false, reason: "invalid_input" };
    return writeParsedSessionTeamCredentialBindingsInTx(tx, {
        sessionId: input.sessionId,
        accountId: input.accountId,
        intents: parsed.data,
        authentication: input.authentication,
    });
}

export async function writeParsedSessionTeamCredentialBindingsInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        intents: SessionTeamCredentialBindingIntentListV1;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    if (!await isServerFeatureEnabledForHome("teams.credentialResources", { tx })) {
        return { ok: false, reason: "feature_disabled" };
    }
    const owner = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { accountId: true },
    });
    if (!owner) return { ok: false, reason: "session_missing" };
    if (owner.accountId !== input.accountId) return { ok: false, reason: "session_owner_mismatch" };
    // Validate the complete batch before mutating any row. Callers may use a
    // successful transaction for other Session state, so a rejected binding
    // batch must never leave a partially-applied witness behind.
    for (const intent of input.intents) {
        if (intent.resourceId === null) continue;
        const resolved = await validateExistingSessionTeamCredentialResourceInTx(tx, {
            sessionId: input.sessionId,
            accountId: input.accountId,
            resourceId: intent.resourceId,
            expectedResourceRevision: intent.expectedResourceRevision,
            deliveryMode: intent.deliveryMode,
            authentication: input.authentication,
        });
        const admitted = validateResolvedSessionTeamCredentialBindingIntent(resolved, intent);
        if (!admitted.ok) return admitted;
    }
    for (const intent of input.intents) {
        const slotKey = Buffer.from(key(intent.slot));
        if (intent.resourceId === null) {
            await tx.sessionTeamCredentialBinding.deleteMany({
                where: { sessionId: input.sessionId, slotKey },
            });
        } else {
            await tx.sessionTeamCredentialBinding.upsert({
                where: { sessionId_slotKind_slotKey: { sessionId: input.sessionId, slotKind: persistedSlotKind(intent.slot, intent.deliveryMode), slotKey } },
                create: {
                    sessionId: input.sessionId,
                    slotKind: persistedSlotKind(intent.slot, intent.deliveryMode),
                    slotKey,
                    resourceId: intent.resourceId,
                    resourceRevision: intent.expectedResourceRevision,
                },
                update: {
                    resourceId: intent.resourceId,
                    resourceRevision: intent.expectedResourceRevision,
                },
            });
            await tx.sessionTeamCredentialBinding.deleteMany({
                where: {
                    sessionId: input.sessionId,
                    slotKey,
                    slotKind: persistedSlotKind(intent.slot, intent.deliveryMode === "brokered" ? "direct" : "brokered"),
                },
            });
        }
    }
    return { ok: true };
}

export async function readSessionTeamCredentialBindingInTx(
    tx: Tx,
    input: Readonly<{ sessionId: string; slot: SessionTeamCredentialSlotV1; deliveryMode: TeamCredentialRouteV1 }>,
): Promise<Readonly<{ resourceId: string; resourceRevision: number; deliveryMode: TeamCredentialRouteV1 } | null>> {
    const row = await tx.sessionTeamCredentialBinding.findUnique({
        where: { sessionId_slotKind_slotKey: {
            sessionId: input.sessionId, slotKind: persistedSlotKind(input.slot, input.deliveryMode), slotKey: Buffer.from(key(input.slot)),
        } },
        select: { resourceId: true, resourceRevision: true },
    });
    return row ? { ...row, deliveryMode: input.deliveryMode } : null;
}

/** Read the accepted resource/route with its current revision for a new attach.
 * The stored selection revision is not a continuing policy fence; broker use
 * still rechecks current authority without rewriting that original witness. */
export async function readAcceptedSessionTeamCredentialProviderModelBindingInTx(
    tx: Tx,
    sessionId: string,
): Promise<SessionTeamCredentialBindingIntentListV1[number] | null> {
    const rows = await tx.sessionTeamCredentialBinding.findMany({
        where: { sessionId, slotKey: Buffer.from(key({ kind: 'provider_model' })) },
        select: { slotKind: true, resourceId: true, resource: { select: { teamId: true, revision: true } } },
    });
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error('Conflicting accepted Session Provider-model bindings');
    const row = rows[0]!;
    const deliveryMode = (['direct', 'brokered'] as const).find(mode => row.slotKind === persistedSlotKind({ kind: 'provider_model' }, mode));
    if (!deliveryMode) throw new Error('Invalid accepted Session Provider-model binding');
    return { v: 1, slot: { kind: 'provider_model' }, resourceId: row.resourceId,
        expectedResourceRevision: row.resource.revision, deliveryMode, teamId: row.resource.teamId };
}

export async function isSessionTeamCredentialBindingIntentCurrentInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        intent: SessionTeamCredentialBindingIntentListV1[number];
    }>,
): Promise<boolean> {
    if (input.intent.resourceId === null) {
        const rows = await tx.sessionTeamCredentialBinding.count({
            where: { sessionId: input.sessionId, slotKey: Buffer.from(key(input.intent.slot)) },
        });
        return rows === 0;
    }
    const current = await readSessionTeamCredentialBindingInTx(tx, {
        sessionId: input.sessionId,
        slot: input.intent.slot,
        deliveryMode: input.intent.deliveryMode,
    });
    return current === null
        ? false
        : current?.resourceId === input.intent.resourceId
            && current.resourceRevision === input.intent.expectedResourceRevision;
}

export async function validateSessionTeamCredentialBindingIntentInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        intent: SessionTeamCredentialBindingIntentListV1[number];
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    if (!await isServerFeatureEnabledForHome("teams.credentialResources", { tx })) {
        return { ok: false, reason: "feature_disabled" };
    }
    const session = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { accountId: true },
    });
    if (!session) return { ok: false, reason: "session_missing" };
    if (session.accountId !== input.accountId) return { ok: false, reason: "session_owner_mismatch" };
    if (input.intent.resourceId === null) return { ok: true };
    const result = await validateExistingSessionTeamCredentialResourceInTx(tx, {
        sessionId: input.sessionId,
        accountId: input.accountId,
        resourceId: input.intent.resourceId,
        expectedResourceRevision: input.intent.expectedResourceRevision,
        deliveryMode: input.intent.deliveryMode,
        authentication: input.authentication,
    });
    return validateResolvedSessionTeamCredentialBindingIntent(result, input.intent);
}

function validateResolvedSessionTeamCredentialBindingIntent(
    result: SessionTeamCredentialResourceValidationResult,
    intent: SessionTeamCredentialBindingIntentListV1[number],
): SessionTeamCredentialBindingWriteResult {
    if (!result.ok) return result;
    if (intent.resourceId !== null && intent.teamId !== undefined && result.binding.teamId !== intent.teamId) {
        return { ok: false, reason: "invalid_input" };
    }
    return { ok: true };
}

/**
 * Composes the Lane 04 access owner with binding admission in one caller-owned
 * transaction. Consent is exact to the selected resource's Team; a mismatch
 * cannot grant access to either Team.
 */
export async function grantRequiredTeamVisibilityAndValidateBindingInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        intent: SessionTeamCredentialBindingIntentListV1[number];
        consentTeamId: string;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    if (input.intent.resourceId === null) return { ok: false, reason: "invalid_input" };
    if (input.intent.teamId !== undefined && input.intent.teamId !== input.consentTeamId) {
        return { ok: false, reason: "invalid_input" };
    }
    await acquireSessionAccessTransitionCursorLocksInTx(tx, [input.sessionId], [],
        sessionAccessGrantMutationCursorLockOptions({ actorAccountId: input.accountId, sessionId: input.sessionId,
            subjects: [{ kind: "team", teamId: input.consentTeamId }],
        }));
    const admitted = await validateRequiredTeamVisibilityInTx(tx, {
        ...input,
        requiredTeamCredential: input.intent,
    });
    if (!admitted.ok) return admitted;
    const grant = await putSessionAccessGrantInTx(tx, {
        actorAccountId: input.accountId,
        sessionId: input.sessionId,
        subject: { kind: "team", teamId: input.consentTeamId },
        grant: { accessLevel: "edit", canApprovePermissions: false },
        authentication: input.authentication,
    });
    return grant.ok ? { ok: true } : { ok: false, reason: "access_removed" };
}

/** Validate the exact selected resource against consented visibility before any access effect. */
export async function validateRequiredTeamVisibilityInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        consentTeamId: string;
        requiredTeamCredential: RequiredSessionTeamCredentialV1;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    const session = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { accountId: true, primaryTeamId: true },
    });
    if (!session) return { ok: false, reason: "session_missing" };
    if (session.accountId !== input.accountId) return { ok: false, reason: "session_owner_mismatch" };
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.requiredTeamCredential.resourceId },
        select: { teamId: true, revision: true, sessionUsePolicy: true },
    });
    if (!resource) return { ok: false, reason: "resource_missing" };
    if (resource.revision !== input.requiredTeamCredential.expectedResourceRevision) return { ok: false, reason: "resource_changed" };
    if (resource.teamId !== input.consentTeamId || resource.sessionUsePolicy !== "team_visibility_required") {
        return { ok: false, reason: "invalid_input" };
    }
    const admitted = await validateSessionTeamCredentialResourceForContextInTx(tx, {
        accountId: input.accountId,
        ...input.requiredTeamCredential,
        authentication: input.authentication,
        policy: {
            primaryTeamId: session.primaryTeamId,
            isVisibleToTeam: async (teamId) => teamId === input.consentTeamId,
        },
    });
    return admitted.ok ? { ok: true } : admitted;
}

type SessionTeamCredentialResourceValidationResult =
    | Readonly<{
        ok: true;
        binding: Readonly<{ resourceId: string; resourceRevision: number; teamId: string; deliveryMode: TeamCredentialRouteV1 }>;
        entitlement: Extract<TeamCredentialEntitlementDecision, { ok: true }>;
        source: Extract<TeamCredentialResourceSourceResolution, { status: "current" }>;
        /** The resource's own current source binding, parsed once here so no caller reparses it. */
        sourceBinding: TeamCredentialSourceBindingV1;
        custodianAccountId: string;
        brokerPlacementFingerprint: string | null;
    }>
    | Readonly<{ ok: false; reason: SessionTeamCredentialBindingRejection }>;

export type SessionTeamCredentialAdmissionResult =
    | SessionTeamCredentialResourceValidationResult
    | Readonly<{ ok: false; reason: "binding_missing" }>;

export interface PlannedSessionTeamCredentialContext {
    readonly primaryTeamId: string | null;
    readonly teamVisibilityTeamIds: readonly string[];
}

type SessionTeamCredentialPolicyContext = Readonly<{
    primaryTeamId: string | null;
    isVisibleToTeam: (teamId: string) => Promise<boolean>;
}>;

async function validateSessionTeamCredentialResourceForContextInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        resourceId: string;
        expectedResourceRevision?: number;
        expectedBrokerMachineId?: string;
        brokerSelection?: TeamCredentialBrokerPlacementSelection;
        deliveryMode: TeamCredentialRouteV1;
        policy: SessionTeamCredentialPolicyContext;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialResourceValidationResult> {
    if (!await isServerFeatureEnabledForHome("teams.credentialResources", { tx })) {
        return { ok: false, reason: "feature_disabled" };
    }
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId },
        select: {
            id: true, teamId: true, custodianAccountId: true, revision: true,
            sessionUsePolicy: true, sourceBindingJson: true, brokerMachineId: true, brokerPoolId: true,
            team: { select: { authenticationPolicy: true } },
        },
    });
    if (!resource) return { ok: false, reason: "resource_missing" };
    if (input.expectedResourceRevision !== undefined && resource.revision !== input.expectedResourceRevision) {
        return { ok: false, reason: "resource_changed" };
    }
    const entitlement = await resolveTeamCredentialEntitlementInTx(tx, { resourceId: resource.id, accountId: input.accountId });
    if (!entitlement.ok) return entitlement;
    // Always the presented credential's own current qualification. An
    // established broker operation presents the opening credential's
    // provenance, carried in its signed authority, so every request of an
    // existing stream is re-qualified here (`04-private-iroh-broker-transport.md`
    // §5.6); there is no "already qualified" shortcut.
    const qualification = await qualifySessionTeamAuthenticationInTx(tx, {
        accountId: input.accountId,
        team: { id: resource.teamId, authenticationPolicy: resource.team.authenticationPolicy },
        authentication: input.authentication,
    });
    if (qualification.status !== "satisfied") {
        return {
            ok: false,
            reason: qualification.status === "unavailable"
                ? "authentication_unavailable"
                : "authentication_required",
        };
    }
    switch (resource.sessionUsePolicy) {
        case "personal_allowed":
            break;
        case "team_context_required":
            if (input.policy.primaryTeamId !== resource.teamId) {
                return { ok: false, reason: "team_context_required" };
            }
            break;
        case "team_visibility_required":
            if (!await input.policy.isVisibleToTeam(resource.teamId)) {
                return { ok: false, reason: "team_visibility_required" };
            }
            break;
        default:
            return { ok: false, reason: "resource_corrupt" };
    }
    const parsedSourceBinding = readTeamCredentialSourceBinding(resource.sourceBindingJson);
    if (!parsedSourceBinding.success) return { ok: false, reason: "resource_corrupt" };
    const source = await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: resource.custodianAccountId,
        source: parsedSourceBinding.data,
    });
    if (source.status === "unavailable") {
        return { ok: false, reason: source.reason === "invalid_source_binding" ? "resource_corrupt" : "source_replaced_or_missing" };
    }
    if (input.deliveryMode === "brokered") {
        if (!entitlement.mayBroker) return { ok: false, reason: "access_removed" };
        const placement = readTeamCredentialBrokerPlacement(resource);
        if (!placement.ok) return { ok: false, reason: "resource_corrupt" };
        // A readable resource that names no broker (its Machine or Pool was
        // removed) is not corrupt: it simply has no broker now — the same
        // answer the Runner binding reader below gives for the same fact.
        if (placement.placement === null) return { ok: false, reason: "broker_unavailable" };
        // A presented broker Machine is this operation's already-selected
        // target, so the one exact-Machine admission owner decides it: the
        // placement still has to name or (for an established selection) have
        // named that Machine, and the Machine's own resource, source and
        // revocation authority is rechecked. Pool membership and priority are
        // never re-ACLed for it, and no other member is ever substituted.
        // Only a genuinely fresh open still asks the Pool for a candidate.
        const broker = input.expectedBrokerMachineId !== undefined
            ? await admitTeamCredentialBrokerMachineForResourceInTx(tx, {
                resource,
                brokerMachineId: input.expectedBrokerMachineId,
                ...(input.brokerSelection ? { selection: input.brokerSelection } : {}),
            })
            : placement.placement.kind === "machine"
                ? await resolveTeamCredentialBrokerMachineForSaveInTx(tx, resource)
                : await admitTeamCredentialBrokerPoolForBrokeredUseInTx(tx, {
                    custodianAccountId: resource.custodianAccountId,
                    poolId: placement.placement.poolId,
                });
        if (!broker.ok) {
            // The placement columns were already read above, so an unreadable
            // row is corrupt; a placement that no longer names the presented
            // Machine keeps this validator's `broker_unavailable` contract.
            return {
                ok: false,
                reason: broker.error === "resource_unavailable"
                    ? "resource_corrupt"
                    : broker.error === "resource_changed" ? "broker_unavailable" : broker.error,
            };
        }
    } else if (!entitlement.mayReceiveDirect) {
        return { ok: false, reason: "access_removed" };
    }
    return {
        ok: true,
        binding: { resourceId: resource.id, resourceRevision: resource.revision, teamId: resource.teamId, deliveryMode: input.deliveryMode },
        entitlement,
        source,
        sourceBinding: parsedSourceBinding.data,
        custodianAccountId: resource.custodianAccountId,
        brokerPlacementFingerprint: resolveTeamCredentialBrokerPlacementFingerprint(resource),
    };
}

export async function validatePlannedSessionTeamCredentialResourceInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        resourceId: string;
        /** Omitted only when an established operation intentionally adopts the current resource revision. */
        expectedResourceRevision?: number;
        expectedBrokerMachineId?: string;
        brokerSelection?: TeamCredentialBrokerPlacementSelection;
        deliveryMode: TeamCredentialRouteV1;
        plannedSession: PlannedSessionTeamCredentialContext;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialResourceValidationResult> {
    const visibleTeamIds = new Set(input.plannedSession.teamVisibilityTeamIds);
    return validateSessionTeamCredentialResourceForContextInTx(tx, {
        accountId: input.accountId,
        resourceId: input.resourceId,
        expectedResourceRevision: input.expectedResourceRevision,
        expectedBrokerMachineId: input.expectedBrokerMachineId,
        ...(input.brokerSelection ? { brokerSelection: input.brokerSelection } : {}),
        deliveryMode: input.deliveryMode,
        authentication: input.authentication,
        policy: {
            primaryTeamId: input.plannedSession.primaryTeamId,
            isVisibleToTeam: async (teamId) => visibleTeamIds.has(teamId),
        },
    });
}

/** Validate a fresh Session's exact resource intent before any Session row is written. */
export async function validatePlannedSessionTeamCredentialBindingIntentInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        intent: SessionTeamCredentialBindingIntentListV1[number];
        plannedSession: PlannedSessionTeamCredentialContext;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    if (input.intent.resourceId === null) return { ok: true };
    const result = await validatePlannedSessionTeamCredentialResourceInTx(tx, {
        accountId: input.accountId,
        resourceId: input.intent.resourceId,
        expectedResourceRevision: input.intent.expectedResourceRevision,
        deliveryMode: input.intent.deliveryMode,
        plannedSession: input.plannedSession,
        authentication: input.authentication,
    });
    return validateResolvedSessionTeamCredentialBindingIntent(result, input.intent);
}

/**
 * Canonical pre-Session producer for the Runner's reviewed credential binding.
 * It reuses the planned Session admission owner and reveals one exact broker
 * Machine: the resource's own placement when it names a Machine, and otherwise
 * the Pool member the placement owner already selected for this activation. No
 * Session or broker lease is created by this bounded read.
 */
export async function resolvePlannedRunnerCredentialSelectionBindingInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        resourceId: string;
        expectedResourceRevision: number;
        plannedSession: PlannedSessionTeamCredentialContext;
        authentication: SessionAccessAuthentication;
        /** Exact persistent Machine already selected for this activation before review. */
        selectedBrokerMachineId?: string;
        /**
         * `per_request` while this activation is still choosing its broker, and
         * `established` for every later read of the exact target it froze.
         */
        selection?: TeamCredentialBrokerPlacementSelection;
    }>,
): Promise<
    | Readonly<{ ok: true; binding: Readonly<{ v: 1; resourceId: string; brokerMachineId: string; revision: number }> }>
    | Readonly<{ ok: false; reason: SessionTeamCredentialBindingRejection }>
> {
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId },
        select: { custodianAccountId: true, brokerMachineId: true, brokerPoolId: true },
    });
    if (!resource) return { ok: false, reason: "resource_missing" };
    const placement = readTeamCredentialBrokerPlacement(resource);
    if (!placement.ok) return { ok: false, reason: "resource_corrupt" };
    if (placement.placement === null) return { ok: false, reason: "broker_unavailable" };
    let brokerMachineId: string;
    if (placement.placement.kind === "machine") {
        brokerMachineId = placement.placement.machineId;
        if (input.selectedBrokerMachineId !== undefined && input.selectedBrokerMachineId !== brokerMachineId) {
            return { ok: false, reason: "broker_unavailable" };
        }
    } else {
        // A Pool placement names no single Machine of its own. The exact member
        // is chosen once by the placement owner before review and then travels
        // in this activation's binding: a fresh selection must still be a
        // current member, while a later read of the established target is not
        // re-ACLed against membership edits made after the freeze.
        if (input.selectedBrokerMachineId === undefined) return { ok: false, reason: "broker_unavailable" };
        brokerMachineId = input.selectedBrokerMachineId;
    }
    const admitted = await validatePlannedSessionTeamCredentialResourceInTx(tx, {
        ...input,
        deliveryMode: "brokered",
        expectedBrokerMachineId: brokerMachineId,
        ...(input.selection ? { brokerSelection: input.selection } : {}),
    });
    if (!admitted.ok) return admitted;
    return {
        ok: true,
        binding: {
            v: 1,
            resourceId: admitted.binding.resourceId,
            brokerMachineId,
            revision: admitted.binding.resourceRevision,
        },
    };
}

export async function validateExistingSessionTeamCredentialResourceInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        resourceId: string;
        expectedResourceRevision?: number;
        expectedBrokerMachineId?: string;
        brokerSelection?: TeamCredentialBrokerPlacementSelection;
        deliveryMode: TeamCredentialRouteV1;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialResourceValidationResult> {
    const session = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { accountId: true, primaryTeamId: true },
    });
    if (!session) return { ok: false, reason: "session_missing" };
    if (session.accountId !== input.accountId) return { ok: false, reason: "session_owner_mismatch" };
    return validateSessionTeamCredentialResourceForContextInTx(tx, {
        accountId: input.accountId,
        resourceId: input.resourceId,
        expectedResourceRevision: input.expectedResourceRevision,
        ...(input.expectedBrokerMachineId !== undefined
            ? { expectedBrokerMachineId: input.expectedBrokerMachineId }
            : {}),
        ...(input.brokerSelection ? { brokerSelection: input.brokerSelection } : {}),
        authentication: input.authentication,
        deliveryMode: input.deliveryMode,
        policy: {
            primaryTeamId: session.primaryTeamId,
            isVisibleToTeam: async (teamId) => (
                await assertSessionTeamReadableGrantInTx({ tx, sessionId: input.sessionId, teamId })
            ).ok,
        },
    });
}

export type SessionTeamCredentialBindingConsequence = SessionTeamCredentialBindingConsequenceV1;

/** The two session-use policies a Session-level access edit can invalidate. */
const CONDITIONAL_SESSION_USE_POLICIES = ["team_visibility_required", "team_context_required"] as const;

/**
 * Read-only preview for the Session access editor: the credential selections
 * this Session keeps only while one of the named Teams still holds the standing
 * it currently has.
 *
 * Both conditional policies travel because the editor offers both edits that can
 * invalidate them: removing a Team's grant ends `team_visibility_required`, and
 * moving the Session's context off a Team ends that Team's
 * `team_context_required`. The row carries which policy it depends on so the
 * confirmation names only what the edit in hand actually breaks. It names
 * resources through their display names alone and guards nothing; the later
 * admission repeats every decision and still fails closed.
 *
 * The editor asks about every Team in one call, so the preview costs one query
 * rather than one per grant row.
 */
export async function listSessionTeamCredentialBindingConsequencesInTx(
    tx: Tx,
    input: Readonly<{ sessionId: string; teamIds: readonly string[] }>,
): Promise<readonly SessionTeamCredentialBindingConsequence[]> {
    if (input.teamIds.length === 0) return [];
    const rows = (await Promise.all(portableQueryChunks({
        values: [...new Set(input.teamIds)], bindingsPerValue: 1,
        fixedBindings: CONDITIONAL_SESSION_USE_POLICIES.length + 2, // Session id and Prisma OFFSET.
    }).map(teamIds => tx.sessionTeamCredentialBinding.findMany({
        where: {
            sessionId: input.sessionId,
            resource: {
                teamId: { in: [...teamIds] },
                sessionUsePolicy: { in: [...CONDITIONAL_SESSION_USE_POLICIES] },
            },
        },
        select: { resource: { select: { id: true, displayName: true, teamId: true, sessionUsePolicy: true } } },
        orderBy: [{ resourceId: "asc" }],
    })))).flat().sort((left, right) => left.resource.id < right.resource.id ? -1 : left.resource.id > right.resource.id ? 1 : 0);
    const seen = new Set<string>();
    return rows.flatMap(({ resource }) => {
        if (seen.has(resource.id)) return [];
        seen.add(resource.id);
        const policy = CONDITIONAL_SESSION_USE_POLICIES
            .find((candidate) => candidate === resource.sessionUsePolicy);
        if (!policy) return [];
        return [{ resourceId: resource.id, displayName: resource.displayName, teamId: resource.teamId, policy }];
    });
}

/**
 * Admit a bound resource using current Team authority; the binding is only a
 * witness of the accepted selection — which resource, on which route.
 *
 * The witness's recorded revision is deliberately not a precondition here. The
 * resource revision is a mutable policy fact rechecked online against the
 * current resource on every use; the expected revision is a precondition of the
 * selection mutation only, not a second persisted mirror that every later
 * policy edit would strand (`04-private-iroh-broker-transport.md:272`,
 * `11-integrated-security-qa-and-completion.md` A2(4)). No production writer
 * advances the witness after a resource edit, and none is needed.
 */
export async function admitSessionTeamCredentialBindingInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        slot: SessionTeamCredentialSlotV1;
        deliveryMode: TeamCredentialRouteV1;
        authentication: SessionAccessAuthentication;
        /**
         * A revision the caller itself presents (a fresh open's accepted one);
         * never the witness's recorded revision.
         */
        expectedResourceRevision?: number;
        /** The broker Machine this operation already froze, when it has one. */
        expectedBrokerMachineId?: string;
        brokerSelection?: TeamCredentialBrokerPlacementSelection;
    }>,
): Promise<SessionTeamCredentialAdmissionResult> {
    const binding = await readSessionTeamCredentialBindingInTx(tx, input);
    if (!binding) return { ok: false, reason: "binding_missing" };
    return validateExistingSessionTeamCredentialResourceInTx(tx, {
        sessionId: input.sessionId,
        accountId: input.accountId,
        resourceId: binding.resourceId,
        ...(input.expectedResourceRevision !== undefined
            ? { expectedResourceRevision: input.expectedResourceRevision }
            : {}),
        ...(input.expectedBrokerMachineId !== undefined
            ? { expectedBrokerMachineId: input.expectedBrokerMachineId }
            : {}),
        ...(input.brokerSelection ? { brokerSelection: input.brokerSelection } : {}),
        deliveryMode: binding.deliveryMode,
        authentication: input.authentication,
    });
}

/** The effect that uses a Team credential: a Session, or an Execution Run. */
export type TeamCredentialOperationConsumer =
    | Readonly<{ kind: "session"; sessionId: string }>
    | Readonly<{
        kind: "execution_run";
        /** The Run's host Session, or null for a detached Run. */
        parentSessionId: string | null;
        /** The resource this Run's own admitted operation names. */
        resourceId: string;
    }>;

/**
 * The one current-authority admission for a credential consumer.
 *
 * A Session is admitted through its accepted selection witness. An Execution
 * Run is its own independently owned binding (`PLAN.md` §2.3): it is admitted
 * for the exact resource its Home-admitted operation names — never through its
 * parent Session's selection, so a Run on B beside a parent on A works and does
 * not follow later parent edits. An attached Run still runs in its parent
 * Session's context, so the parent's ownership and Session-use policy (Team
 * context and visibility) apply to it; a detached Run has no Session context.
 */
export async function admitTeamCredentialOperationBindingInTx(
    tx: Tx,
    input: Readonly<{
        consumer: TeamCredentialOperationConsumer;
        accountId: string;
        slot: SessionTeamCredentialSlotV1;
        deliveryMode: TeamCredentialRouteV1;
        authentication: SessionAccessAuthentication;
        /** A fresh open's accepted revision; every other use adopts the current one. */
        expectedResourceRevision?: number;
        expectedBrokerMachineId?: string;
        brokerSelection?: TeamCredentialBrokerPlacementSelection;
    }>,
): Promise<SessionTeamCredentialAdmissionResult> {
    const placement = {
        ...(input.expectedResourceRevision !== undefined
            ? { expectedResourceRevision: input.expectedResourceRevision }
            : {}),
        ...(input.expectedBrokerMachineId !== undefined
            ? { expectedBrokerMachineId: input.expectedBrokerMachineId }
            : {}),
        ...(input.brokerSelection ? { brokerSelection: input.brokerSelection } : {}),
    };
    if (input.consumer.kind === "session") {
        return await admitSessionTeamCredentialBindingInTx(tx, {
            sessionId: input.consumer.sessionId,
            accountId: input.accountId,
            slot: input.slot,
            deliveryMode: input.deliveryMode,
            authentication: input.authentication,
            ...placement,
        });
    }
    return input.consumer.parentSessionId === null
        ? await validatePlannedSessionTeamCredentialResourceInTx(tx, {
            accountId: input.accountId,
            resourceId: input.consumer.resourceId,
            ...placement,
            deliveryMode: input.deliveryMode,
            plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
            authentication: input.authentication,
        })
        : await validateExistingSessionTeamCredentialResourceInTx(tx, {
            sessionId: input.consumer.parentSessionId,
            accountId: input.accountId,
            resourceId: input.consumer.resourceId,
            ...placement,
            deliveryMode: input.deliveryMode,
            authentication: input.authentication,
        });
}
