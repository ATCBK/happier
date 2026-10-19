import type {
  ConversationDeliveryInputV1,
  ConversationDeliveryReconcileInputV1,
  ConversationDeliveryReplyContextV1,
  ConversationDeliveryResultV1,
} from '@happier-dev/channels-protocol/v1';
import {
  ConversationBindingTargetV1Schema,
  ConversationDeliveryInputV1Schema,
  ConversationDeliveryReconcileInputV1Schema,
  ConversationDeliveryResultV1Schema,
  countConversationTextUnits,
} from '@happier-dev/channels-protocol/v1';
import { sha256 } from '@noble/hashes/sha256';
import type { TargetedContributionsService } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  isPluginActionHandlerInvocationNotStartedAdvisory,
  type AdmittedTargetedOperationExecutionHandle,
  type ActionsService,
  type PluginMachineExecutionRoutingV1,
} from '@happier-dev/plugin-sdk/actions';
import { isConversationDeliveryAutomaticTerminal } from './deliveryCustody.js';
import { encodeUnpaddedBase64Url } from './privateRowIdentity.js';
import { ConversationProviderContributionNotCurrentError, readCurrentProviderContributionForPersistedSelection } from './providerContributions.js';
import { getConversationConnectionExecutionRouting } from './connectionLifecycle.js';
import type {
  ConversationSessionProjectionBinding,
  ConversationSessionProjectionSource,
} from './sessionProjection.js';
import {
  type ChannelStateCollection,
  type StoredCollectionRow,
  type ConversationOutwardDeliveryProviderInvocationResult,
  loadConversationAccountLocalBindingPolicyModule,
  deriveConversationOutwardDeliveryCustodyId,
  hasRetainedConversationOutwardDeliveryContent,
  readConnectionFacts,
  readBindingFacts,
  checkConversationOutwardDeliveryRouteCurrentness,
  normalizeConversationOutwardDeliveryCurrentnessResult,
  isConversationOutwardDeliveryPreEffectSuppression,
  redriveConversationOutwardDelivery,
  deliverConversationOutwardDelivery,
  reconcileConversationOutwardDeliveryAttempt,
  type ConversationOutwardDeliveryAuthority,
  type ConversationOutwardDeliveryCurrentnessResult,
  type ConversationOutwardDeliveryRecord,
  type ConversationOutwardDeliveryStore,
  type ConversationOutwardDeliveryObligation,
  type ConversationOutboundTextLimit,
  type ConversationOutwardDeliveryResult,
  type ConversationOutwardDeliveryRecoveryResult,
} from './outwardDelivery.js';

type ConversationAccountLocalBindingPolicyModule = Awaited<ReturnType<typeof loadConversationAccountLocalBindingPolicyModule>>;

type ConversationOutwardDeliveryProviderActionInvocation = Readonly<{
  action: AdmittedTargetedOperationExecutionHandle<JsonValue, ConversationDeliveryResultV1>;
  input: ConversationDeliveryInputV1 | ConversationDeliveryReconcileInputV1;
  expectedExecutionRouting: PluginMachineExecutionRoutingV1;
  outboundTextLimit?: ConversationOutboundTextLimit;
}>;

type ConversationOutwardDeliveryProviderActionBoundary = Readonly<{
  authority: ConversationOutwardDeliveryAuthority;
  invoke(signal: AbortSignal): Promise<ConversationOutwardDeliveryProviderInvocationResult>;
}>;

/**
 * Builds the provider Action input from the same connection snapshot that just
 * passed canonical route currentness. The raw provider config remains opaque
 * to Channels but is admitted by the public provider Action schema before
 * dispatch. No provider callback can choose a target or origin itself.
 */
async function prepareConversationOutwardDeliveryProviderActionInvocation(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  record: ConversationOutwardDeliveryRecord;
  signal: AbortSignal;
  operation: 'deliver' | 'reconcile';
}>): Promise<
  | Readonly<{ kind: 'ready'; invocation: ConversationOutwardDeliveryProviderActionInvocation }>
  | ConversationOutwardDeliveryCurrentnessResult
> {
  if (!hasRetainedConversationOutwardDeliveryContent(input.record.obligation)) {
    return { kind: 'suppressed', reason: 'currentnessUnavailable' };
  }
  const currentness = await checkConversationOutwardDeliveryRouteCurrentness({
    stateCollection: input.stateCollection,
    signal: input.signal,
    obligation: input.record.obligation,
    requireBindingRevision: false,
  });
  if (currentness.kind !== 'current') return normalizeConversationOutwardDeliveryCurrentnessResult(currentness);
  const provider = currentness.connection.providerAction;
  const contribution = await readCurrentProviderContributionForPersistedSelection({
    context: {
      targetedContributions: input.targetedContributions,
      signal: input.signal,
    },
    providerPluginId: provider.providerPluginId,
    providerContributionSelection: provider.providerContributionSelection,
  }).catch((error: unknown) => {
    if (error instanceof ConversationProviderContributionNotCurrentError) return null;
    throw error;
  });
  if (contribution === null) return { kind: 'suppressed', reason: 'providerGenerationRetired' };
  const action = input.operation === 'deliver'
    ? contribution.operations.messageDeliver
    : contribution.operations.deliveryReconcile;
  if (action === undefined) return { kind: 'suppressed', reason: 'currentnessUnavailable' };
  const providerConnection = {
    v: 1,
    connectionId: input.record.obligation.connectionId,
    providerConnectionKey: provider.providerConnectionKey,
    providerConfigVersion: provider.providerConfigVersion,
    providerConfig: provider.providerConfig,
    credentialRef: currentness.connection.credentialRef,
  };
  const actionInput = input.operation === 'deliver'
    ? ConversationDeliveryInputV1Schema.safeParse({
      ...providerConnection,
      endpoint: input.record.obligation.endpoint,
      content: input.record.obligation.content,
      ...(input.record.obligation.newThread === undefined ? {} : { newThread: input.record.obligation.newThread }),
      deliveryKey: input.record.obligation.deliveryKey,
      ...(input.record.obligation.replyContext === undefined
        ? {}
        : { replyContext: input.record.obligation.replyContext }),
      mentionPolicy: input.record.obligation.mentionPolicy,
      linkPreviewPolicy: input.record.obligation.linkPreviewPolicy,
    })
    : ConversationDeliveryReconcileInputV1Schema.safeParse({
      ...providerConnection,
      endpoint: input.record.obligation.endpoint,
      deliveryKey: input.record.obligation.deliveryKey,
    });
  if (!actionInput.success) return { kind: 'suppressed', reason: 'currentnessUnavailable' };
  return {
    kind: 'ready',
    invocation: {
      action,
      input: actionInput.data,
      expectedExecutionRouting: getConversationConnectionExecutionRouting(currentness.connection.transportOrigin, provider.providerPluginId),
      ...(currentness.connection.outboundTextLimit === undefined
        ? {} : { outboundTextLimit: currentness.connection.outboundTextLimit }),
    },
  };
}

/** Native units are counted by the protocol owner; a visible grapheme stays intact. */
function splitConversationOutboundText(text: string, limit: ConversationOutboundTextLimit): readonly string[] | null {
  const chunks: string[] = [];
  let chunk = '';
  let units = 0;
  for (const { segment: character } of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)) {
    const characterUnits = countConversationTextUnits(character, limit.unit);
    if (characterUnits > limit.maximum) return null;
    if (units + characterUnits > limit.maximum) {
      chunks.push(chunk);
      chunk = '';
      units = 0;
    }
    chunk += character;
    units += characterUnits;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function createConversationOutwardDeliveryProviderActionBoundary(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  operation: 'deliver' | 'reconcile';
}>): ConversationOutwardDeliveryProviderActionBoundary {
  let invocation: ConversationOutwardDeliveryProviderActionInvocation | undefined;
  return {
    authority: {
      async checkCurrentness(check) {
        invocation = undefined;
        const prepared = await prepareConversationOutwardDeliveryProviderActionInvocation({
          stateCollection: input.stateCollection,
          targetedContributions: input.targetedContributions,
          record: check.record,
          signal: check.signal,
          operation: input.operation,
        });
        if (prepared.kind !== 'ready') return prepared;
        invocation = prepared.invocation;
        return { kind: 'current' };
      },
    },
    async invoke(signal) {
      const current = invocation;
      if (current === undefined) return { kind: 'outcomeUnknown' };
      const invoke = async (actionInput: typeof current.input): Promise<ConversationDeliveryResultV1> => {
        try {
          const execution = await input.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
            current.action, actionInput, { signal, expectedExecutionRouting: current.expectedExecutionRouting },
          );
          // The host checks routing before the effect and exact invocation currentness afterward.
          const result = ConversationDeliveryResultV1Schema.safeParse(execution.result);
          return result.success ? result.data : { kind: 'outcomeUnknown' };
        } catch (error) {
          // Only this admitted transport proves a no-handler miss is retry-safe.
          return isPluginActionHandlerInvocationNotStartedAdvisory(error)
            ? { kind: 'notDelivered', retry: 'safe' } : { kind: 'outcomeUnknown' };
        }
      };
      const limit = current.outboundTextLimit;
      if (!('content' in current.input) || limit === undefined
        || countConversationTextUnits(current.input.content.text, limit.unit) <= limit.maximum) {
        return await invoke(current.input);
      }
      const chunks = splitConversationOutboundText(current.input.content.text, limit);
      if (chunks === null) return { kind: 'notDelivered', retry: 'never' };
      const providerMessageIds: string[] = [];
      for (const [index, text] of chunks.entries()) {
        if (signal.aborted) return index === 0
          ? { kind: 'suppressedBeforeProviderEffect', reason: 'cancelled' }
          : { kind: 'partial', providerMessageIds, failedChunk: index, retrySafe: false };
        // Provider idempotency (such as Discord nonces) must distinguish chunks.
        // Hash the complete custody key so every allowed key remains bounded.
        const deliveryKey = `channels:chunk:v1:${encodeUnpaddedBase64Url(sha256(new TextEncoder().encode(
          JSON.stringify([current.input.deliveryKey, index]),
        )))}`;
        const result = await invoke({ ...current.input,
          content: { ...current.input.content, text }, deliveryKey, chunkIndex: index,
        });
        if (result.kind === 'delivered') {
          providerMessageIds.push(...result.providerMessageIds);
          continue;
        }
        if (result.kind === 'outcomeUnknown') return { ...result,
          providerMessageIds: [...providerMessageIds, ...(result.providerMessageIds ?? [])],
        };
        if (result.kind === 'partial') return { ...result,
          providerMessageIds: [...providerMessageIds, ...result.providerMessageIds], failedChunk: index,
        };
        return index === 0 ? result
          : { kind: 'partial', providerMessageIds, failedChunk: index, retrySafe: false };
      }
      return { kind: 'delivered', providerMessageIds };
    },
  };
}

/**
 * Executes an already-admitted custody row through the one provider Action
 * boundary. It retains the exact persisted obligation and cannot synthesize a
 * delivery key, route, or fallback send on restart.
 */
export async function redriveConversationOutwardDeliveryThroughProviderAction(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  attemptId: string;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryResult> {
  if (!hasRetainedConversationOutwardDeliveryContent(input.record.obligation)) {
    return isConversationDeliveryAutomaticTerminal(input.record.custody)
      ? { kind: 'settled', custody: input.record.custody }
      : { kind: 'notAttempted', reason: 'invalidRow' };
  }
  const boundary = createConversationOutwardDeliveryProviderActionBoundary({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    operation: 'deliver',
  });
  return await redriveConversationOutwardDelivery({
    store: input.store,
    record: input.record,
    attemptId: input.attemptId,
    now: input.now,
    signal: input.signal,
    authority: boundary.authority,
    deliver: async ({ signal }) => await boundary.invoke(signal),
  });
}

/** Fresh source producers share the exact provider Action/currentness boundary. */
export async function deliverConversationOutwardDeliveryThroughProviderAction(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  obligation: ConversationOutwardDeliveryObligation;
  outboundTextLimit?: ConversationOutboundTextLimit;
  attemptId: string;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryResult> {
  const boundary = createConversationOutwardDeliveryProviderActionBoundary({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    operation: 'deliver',
  });
  return await deliverConversationOutwardDelivery({
    store: input.store,
    obligation: input.obligation,
    outboundTextLimit: input.outboundTextLimit,
    attemptId: input.attemptId,
    now: input.now,
    signal: input.signal,
    authority: boundary.authority,
    deliver: async ({ signal }) => await boundary.invoke(signal),
  });
}

/**
 * The Session projection source reaches custody only here. It re-reads the
 * current binding to construct the binding-scoped authority arm, derives the
 * bounded external delivery key from the incumbent opaque custody identity,
 * and then enters the same provider/currentness path as every other source.
 */
export async function deliverConversationSessionProjectionOutwardDelivery(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  binding: ConversationSessionProjectionBinding;
  source: ConversationSessionProjectionSource;
  content: string;
  replyContext?: ConversationDeliveryReplyContextV1;
  attemptId: string;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryResult> {
  if (input.signal.aborted) return { kind: 'notAttempted', reason: 'cancelled' };
  let accountLocalBindingPolicy: ConversationAccountLocalBindingPolicyModule;
  try {
    accountLocalBindingPolicy = await loadConversationAccountLocalBindingPolicyModule();
  } catch {
    return { kind: 'notAttempted', reason: 'custodyUnavailable' };
  }
  let bindingRow: StoredCollectionRow | null;
  try {
    bindingRow = await input.stateCollection.get(input.binding.bindingId, {
      signal: input.signal,
    }) as unknown as StoredCollectionRow | null;
  } catch {
    return {
      kind: 'notAttempted',
      reason: input.signal.aborted ? 'cancelled' : 'custodyUnavailable',
    };
  }
  if (bindingRow === null) return { kind: 'notAttempted', reason: 'custodyChangedBeforeAttempt' };
  const binding = readBindingFacts({
    accountLocalBindingPolicy,
    row: bindingRow,
    bindingId: input.binding.bindingId,
  });
  const target = binding === null
    ? { success: false as const }
    : ConversationBindingTargetV1Schema.safeParse(binding.target);
  if (binding === null
    || !target.success
    || target.data.kind !== 'session'
    || binding.revision !== input.binding.revision
    || binding.connectionId !== input.binding.connectionId
    || target.data.sessionId !== input.binding.target.sessionId
    || target.data.sessionId !== input.source.sessionId
    || target.data.policy.deliveryMode !== input.binding.target.deliveryMode
    || !binding.enabled
    || binding.deletionState !== 'none'
    || binding.linkPreviewPolicy === undefined) {
    return { kind: 'notAttempted', reason: 'custodyChangedBeforeAttempt' };
  }
  let connectionRow: StoredCollectionRow | null;
  try {
    connectionRow = await input.stateCollection.get(binding.connectionId, {
      signal: input.signal,
    }) as unknown as StoredCollectionRow | null;
  } catch {
    return {
      kind: 'notAttempted',
      reason: input.signal.aborted ? 'cancelled' : 'custodyUnavailable',
    };
  }
  if (connectionRow === null) return { kind: 'notAttempted', reason: 'connectionUnavailable' };
  const connection = readConnectionFacts({
    accountLocalBindingPolicy,
    row: connectionRow,
    connectionId: binding.connectionId,
  });
  if (connection === null) {
    return { kind: 'notAttempted', reason: 'connectionCorrupt' };
  }
  const provisional: ConversationOutwardDeliveryObligation = {
    connectionId: binding.connectionId,
    bindingId: input.binding.bindingId,
    routeAuthority: {
      connectionAuthorityEpoch: connection.authorityEpoch,
      bindingRevision: binding.revision,
      bindingAuthorityEpoch: binding.authorityEpoch,
    },
    source: input.source,
    endpoint: binding.endpoint,
    content: { text: input.content },
    ...(input.replyContext === undefined ? {} : { replyContext: input.replyContext }),
    // The persistent identity deliberately excludes this derived public key.
    deliveryKey: 'channels:delivery:v1:pending',
    mentionPolicy: 'suppress',
    linkPreviewPolicy: binding.linkPreviewPolicy,
  };
  const custodyId = await deriveConversationOutwardDeliveryCustodyId({
    routingIdentityKey: connection.routingIdentityKey,
    obligation: provisional,
  });
  if (custodyId === null) return { kind: 'notAttempted', reason: 'connectionCorrupt' };
  return await deliverConversationOutwardDeliveryThroughProviderAction({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    store: input.store,
    obligation: {
      ...provisional,
      deliveryKey: `channels:delivery:v1:${custodyId}`,
    },
    outboundTextLimit: connection.outboundTextLimit,
    attemptId: input.attemptId,
    now: input.now,
    signal: input.signal,
  });
}

/**
 * Reconciles one retained attempt through its owning provider Action. Like
 * redrive, this has no provider-specific recovery path outside the canonical
 * custody state machine; an unavailable optional reconciliation settles as
 * outcome-unknown rather than issuing a second message delivery.
 */
export async function reconcileConversationOutwardDeliveryAttemptThroughProviderAction(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  recoveryAttemptId: string;
  staleAfterMs: number;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryRecoveryResult> {
  const boundary = createConversationOutwardDeliveryProviderActionBoundary({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    operation: 'reconcile',
  });
  return await reconcileConversationOutwardDeliveryAttempt({
    store: input.store,
    record: input.record,
    recoveryAttemptId: input.recoveryAttemptId,
    staleAfterMs: input.staleAfterMs,
    now: input.now,
    signal: input.signal,
    authority: boundary.authority,
    reconcile: async ({ signal }) => {
      const invocation = await boundary.invoke(signal);
      // Recovery follows an earlier attempting send. Even when this optional
      // reconciliation Action cannot start, that prior provider effect remains
      // ambiguous and must not be rewritten as a no-effect suppression.
      return isConversationOutwardDeliveryPreEffectSuppression(invocation)
        ? { kind: 'outcomeUnknown' }
        : invocation;
    },
  });
}

