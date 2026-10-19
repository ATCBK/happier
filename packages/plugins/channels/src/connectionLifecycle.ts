import {
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
  MAX_CONVERSATION_OBSERVATION_AGE_MS,
  type ConversationJsonObjectV1,
  type ConversationJsonValueV1,
  type ConversationConnectionHistoryGapFactV1,
  type ConversationProviderDiagnosticV1,
  type ConversationProviderFailureReasonV1,
  type ConversationProviderConnectionStopInputV1,
  type ConversationProviderReadinessAttentionCodeV1,
  type ConversationTransportFactReportInputV1,
  type ConversationTransportKindV1,
} from '@happier-dev/channels-protocol/v1';
import {
  arePluginMachineExecutionOriginsEqual,
  getPluginMachineExecutionOriginRef,
  type PluginInvocationCaller,
  type PluginMachineMaterializationRefV1,
} from '@happier-dev/plugin-sdk';
import { PluginMachineExecutionOriginV1JsonSchema } from '@happier-dev/plugin-sdk/collections';
import { PluginWebhookEndpointIdV1JsonSchema } from '@happier-dev/plugin-sdk/webhooks';
import { PluginContributionIdentityV1JsonSchema } from '@happier-dev/plugin-sdk/manifest';
import {
  PluginMachineExecutionOriginV1Schema,
  PluginMachineExecutionRoutingV1JsonSchema,
  PluginMachineExecutionRoutingV1Schema,
  getPluginMachineExecutionRouting,
  type PluginMachineExecutionOriginV1,
  type PluginMachineExecutionRoutingV1,
} from '@happier-dev/plugin-sdk/actions';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

/** A retained connection follows the current admitted provider at this placement. */
export type ConversationConnectionTransportOriginV1 = Readonly<Pick<PluginMachineExecutionRoutingV1, 'serverIdentityId' | 'machineId'>>;

export const ConversationConnectionTransportOriginV1JsonSchema: PluginJsonSchema = {
  type: 'object',
  properties: {
    serverIdentityId: PluginMachineExecutionRoutingV1JsonSchema.properties!.serverIdentityId!,
    machineId: PluginMachineExecutionRoutingV1JsonSchema.properties!.machineId!,
  },
  required: ['serverIdentityId', 'machineId'],
  additionalProperties: false,
};
const placementValidator = compilePluginJsonSchema(ConversationConnectionTransportOriginV1JsonSchema);
export const ConversationConnectionTransportOriginV1Schema = {
  parse(value: unknown): ConversationConnectionTransportOriginV1 {
    if (!isValidPluginJsonSchemaValue(placementValidator, value)) throw new Error('Invalid Channels transport placement.');
    return value as ConversationConnectionTransportOriginV1;
  },
  safeParse(value: unknown) {
    try { return { success: true as const, data: this.parse(value) }; }
    catch (error) { return { success: false as const, error }; }
  },
};

export function getConversationConnectionTransportOrigin(origin: PluginMachineExecutionOriginV1): ConversationConnectionTransportOriginV1 {
  const { serverIdentityId, machineId } = getPluginMachineExecutionRouting(origin);
  return Object.freeze({ serverIdentityId, machineId });
}

export function getConversationConnectionExecutionRouting(origin: ConversationConnectionTransportOriginV1, providerPluginId: string): PluginMachineExecutionRoutingV1 {
  return PluginMachineExecutionRoutingV1Schema.parse({ ...origin, pluginId: providerPluginId });
}

export function areConversationConnectionTransportOriginsEqual(left: ConversationConnectionTransportOriginV1, right: ConversationConnectionTransportOriginV1): boolean {
  return left.serverIdentityId === right.serverIdentityId && left.machineId === right.machineId;
}

import type { PersistedConversationProviderContributionSelection } from './collections.js';

/**
 * Read only a complete host-stamped origin whose identity agrees with the
 * immediate caller. The candidate uses the stamp's own Home/Machine evidence,
 * never facts copied from a retained connection or mutable Action input.
 */
export function getSelfStampedPluginCallerExecutionOrigin(
  caller: PluginInvocationCaller | undefined,
): PluginMachineExecutionOriginV1 | undefined {
  if (caller?.kind !== 'plugin') return undefined;
  const origin = PluginMachineExecutionOriginV1Schema.safeParse(caller.executionOrigin);
  if (!origin.success) return undefined;
  const ref = getPluginMachineExecutionOriginRef(origin.data);
  const candidate = PluginMachineExecutionOriginV1Schema.safeParse('sourceRef' in origin.data
    ? { serverIdentityId: origin.data.serverIdentityId, sourceRef: {
      machineId: ref.machineId, pluginId: caller.pluginId, sourceCustody: caller.sourceCustody,
    } }
    : { serverIdentityId: origin.data.serverIdentityId, materializationRef: caller.materialization });
  return ref.pluginId === caller.pluginId && candidate.success
    && arePluginMachineExecutionOriginsEqual(origin.data, candidate.data)
    ? origin.data
    : undefined;
}

/**
 * Canonical pure connection-lifecycle transitions shared by online management
 * Actions and Account-local desired-state CAS. The caller owns row revision,
 * provider invocation, confirmation, and final tombstoning; this module owns
 * only the field-sensitive Channel authority state.
 */

export type ConversationConnectionOverlapSafetyV1 =
  | 'safe'
  | 'providerExclusive'
  | 'destructive';

export type ConversationConnectionDeletionStateV1 =
  | 'none'
  | 'pendingStopReconciliation'
  | 'finalizingDelete';

export type ConversationConnectionHistoryGapV1 = ConversationConnectionHistoryGapFactV1 & Readonly<{
  reportedAt: number;
}>;

/**
 * Provider-neutral, remotely repairable readiness attention retained by the
 * canonical connection lifecycle. A null value is the explicit current-ready
 * state; provider-specific recovery remains outside this common projection.
 */
export type ConversationConnectionProviderReadinessV1 = Readonly<{
  code: ConversationProviderReadinessAttentionCodeV1;
  diagnostic?: ConversationProviderDiagnosticV1;
}> | null;

/**
 * The sole durable poll-supervisor disposition. It records only provider
 * facts or the reduced cross-boundary Action error that survives execution;
 * it never turns a thrown error into a retryability decision.
 */
export type ConversationConnectionPollFailureEvidenceV1 =
  | Readonly<{
    kind: 'provider';
    reason: ConversationProviderFailureReasonV1;
    diagnostic?: string;
  }>
  | Readonly<{
    kind: 'action';
    code: string;
    message: string;
  }>;

export type ConversationConnectionPollFailureV1 =
  | Readonly<{
    phase: 'retryDue';
    attemptCount: number;
    retryNotBeforeMs: number;
    evidence: ConversationConnectionPollFailureEvidenceV1;
  }>
  | Readonly<{
    phase: 'blocked';
    attemptCount: number;
    retryNotBeforeMs: null;
    evidence: ConversationConnectionPollFailureEvidenceV1;
  }>;

/**
 * The immutable invocation facts from the connection row that created an
 * old-transport custody slot. A returning checkpointed poll may settle that
 * slot only when its capture matches this predecessor exactly; later policy
 * or failure writes may advance the live row revision without changing this
 * proof.
 */
export type ConversationCheckpointedPollInvocationBasisV1 = Readonly<{
  connectionRevision: number;
  authorityEpoch: number;
  transportOrigin: ConversationConnectionTransportOriginV1;
}>;

/**
 * Whether the retired transport still owes the one durable-endpoint retarget
 * that moves an already-owned Account webhook onto the replacement target.
 *
 * `pending` is recoverable intent: the connection CAS commits it before the
 * generic endpoint is touched, so a retry or a response-loss rejoin resumes
 * the exact same idempotent retarget instead of leaving the endpoint and the
 * retained row naming different targets. Every other transfer freezes
 * `notRequired`; settlement removes the whole slot rather than adding a
 * terminal phase nothing reads.
 */
export type ConversationPendingEndpointRetargetV1 = 'notRequired' | 'pending';

/**
 * The one connection-owned durable custody slot for an old physical transport.
 * Its frozen request and exact admitted contribution selection are the only
 * authority for a later stop settlement. It is not a retry ledger, mutable
 * selector, or a carrier for replacement setup input.
 */
export type ConversationPendingProviderStopV1 = Readonly<{
  /** Exact predecessor facts that authorize a captured checkpointed poll. */
  predecessorCheckpointedPollInvocation: ConversationCheckpointedPollInvocationBasisV1;
  transportOrigin: ConversationConnectionTransportOriginV1;
  /** Exact incumbent contribution/generation used only for the deferred stop. */
  providerContributionSelection: PersistedConversationProviderContributionSelection;
  stopRequest: Readonly<ConversationProviderConnectionStopInputV1>;
  /**
   * The retired transport itself. A transfer replaces the row's transport in
   * the same CAS that freezes this slot, so every later rejoin or settlement
   * decision must read the predecessor from here rather than from the live
   * row, which already names the replacement.
   */
  predecessorTransportKind: ConversationTransportKindV1;
  endpointRetarget: ConversationPendingEndpointRetargetV1;
  overlapSafety: ConversationConnectionOverlapSafetyV1;
  acceptedPossibleLoss: boolean;
}>;

/** Account endpoint convergence has no provider process or poll to stop. */
export type ConversationPendingEndpointRetargetIntentV1 = Readonly<{
  kind: 'endpointRetarget';
  webhookEndpointId: string;
  webhookContributionRef: Readonly<{ pluginId: string; localId: string }>;
  webhookSourceInstanceId: string;
  targetMaterialization: PluginMachineMaterializationRefV1;
  transferAuthorityEpoch: number;
}>;
export type ConversationPendingOldTransportStopV1 = ConversationPendingProviderStopV1 | ConversationPendingEndpointRetargetIntentV1;
export const ConversationPendingEndpointRetargetIntentV1JsonSchema: PluginJsonSchema = {
  type: 'object',
  properties: {
    kind: { const: 'endpointRetarget' },
    webhookEndpointId: PluginWebhookEndpointIdV1JsonSchema,
    webhookContributionRef: PluginContributionIdentityV1JsonSchema,
    webhookSourceInstanceId: { type: 'string', minLength: 1, maxLength: 256 },
    targetMaterialization: PluginMachineExecutionOriginV1JsonSchema.anyOf![0]!.properties!.materializationRef!,
    transferAuthorityEpoch: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
  required: ['kind', 'webhookEndpointId', 'webhookContributionRef', 'webhookSourceInstanceId', 'targetMaterialization', 'transferAuthorityEpoch'],
  additionalProperties: false,
};
const endpointIntentValidator = compilePluginJsonSchema(ConversationPendingEndpointRetargetIntentV1JsonSchema);
export function readConversationPendingEndpointRetargetIntent(value: unknown): ConversationPendingEndpointRetargetIntentV1 {
  if (!isValidPluginJsonSchemaValue(endpointIntentValidator, value)) throw new Error('Invalid Channels endpoint-retarget intent.');
  return freezeJsonValue(value as ConversationJsonValueV1) as ConversationPendingEndpointRetargetIntentV1;
}
export function isConversationPendingEndpointRetarget(pending: unknown): pending is ConversationPendingEndpointRetargetIntentV1 {
  return pending !== null && typeof pending === 'object' && 'kind' in pending && pending.kind === 'endpointRetarget';
}

/** A frozen delete request is the only delete transition input. */
export type ConversationDeleteStopRequestV1 = Readonly<
  Omit<ConversationProviderConnectionStopInputV1, 'reason'> & Readonly<{
    reason: 'delete';
  }>
>;

/** A frozen transfer request is the only transfer transition input. */
export type ConversationTransferStopRequestV1 = Readonly<
  Omit<ConversationProviderConnectionStopInputV1, 'reason'> & Readonly<{
    reason: 'transfer';
  }>
>;

export type ConversationPendingOldTransportStopDeleteStartV1 = Readonly<{
  predecessorCheckpointedPollInvocation: ConversationCheckpointedPollInvocationBasisV1;
  transportOrigin: ConversationConnectionTransportOriginV1;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
  stopRequest: ConversationDeleteStopRequestV1;
  predecessorTransportKind: ConversationTransportKindV1;
}>;

export type ConversationPendingOldTransportStopTransferStartV1 = ConversationPendingEndpointRetargetIntentV1 | Readonly<{
  predecessorCheckpointedPollInvocation: ConversationCheckpointedPollInvocationBasisV1;
  transportOrigin: ConversationConnectionTransportOriginV1;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
  stopRequest: ConversationTransferStopRequestV1;
  predecessorTransportKind: ConversationTransportKindV1;
  endpointRetarget: ConversationPendingEndpointRetargetV1;
}>;

/**
 * The lifecycle-owned projection of a validated private connection payload.
 * It intentionally excludes provider configuration, credentials, and origin:
 * this transition never decodes or reselects any of those authorities.
 */
export type ConversationConnectionLifecycleStateV1 = Readonly<{
  authorityEpoch: number;
  enabled: boolean;
  deletionState: ConversationConnectionDeletionStateV1;
  overlapSafety: ConversationConnectionOverlapSafetyV1;
  pendingOldTransportStop: ConversationPendingOldTransportStopV1 | null;
  historyGap: ConversationConnectionHistoryGapV1 | null;
  providerReadiness: ConversationConnectionProviderReadinessV1;
  pollFailure: ConversationConnectionPollFailureV1 | null;
  maximumObservationAgeMs: number;
  /**
   * The earliest occurrence time that may use a subsequently widened age
   * window. It is connection-local replay history, never an occurrence
   * tombstone: existing censuses continue to own their frozen windows.
   */
  observationAgeExpansionFloorOccurredAt: number | null;
}>;

/** The Account-local policy facts mutable by the ordinary connection Action. */
export type ConversationConnectionRequestedStateV1 = Readonly<{
  enabled: boolean;
  maximumObservationAgeMs: number;
}>;

export type ConversationConnectionDeleteStartResultV1 =
  | Readonly<{ kind: 'deletePending'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'rejoined'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{
    kind: 'rejected';
    code:
      | 'authorityEpochExhausted'
      | 'oldTransportStopPending'
      | 'endpointRetargetRepairRequired'
      | 'stopRequestInvalid';
  }>;

export type ConversationConnectionTransferStartResultV1 =
  | Readonly<{ kind: 'transferPendingOldStop'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{
    kind: 'rejected';
    code:
      | 'deleteInProgress'
      | 'oldTransportStopPending'
      | 'endpointRetargetRepairRequired'
      | 'authorityEpochExhausted'
      | 'stopRequestInvalid';
  }>;

export type ConversationConnectionStopConfirmationResultV1 =
  | Readonly<{ kind: 'deleteFinalizing'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'transportStopConfirmed'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'staleAuthority' }>;

export type ConversationConnectionAbandonResultV1 =
  | Readonly<{ kind: 'deleteFinalizing'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'transferAbandoned'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'rejoined'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'staleAuthority' }>
  | Readonly<{
    kind: 'rejected';
    code: 'authorityEpochExhausted' | 'endpointRetargetRepairRequired';
  }>;

export type ConversationConnectionEnabledResultV1 =
  | Readonly<{ kind: 'updated'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'unchanged'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{
    kind: 'rejected';
    code: 'deleteInProgress' | 'oldTransportStopPending' | 'authorityEpochExhausted' | 'maximumObservationAgeInvalid';
  }>;

export type ConversationConnectionTransitionResultV1 = ConversationConnectionEnabledResultV1;

export type ConversationConnectionHistoryGapResultV1 =
  | Readonly<{ kind: 'recorded'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'rejoined'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'staleAuthority' }>;

export type ConversationConnectionProviderReadinessResultV1 =
  | Readonly<{ kind: 'recorded'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'rejoined'; connection: ConversationConnectionLifecycleStateV1 }>
  | Readonly<{ kind: 'staleAuthority' }>;

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

function hasAuthoritySteps(
  authorityEpoch: number,
  steps: number,
): boolean {
  return authorityEpoch <= MAX_SAFE_INTEGER - steps;
}

function hasValidMaximumObservationAge(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= MIN_CONVERSATION_OBSERVATION_AGE_MS
    && value <= MAX_CONVERSATION_OBSERVATION_AGE_MS;
}

function hasValidNonNegativeTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function freezeJsonValue(value: ConversationJsonValueV1): ConversationJsonValueV1 {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeJsonValue(entry)));
  if (value === null || typeof value !== 'object') return value;
  const copy: Record<string, ConversationJsonValueV1> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = freezeJsonValue(entry);
  return Object.freeze(copy) as ConversationJsonObjectV1;
}

export function freezeConversationConnectionTransportOrigin(
  origin: ConversationConnectionTransportOriginV1,
): ConversationConnectionTransportOriginV1 {
  return Object.freeze({ ...ConversationConnectionTransportOriginV1Schema.parse(origin) });
}

function freezeCheckpointedPollInvocationBasis(
  basis: ConversationCheckpointedPollInvocationBasisV1,
): ConversationCheckpointedPollInvocationBasisV1 {
  return Object.freeze({
    connectionRevision: basis.connectionRevision,
    authorityEpoch: basis.authorityEpoch,
    transportOrigin: freezeConversationConnectionTransportOrigin(basis.transportOrigin),
  });
}

function freezeProviderContributionSelection(
  selection: PersistedConversationProviderContributionSelection,
): PersistedConversationProviderContributionSelection {
  return Object.freeze({
    contributionId: selection.contributionId,
  });
}

function freezeStopRequest(
  request: Readonly<ConversationProviderConnectionStopInputV1>,
): Readonly<ConversationProviderConnectionStopInputV1> {
  return Object.freeze({
    v: request.v,
    connectionId: request.connectionId,
    providerConnectionKey: request.providerConnectionKey,
    providerConfigVersion: request.providerConfigVersion,
    providerConfig: freezeJsonValue(request.providerConfig),
    credentialRef: request.credentialRef === null
      ? null
      : Object.freeze({
        service: Object.freeze({
          pluginId: request.credentialRef.service.pluginId,
          localId: request.credentialRef.service.localId,
        }),
        accountId: request.credentialRef.accountId,
      }),
    authorityEpoch: request.authorityEpoch,
    reason: request.reason,
  });
}

type ConversationProviderReadinessFactV1 = Extract<
  ConversationTransportFactReportInputV1['fact'],
  Readonly<{ kind: 'providerReadiness' }>
>;

function providerReadinessFromFact(
  fact: ConversationProviderReadinessFactV1,
): ConversationConnectionProviderReadinessV1 {
  if (fact.status === 'ready') return null;
  return Object.freeze({
    code: fact.code,
    ...(fact.diagnostic === undefined ? {} : { diagnostic: fact.diagnostic }),
  });
}

function areConversationProviderReadinessStatesEqual(
  left: ConversationConnectionProviderReadinessV1,
  right: ConversationConnectionProviderReadinessV1,
): boolean {
  return left === right
    || (left !== null
      && right !== null
      && left.code === right.code
      && left.diagnostic === right.diagnostic);
}

/**
 * Normalizes a retained old-stop slot. The delete and transfer transitions
 * are its only constructors; Account parsing uses the same owner for either
 * reason so later confirmation or explicit abandonment sees exact custody.
 */
export function freezeConversationPendingOldTransportStop(input: Readonly<{
  predecessorCheckpointedPollInvocation: ConversationCheckpointedPollInvocationBasisV1;
  transportOrigin: ConversationConnectionTransportOriginV1;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
  stopRequest: Readonly<ConversationProviderConnectionStopInputV1>;
  predecessorTransportKind: ConversationTransportKindV1;
  endpointRetarget: ConversationPendingEndpointRetargetV1;
  overlapSafety: ConversationConnectionOverlapSafetyV1;
  acceptedPossibleLoss: boolean;
}>): ConversationPendingProviderStopV1 {
  return Object.freeze({
    predecessorCheckpointedPollInvocation: freezeCheckpointedPollInvocationBasis(
      input.predecessorCheckpointedPollInvocation,
    ),
    transportOrigin: freezeConversationConnectionTransportOrigin(input.transportOrigin),
    providerContributionSelection: freezeProviderContributionSelection(
      input.providerContributionSelection,
    ),
    stopRequest: freezeStopRequest(input.stopRequest),
    predecessorTransportKind: input.predecessorTransportKind,
    endpointRetarget: input.endpointRetarget,
    overlapSafety: input.overlapSafety,
    acceptedPossibleLoss: input.acceptedPossibleLoss,
  });
}

function hasCurrentCheckpointedPollInvocationBasis(input: Readonly<{
  currentAuthorityEpoch: number;
  pendingOldTransportOrigin: ConversationConnectionTransportOriginV1;
  basis: ConversationCheckpointedPollInvocationBasisV1;
}>): boolean {
  return Number.isSafeInteger(input.basis.connectionRevision)
    && input.basis.connectionRevision >= 1
    && Number.isSafeInteger(input.basis.authorityEpoch)
    && input.basis.authorityEpoch === input.currentAuthorityEpoch
    && areConversationConnectionTransportOriginsEqual(
      input.basis.transportOrigin,
      input.pendingOldTransportOrigin,
    );
}

/**
 * The one incumbent-overlap decision used by every replacement transport
 * entry point. Desired connection enablement remains independent policy;
 * only the old transport's frozen destructive class withholds replacement
 * effects until exact settlement or authorized acceptance settles custody.
 */
export function hasUnsettledDestructiveOldTransportStop(input: Readonly<{
  authorityEpoch: number;
  deletionState: ConversationConnectionDeletionStateV1;
  pendingOldTransportStop: ConversationPendingOldTransportStopV1 | null;
}>): boolean {
  return input.deletionState === 'none'
    && input.pendingOldTransportStop !== null
    && !isConversationPendingEndpointRetarget(input.pendingOldTransportStop)
    && input.pendingOldTransportStop.overlapSafety === 'destructive'
    && (!input.pendingOldTransportStop.acceptedPossibleLoss
      || !hasAcceptedConversationTransferLoss(input));
}

/**
 * Whether the retained custody owes only the durable-endpoint move.
 *
 * That obligation is an idempotent target change on an Account endpoint
 * Happier itself owns — not a foreign consumer that may still be running and
 * observing. It is discharged by repairing it, by a later transfer that names a
 * newer desired target the same repair converges on. Delete waits for repair.
 * None of those is an accepted loss, so the
 * slot never becomes a permanent mistarget disclosure.
 */
export function owesOnlyConversationEndpointRetarget(
  pending: ConversationPendingOldTransportStopV1 | null,
): pending is ConversationPendingEndpointRetargetIntentV1 {
  return isConversationPendingEndpointRetarget(pending);
}

/**
 * A retained accepted transfer slot is settled owner disclosure, not live
 * stop custody. It may survive ordinary policy writes and be atomically
 * replaced by the next exact-current destructive operation.
 */
export function hasAcceptedConversationTransferLoss(input: Readonly<{
  authorityEpoch: number;
  deletionState: ConversationConnectionDeletionStateV1;
  pendingOldTransportStop: ConversationPendingOldTransportStopV1 | null;
}>): boolean {
  const pending = input.pendingOldTransportStop;
  return input.deletionState === 'none'
    && pending !== null
    && !isConversationPendingEndpointRetarget(pending)
    && pending.stopRequest.reason === 'transfer'
    && pending.acceptedPossibleLoss
    // The abandon CAS first establishes E+1 for the frozen E request. Later
    // ordinary policy writes may advance the connection epoch again, but must
    // not turn settled disclosure back into stranded live-stop custody.
    // A schema-valid marker that is not past its frozen request remains
    // unresolved custody rather than authorizing an update or replacement.
    //
    // The strict advance below is the whole rule: with both epochs proven safe
    // integers and the frozen request at least 1, it already implies the
    // connection epoch is above 1 and the frozen request below the safe-integer
    // ceiling, so restating either as its own conjunct only looks like a bound.
    && Number.isSafeInteger(input.authorityEpoch)
    && Number.isSafeInteger(pending.stopRequest.authorityEpoch)
    && pending.stopRequest.authorityEpoch >= 1
    && input.authorityEpoch > pending.stopRequest.authorityEpoch;
}

/**
 * The one admission predicate for replacing retained old-transport custody.
 *
 * Settled accepted loss is disclosure rather than live custody and may be
 * replaced by either destructive transition. An owed endpoint retarget is
 * different: delete or a durable-to-non-durable transfer would erase the only
 * repair intent while the generic endpoint may already have moved. Only the
 * next authority epoch retaining this connection's same durable endpoint may
 * supersede it and converge that endpoint directly on the newer target.
 */
function decideRetainedOldTransportCustodyReplacement(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  connectionId: string;
  replacement:
    | Readonly<{ kind: 'delete' }>
    | Readonly<{
      kind: 'transfer';
      pendingOldTransportStop: ConversationPendingOldTransportStopTransferStartV1;
    }>;
}>): 'allowed' | 'oldTransportStopPending' | 'endpointRetargetRepairRequired' {
  const pending = input.current.pendingOldTransportStop;
  if (pending === null) return 'allowed';
  if (!isConversationPendingEndpointRetarget(pending)
    && pending.stopRequest.connectionId !== input.connectionId) return 'oldTransportStopPending';
  if (hasAcceptedConversationTransferLoss(input.current)) return 'allowed';
  if (!owesOnlyConversationEndpointRetarget(pending)) return 'oldTransportStopPending';

  if (input.replacement.kind === 'transfer'
    && pending.transferAuthorityEpoch === input.current.authorityEpoch
    && isConversationPendingEndpointRetarget(input.replacement.pendingOldTransportStop)
    && input.replacement.pendingOldTransportStop.webhookEndpointId === pending.webhookEndpointId
    && input.replacement.pendingOldTransportStop.webhookSourceInstanceId === pending.webhookSourceInstanceId
    && input.replacement.pendingOldTransportStop.webhookContributionRef.pluginId === pending.webhookContributionRef.pluginId
    && input.replacement.pendingOldTransportStop.webhookContributionRef.localId === pending.webhookContributionRef.localId
    && input.replacement.pendingOldTransportStop.transferAuthorityEpoch > pending.transferAuthorityEpoch) {
    return 'allowed';
  }
  return 'endpointRetargetRepairRequired';
}

/**
 * The sole field-sensitive desired-state transition for an existing
 * connection. It is shared by online management Actions and Account-local
 * desired-state CAS; callers keep row/currentness and provider authority.
 */
export function transitionConversationConnection(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  requested: ConversationConnectionRequestedStateV1;
  /** The one row-write timestamp captured by the Account-local CAS owner. */
  now?: number;
}>): ConversationConnectionTransitionResultV1 {
  const { current, requested } = input;
  if (!hasValidMaximumObservationAge(requested.maximumObservationAgeMs)) {
    return { kind: 'rejected', code: 'maximumObservationAgeInvalid' };
  }
  if (current.deletionState !== 'none') {
    return { kind: 'rejected', code: 'deleteInProgress' };
  }
  const enabledChanged = current.enabled !== requested.enabled;
  const maximumObservationAgeChanged = current.maximumObservationAgeMs !== requested.maximumObservationAgeMs;
  if (!enabledChanged && !maximumObservationAgeChanged) {
    return { kind: 'unchanged', connection: current };
  }
  // Unsettled stop custody carries the current authority epoch, so an
  // enabled-state change would make exact stop proof impossible. Accepted
  // transfer loss is already-settled disclosure rather than live custody and
  // remains admissible across ordinary policy epochs.
  if (enabledChanged
    && current.pendingOldTransportStop !== null
    && !hasAcceptedConversationTransferLoss(current)) {
    return { kind: 'rejected', code: 'oldTransportStopPending' };
  }
  if (enabledChanged && !hasAuthoritySteps(current.authorityEpoch, 1)) {
    return { kind: 'rejected', code: 'authorityEpochExhausted' };
  }

  // Widening the live window cannot make an occurrence that was already past
  // the previous window eligible again after its finite census was pruned.
  // The connection keeps only this monotonic timestamp floor, while an
  // occurrence that was still fresh at the edit and later observations can
  // use the wider requested window.
  const observationAgeExpansionFloorOccurredAt = requested.maximumObservationAgeMs
    > current.maximumObservationAgeMs
    ? (() => {
      const now = input.now ?? 0;
      if (!hasValidNonNegativeTimestamp(now)) {
        throw new Error('Connection observation-age expansion requires a non-negative safe timestamp.');
      }
      const currentFloor = current.observationAgeExpansionFloorOccurredAt ?? 0;
      const preservedFreshnessFloor = Math.max(0, now - current.maximumObservationAgeMs);
      const nextFloor = Math.max(currentFloor, preservedFreshnessFloor);
      return nextFloor === 0 ? null : nextFloor;
    })()
    : current.observationAgeExpansionFloorOccurredAt;

  return {
    kind: 'updated',
    connection: {
      ...current,
      enabled: requested.enabled,
      maximumObservationAgeMs: requested.maximumObservationAgeMs,
      // Desired-state edits never settle frozen stop custody. An enabled
      // change above admits only settled accepted loss; a configuration-only
      // edit keeps an unresolved slot until its exact stop settlement.
      pendingOldTransportStop: current.pendingOldTransportStop,
      pollFailure: null,
      observationAgeExpansionFloorOccurredAt,
      ...(enabledChanged
        ? {
          authorityEpoch: current.authorityEpoch + 1,
          // A replacement baseline may already have durably advanced its
          // checkpoint and still be covering retained censuses. Keep that
          // ingress fence across policy epochs so the same owner can rejoin
          // coverage under the new row revision before admitting ingress.
          historyGap: current.historyGap,
          providerReadiness: null,
        }
        : {}),
    },
  };
}

/**
 * Commits logical delete intent and the one exact old-stop request before any
 * provider stop attempt. Finalizing does not need a second authority advance:
 * the persisted stop request is already fenced at the new pending epoch.
 */
export function startConversationConnectionDelete(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  pendingOldTransportStop: ConversationPendingOldTransportStopDeleteStartV1;
}>): ConversationConnectionDeleteStartResultV1 {
  const { current } = input;
  if (current.deletionState !== 'none') {
    return { kind: 'rejoined', connection: current };
  }
  const custodyDecision = decideRetainedOldTransportCustodyReplacement({
    current,
    connectionId: input.pendingOldTransportStop.stopRequest.connectionId,
    replacement: { kind: 'delete' },
  });
  if (custodyDecision !== 'allowed') {
    return { kind: 'rejected', code: custodyDecision };
  }
  if (!hasAuthoritySteps(current.authorityEpoch, 1)) {
    return { kind: 'rejected', code: 'authorityEpochExhausted' };
  }
  const pendingAuthorityEpoch = current.authorityEpoch + 1;
  if (input.pendingOldTransportStop.stopRequest.reason !== 'delete'
    || input.pendingOldTransportStop.stopRequest.authorityEpoch !== pendingAuthorityEpoch
    || !hasCurrentCheckpointedPollInvocationBasis({
      currentAuthorityEpoch: current.authorityEpoch,
      pendingOldTransportOrigin: input.pendingOldTransportStop.transportOrigin,
      basis: input.pendingOldTransportStop.predecessorCheckpointedPollInvocation,
    })) {
    return { kind: 'rejected', code: 'stopRequestInvalid' };
  }
  return {
    kind: 'deletePending',
    connection: {
      ...current,
      authorityEpoch: pendingAuthorityEpoch,
      enabled: false,
      deletionState: 'pendingStopReconciliation',
      pendingOldTransportStop: freezeConversationPendingOldTransportStop({
        ...input.pendingOldTransportStop,
        // Delete keeps the incumbent endpoint exactly where it is; only a
        // replacement transport can owe a retarget.
        endpointRetarget: 'notRequired',
        overlapSafety: current.overlapSafety,
        acceptedPossibleLoss: false,
      }),
      // Final deletion owns physical row reclamation. Until then, preserve a
      // staged-baseline fence so an interrupted delete cannot orphan retained
      // uncovered censuses behind a durably advanced checkpoint.
      historyGap: current.historyGap,
      providerReadiness: null,
      pollFailure: null,
    },
  };
}

/**
 * Replaces a non-durable connection's transport authority under the one
 * connection epoch. The caller has already proved immutable provider identity
 * and replacement setup/test facts; this owner freezes only the old stop
 * request and replacement lifecycle fields before any old-transport effect.
 */
export function startConversationConnectionTransfer(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  pendingOldTransportStop: ConversationPendingOldTransportStopTransferStartV1;
  replacement: Readonly<{
    enabled: boolean;
    overlapSafety: ConversationConnectionOverlapSafetyV1;
    historyGap: ConversationConnectionHistoryGapV1 | null;
  }>;
}>): ConversationConnectionTransferStartResultV1 {
  const { current } = input;
  if (current.deletionState !== 'none') {
    return { kind: 'rejected', code: 'deleteInProgress' };
  }
  const custodyDecision = decideRetainedOldTransportCustodyReplacement({
    current,
    connectionId: isConversationPendingEndpointRetarget(input.pendingOldTransportStop) ? '' : input.pendingOldTransportStop.stopRequest.connectionId,
    replacement: {
      kind: 'transfer',
      pendingOldTransportStop: input.pendingOldTransportStop,
    },
  });
  if (custodyDecision !== 'allowed') {
    return { kind: 'rejected', code: custodyDecision };
  }
  if (!hasAuthoritySteps(current.authorityEpoch, 1)) {
    return { kind: 'rejected', code: 'authorityEpochExhausted' };
  }
  const replacementAuthorityEpoch = current.authorityEpoch + 1;
  const pending = input.pendingOldTransportStop;
  const endpointIntent = isConversationPendingEndpointRetarget(pending);
  if (endpointIntent ? pending.transferAuthorityEpoch !== replacementAuthorityEpoch : (pending.stopRequest.reason !== 'transfer'
    || pending.stopRequest.authorityEpoch !== replacementAuthorityEpoch
    // Only a retired durable-push transport owns an Account endpoint whose
    // target can still be moved; nothing else may commit that obligation.
    || pending.endpointRetarget !== 'notRequired'
    || !hasCurrentCheckpointedPollInvocationBasis({
      currentAuthorityEpoch: current.authorityEpoch,
      pendingOldTransportOrigin: pending.transportOrigin,
      basis: pending.predecessorCheckpointedPollInvocation,
    }))) {
    return { kind: 'rejected', code: 'stopRequestInvalid' };
  }
  return {
    kind: 'transferPendingOldStop',
    connection: {
      ...current,
      authorityEpoch: replacementAuthorityEpoch,
      enabled: input.replacement.enabled,
      overlapSafety: input.replacement.overlapSafety,
      pendingOldTransportStop: endpointIntent ? readConversationPendingEndpointRetargetIntent(pending) : freezeConversationPendingOldTransportStop({
        ...pending,
        overlapSafety: current.overlapSafety,
        acceptedPossibleLoss: false,
      }),
      // An existing gap may fence checkpoint-first baseline coverage. A
      // transfer changes authority but must not clear that fence mid-stage;
      // the replacement provider's baseline re-enters and replaces its
      // checkpoint under the new revision.
      historyGap: current.historyGap ?? input.replacement.historyGap,
      providerReadiness: null,
      pollFailure: null,
    },
  };
}

/** The one lifecycle projection after delete custody has been settled. */
function finalizingConversationConnectionDelete(
  current: ConversationConnectionLifecycleStateV1,
): ConversationConnectionLifecycleStateV1 {
  return {
    ...current,
    deletionState: 'finalizingDelete',
    pendingOldTransportStop: null,
    historyGap: current.historyGap,
    providerReadiness: null,
    pollFailure: null,
  };
}

/**
 * Accepts stop evidence only for the exact authority epoch that was persisted
 * in the pending delete row. Provider/materialization/current-generation
 * verification remains at the Action invocation boundary.
 */
export function confirmConversationConnectionStop(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  reportedAuthorityEpoch: number;
}>): ConversationConnectionStopConfirmationResultV1 {
  const { current, reportedAuthorityEpoch } = input;
  const pending = current.pendingOldTransportStop;
  if (pending === null
    || isConversationPendingEndpointRetarget(pending)
    || pending.acceptedPossibleLoss
    || pending.stopRequest.authorityEpoch !== reportedAuthorityEpoch
    || current.authorityEpoch !== reportedAuthorityEpoch) {
    return { kind: 'staleAuthority' };
  }
  if (pending.stopRequest.reason === 'transfer') {
    if (current.deletionState !== 'none') return { kind: 'staleAuthority' };
    return {
      kind: 'transportStopConfirmed',
      connection: {
        ...current,
        pendingOldTransportStop: null,
      },
    };
  }
  if (
    current.deletionState !== 'pendingStopReconciliation'
    || current.enabled
    || pending.stopRequest.reason !== 'delete'
  ) {
    return { kind: 'staleAuthority' };
  }
  return {
    kind: 'deleteFinalizing',
    connection: finalizingConversationConnectionDelete(current),
  };
}

/**
 * Finalizes a delete whose selected transport has no provider-owned process
 * to stop. The caller establishes that transport fact before invoking this
 * lifecycle owner; this transition only removes the already-fenced Channels
 * reference and never represents an external endpoint revoke or stop proof.
 */
export function finalizeConversationConnectionDeleteWithoutProviderStop(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
}>): Extract<ConversationConnectionStopConfirmationResultV1, Readonly<{
  kind: 'deleteFinalizing';
}>> | Readonly<{ kind: 'staleAuthority' }> {
  const { current } = input;
  const pending = current.pendingOldTransportStop;
  if (
    current.deletionState !== 'pendingStopReconciliation'
    || current.enabled
    || pending === null
    || isConversationPendingEndpointRetarget(pending)
    || pending.acceptedPossibleLoss
    || pending.stopRequest.reason !== 'delete'
    || pending.predecessorTransportKind !== 'durablePush'
  ) {
    return { kind: 'staleAuthority' };
  }
  return {
    kind: 'deleteFinalizing',
    connection: finalizingConversationConnectionDelete(current),
  };
}

/**
 * Settles transfer custody when the retired transport has no provider-owned
 * process. Only a frozen durable-push predecessor qualifies, and its committed
 * endpoint-retarget intent must be discharged by exact caller proof: this
 * transition neither invokes a provider stop, revokes the Account-managed
 * endpoint, nor decides for itself that correspondence moved.
 */
export function finalizeConversationConnectionTransferWithoutProviderStop(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  /**
   * Whether the caller proved the committed endpoint-retarget intent through
   * the generic webhook owner. It must match the frozen obligation exactly, so
   * neither an owed retarget nor an unowed one can be settled by assertion.
   */
  provenEndpointRetarget: boolean;
}>): Extract<ConversationConnectionStopConfirmationResultV1, Readonly<{
  kind: 'transportStopConfirmed';
}>> | Readonly<{ kind: 'staleAuthority' }> {
  const { current } = input;
  const pending = current.pendingOldTransportStop;
  if (current.deletionState !== 'none' || pending === null) return { kind: 'staleAuthority' };
  if (isConversationPendingEndpointRetarget(pending)) {
    if (!input.provenEndpointRetarget || pending.transferAuthorityEpoch !== current.authorityEpoch) return { kind: 'staleAuthority' };
  } else if (pending.acceptedPossibleLoss || pending.stopRequest.reason !== 'transfer'
    || pending.stopRequest.authorityEpoch !== current.authorityEpoch || pending.predecessorTransportKind !== 'durablePush'
    || input.provenEndpointRetarget) return { kind: 'staleAuthority' };
  return {
    kind: 'transportStopConfirmed',
    connection: {
      ...current,
      pendingOldTransportStop: null,
    },
  };
}

/**
 * Explicit owner-authorized escape from a permanently unavailable old
 * transport. It accepts possible loss and fences older work, but never claims
 * the physical consumer stopped or rewrites a history-gap fact.
 */
export function abandonConversationConnectionStop(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
}>): ConversationConnectionAbandonResultV1 {
  const { current } = input;
  if (current.deletionState === 'finalizingDelete') {
    return { kind: 'rejoined', connection: current };
  }
  const pending = current.pendingOldTransportStop;
  if (isConversationPendingEndpointRetarget(pending)) return { kind: 'rejected', code: 'endpointRetargetRepairRequired' };
  if (pending?.stopRequest.reason === 'transfer'
    && current.deletionState === 'none') {
    if (pending.acceptedPossibleLoss) {
      return hasAcceptedConversationTransferLoss(current)
        ? { kind: 'rejoined', connection: current }
        : { kind: 'staleAuthority' };
    }
    if (!hasAuthoritySteps(current.authorityEpoch, 1)) {
      return { kind: 'rejected', code: 'authorityEpochExhausted' };
    }
    return {
      kind: 'transferAbandoned',
      connection: {
        ...current,
        authorityEpoch: current.authorityEpoch + 1,
        // Explicit loss acceptance settles custody without fabricating stop
        // proof. The exact frozen request remains as durable disclosure until
        // a later exact-current destructive transition replaces it.
        pendingOldTransportStop: freezeConversationPendingOldTransportStop({
          ...pending,
          acceptedPossibleLoss: true,
        }),
        pollFailure: null,
      },
    };
  }
  if (
    current.deletionState !== 'pendingStopReconciliation'
    || current.enabled
    || pending === null
    || isConversationPendingEndpointRetarget(pending)
    || pending.stopRequest.reason !== 'delete'
  ) {
    return { kind: 'staleAuthority' };
  }
  if (!hasAuthoritySteps(current.authorityEpoch, 1)) {
    return { kind: 'rejected', code: 'authorityEpochExhausted' };
  }
  return {
    kind: 'deleteFinalizing',
    connection: {
      ...current,
      authorityEpoch: current.authorityEpoch + 1,
      deletionState: 'finalizingDelete',
      pendingOldTransportStop: freezeConversationPendingOldTransportStop({
        ...pending,
        acceptedPossibleLoss: true,
      }),
      historyGap: current.historyGap,
      providerReadiness: null,
      pollFailure: null,
    },
  };
}

/**
 * Persists only the first exact-current history-gap fact. Later reports rejoin
 * that evidence rather than replacing its timestamp or reason.
 */
export function recordConversationConnectionHistoryGap(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  reportedAuthorityEpoch: number;
  reportedAt: number;
  fact: ConversationConnectionHistoryGapFactV1;
}>): ConversationConnectionHistoryGapResultV1 {
  const { current, reportedAuthorityEpoch, reportedAt, fact } = input;
  if (
    current.deletionState !== 'none'
    || !current.enabled
    || reportedAuthorityEpoch !== current.authorityEpoch
  ) {
    return { kind: 'staleAuthority' };
  }
  if (current.historyGap !== null) {
    return { kind: 'rejoined', connection: current };
  }
  return {
    kind: 'recorded',
    connection: {
      ...current,
      historyGap: { reportedAt, ...fact },
      pollFailure: null,
    },
  };
}

/**
 * Records only current provider readiness through the connection owner. An
 * exact ready report clears prior remotely repairable attention; a changed
 * attention payload supersedes its stale diagnostic without changing
 * connection authority.
 */
export function recordConversationConnectionProviderReadiness(input: Readonly<{
  current: ConversationConnectionLifecycleStateV1;
  reportedAuthorityEpoch: number;
  fact: ConversationProviderReadinessFactV1;
}>): ConversationConnectionProviderReadinessResultV1 {
  const { current, reportedAuthorityEpoch, fact } = input;
  if (
    current.deletionState !== 'none'
    || !current.enabled
    || reportedAuthorityEpoch !== current.authorityEpoch
  ) {
    return { kind: 'staleAuthority' };
  }
  const providerReadiness = providerReadinessFromFact(fact);
  if (areConversationProviderReadinessStatesEqual(current.providerReadiness, providerReadiness)) {
    return { kind: 'rejoined', connection: current };
  }
  return {
    kind: 'recorded',
    connection: {
      ...current,
      providerReadiness,
    },
  };
}
