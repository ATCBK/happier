import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationProviderConnectionReadResultV1Schema,
  ConversationProviderConnectionStopInputV1Schema,
  ConversationProviderConnectionStopResultV1Schema,
  ConversationProviderConnectionsSnapshotV1Schema,
  ConversationTransportFactReportResultV1Schema,
  type ConversationProviderConnectionReconciliationSnapshotV1,
  type ConversationProviderConnectionStopResultV1,
  type ConversationTransportFactReportInputV1,
} from '@happier-dev/channels-protocol/v1';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { isPluginError, type Disposable, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { projectPluginEventSourceConnectionStatusV1, type PluginEventSourceConnectionStatusV1 } from '@happier-dev/plugin-sdk/events';

import {
  assertDiscordChannelsCoreCaller,
  materializeExactDiscordBotToken,
  readDiscordConnectionConfiguration,
} from './discordActions.js';
import { createDiscordBotApi } from './discordApi.js';
import { createDiscordIdentifyConcurrency } from './discordGatewayIdentifyConcurrency.js';
import {
  startDiscordGatewayWorker,
  type DiscordGatewayRuntimeFacts,
  type DiscordGatewayTerminalReason,
  type DiscordGatewayWorker,
  type DiscordGatewayWorkerInput,
  type DiscordGatewayWorkerResult,
} from './discordGatewayWorker.js';
import {
  DISCORD_BOT_CREDENTIAL_PURPOSE,
  DISCORD_GATEWAY_BACKGROUND_SERVICE_ID,
  DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
  DISCORD_PLUGIN_ID,
} from './discordPluginConstants.js';
import {
  DISCORD_AUTOMATION_MESSAGE_EVENT_ID,
  DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
} from './discordAutomationEvent.js';

const CHANNELS_CORE_PLUGIN_ID = 'happier.channels';
const RECOVERY_INTERVAL_MS = 30_000;
const STOP_WAIT_MS = 2_000;
// Discord permits 1,000 Gateway session starts per 24-hour window. A
// connection reservation permits one Discord application key per Account, so
// this bounded recheck stays below that budget even if the Portal takes time
// to apply a repaired privileged intent.
const MESSAGE_CONTENT_RECHECK_DELAY_MS = 5 * 60_000;

type DiscordGatewayWorkerFactory = (input: DiscordGatewayWorkerInput) => DiscordGatewayWorker;

type DiscordGatewaySupervisorClock = Readonly<{
  now(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

type PendingTransportFact = ConversationTransportFactReportInputV1['fact'];

type WorkerStopIntent = 'reconcile' | 'explicit' | 'generationRetired' | 'authorityUnavailable';

/**
 * Why stopping a still-resumable session justifies a continuity-loss fact in
 * authority-loss cases: an authoritative listing/reading failure and generation
 * retirement. Both discard the worker's process-local resume coordinates, so
 * the replacement session can only Identify fresh and may miss everything
 * Discord dispatched in the interval; queueing the existing gap through the
 * pending fact owner is the continuity proof the replacement cannot make.
 */
const UNPROVEN_CONTINUITY_GAP_FACT = Object.freeze({
  kind: 'historyGap',
  reason: 'applicationAdmissionLost',
} as const);

const REPLACEMENT_CONTINUITY_GAP_FACT = Object.freeze({
  kind: 'historyGap',
  reason: 'providerHistoryUnavailable',
} as const);

type WorkerEntry = {
  snapshot: ConversationProviderConnectionReconciliationSnapshotV1;
  fingerprint: string;
  controller: AbortController;
  worker: DiscordGatewayWorker | null;
  stopIntent: WorkerStopIntent | null;
  replacementSnapshot: ConversationProviderConnectionReconciliationSnapshotV1 | null;
  explicitStopAuthorityEpoch: number | null;
  completion: Promise<void>;
};

/**
 * C7 consumes core's strict aggregate demand directly. It does not inspect a
 * binding, audience, provider configuration, or persisted provider state.
 */
export function requireDiscordGatewayRuntimeFactsFromCoreSnapshot(
  snapshot: ConversationProviderConnectionReconciliationSnapshotV1,
): DiscordGatewayRuntimeFacts {
  return { requiresFullSharedMessageContent: snapshot.requiresFullSharedMessageContent };
}

export type DiscordGatewaySupervisorOptions = Readonly<{
  resolveRuntimeFacts?: (snapshot: ConversationProviderConnectionReconciliationSnapshotV1) => DiscordGatewayRuntimeFacts;
  workerFactory?: DiscordGatewayWorkerFactory;
  clock?: DiscordGatewaySupervisorClock;
  reconciliationIntervalMs?: number;
  stopWaitMs?: number;
}>;

export type DiscordGatewaySupervisor = Readonly<{
  run(context: BackgroundServiceContext): Promise<void>;
  /** Content-free manifest event hint; the current run owns the census read. */
  invalidateConnections(): void;
  reconcile(context: BackgroundServiceContext): Promise<void>;
  /** One host target-Action owns each worker attempt's exact Account binding. */
  runWorkerAttempt(
    snapshot: ConversationProviderConnectionReconciliationSnapshotV1,
    context: PluginInvocationContext,
  ): Promise<void>;
  stop(input: unknown, context: PluginInvocationContext): Promise<ConversationProviderConnectionStopResultV1>;
  dispose(): Promise<void>;
}>;

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Discord Gateway supervisor was cancelled.'));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new Error('Discord Gateway supervisor was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_CLOCK: DiscordGatewaySupervisorClock = Object.freeze({
  now: () => Date.now(),
  sleep: defaultSleep,
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});

function isEligibleSocketConnection(snapshot: ConversationProviderConnectionReconciliationSnapshotV1): boolean {
  return snapshot.enabled
    && snapshot.deletionState === 'none';
}

function connectionFactKey(snapshot: ConversationProviderConnectionReconciliationSnapshotV1): string {
  return JSON.stringify([snapshot.connectionId, snapshot.authorityEpoch]);
}

function connectionFingerprint(snapshot: ConversationProviderConnectionReconciliationSnapshotV1): string {
  return JSON.stringify({
    connectionId: snapshot.connectionId,
    authorityEpoch: snapshot.authorityEpoch,
    providerConnectionKey: snapshot.providerConnectionKey,
    providerConfigVersion: snapshot.providerConfigVersion,
    providerConfig: snapshot.providerConfig,
    credentialRef: snapshot.credentialRef,
    enabled: snapshot.enabled,
    deletionState: snapshot.deletionState,
    requiresFullSharedMessageContent: snapshot.requiresFullSharedMessageContent,
  });
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => sameJsonValue(entry, right[index]));
  }
  if (!isJsonRecord(left) || !isJsonRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameJsonValue(left[key], right[key]));
}

function isExactFrozenOldWorker(input: Readonly<{
  snapshot: ConversationProviderConnectionReconciliationSnapshotV1;
  request: ReturnType<typeof ConversationProviderConnectionStopInputV1Schema.parse>;
}>): boolean {
  const { snapshot, request } = input;
  return request.authorityEpoch > 1
    && snapshot.connectionId === request.connectionId
    && snapshot.authorityEpoch === request.authorityEpoch - 1
    && snapshot.providerConnectionKey === request.providerConnectionKey
    && snapshot.providerConfigVersion === request.providerConfigVersion
    && sameJsonValue(snapshot.providerConfig, request.providerConfig)
    && sameJsonValue(snapshot.credentialRef, request.credentialRef);
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error === signal.reason;
}

function sameFact(left: PendingTransportFact, right: PendingTransportFact): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'providerReadiness') {
    if (right.kind !== 'providerReadiness' || left.status !== right.status) return false;
    if (left.status === 'ready') return true;
    return right.status === 'attention'
      && left.code === right.code
      && left.diagnostic === right.diagnostic;
  }
  return right.kind === left.kind && left.reason === right.reason;
}

function providerReadinessFactFromFailure(
  failure: Extract<DiscordGatewayWorkerResult, Readonly<{ kind: 'notReady' }>>['failure'],
): PendingTransportFact | undefined {
  const code = failure.reason === 'permissionMissing'
    ? 'providerPermissionMissing'
    : failure.reason === 'invalidConfiguration'
      ? 'providerConfigurationInvalid'
      : failure.reason === 'credentialInvalid'
        ? 'providerCredentialInvalid'
        : undefined;
  if (code === undefined) return undefined;
  return {
    kind: 'providerReadiness',
    status: 'attention',
    code,
    ...(failure.diagnostic === undefined ? {} : { diagnostic: failure.diagnostic }),
  };
}

function providerReadinessFactFromWorkerResult(
  result: DiscordGatewayWorkerResult,
): PendingTransportFact | undefined {
  if (result.kind === 'terminal') {
    // Each terminal reason names the repair that can actually retire it. Close
    // 4004 rejects the selected bot token, and only replacing or resyncing the
    // Connected Account credential releases the no-retry memo below, so it must
    // not be presented as a Gateway configuration problem.
    if (result.reason === 'authenticationFailed') {
      return {
        kind: 'providerReadiness',
        status: 'attention',
        code: 'providerCredentialInvalid',
        diagnostic: 'Discord rejected the selected bot token and stopped the connection. Replace or resynchronize the Connected Account credential.',
      };
    }
    const permissionFailure = result.reason === 'disallowedIntents';
    return {
      kind: 'providerReadiness',
      status: 'attention',
      code: permissionFailure ? 'providerPermissionMissing' : 'providerConfigurationInvalid',
      diagnostic: permissionFailure
        ? 'Discord refused the configured Gateway intents and stopped the connection.'
        : 'Discord rejected the Gateway connection configuration and stopped the connection.',
    };
  }
  if (result.kind === 'messageContentIntentRecoveryRequired') {
    return providerReadinessFactFromFailure(result.failure);
  }
  return result.kind === 'notReady'
    ? providerReadinessFactFromFailure(result.failure)
    : undefined;
}

/**
 * The Gateway supervisor owns this transport fact. The SDK helper only
 * projects it through the current Automation source catalog; it never owns a
 * connection-health row or a second status store.
 */
async function projectDiscordAutomationSourceConnectionStatus(
  snapshot: ConversationProviderConnectionReconciliationSnapshotV1,
  status: PluginEventSourceConnectionStatusV1,
  context: PluginInvocationContext,
): Promise<void> {
  const configuration = readDiscordConnectionConfiguration(snapshot);
  if ('kind' in configuration) return;
  await projectPluginEventSourceConnectionStatusV1({
    eventRef: { pluginId: DISCORD_PLUGIN_ID, localId: DISCORD_AUTOMATION_MESSAGE_EVENT_ID },
    sourceContractVersion: DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
    sourceInstanceIdPrefix: `discord:application:${configuration.applicationId}:channel:`,
    scope: { kind: 'socket' },
    status,
  }, context);
}

function automationSourceStatusFromWorkerResult(
  result: DiscordGatewayWorkerResult,
): PluginEventSourceConnectionStatusV1 | null {
  if (result.kind === 'historyGap') return 'historyGap';
  if (
    result.kind === 'notReady'
    || result.kind === 'blocked'
    || result.kind === 'terminal'
    || result.kind === 'messageContentIntentRecoveryRequired'
  ) return 'reconnecting';
  return null;
}

function waitForCompletion(
  completion: Promise<void>,
  signal: AbortSignal,
  clock: DiscordGatewaySupervisorClock,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      clock.clearTimeout(timer);
      resolve(value);
    };
    const timer = clock.setTimeout(() => finish(false), timeoutMs);
    const onAbort = (): void => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void completion.then(() => finish(true), () => finish(true));
  });
}

export function createDiscordGatewaySupervisor(options: DiscordGatewaySupervisorOptions = {}): DiscordGatewaySupervisor {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const workerFactory = options.workerFactory ?? startDiscordGatewayWorker;
  const identifyConcurrency = createDiscordIdentifyConcurrency();
  const resolveRuntimeFacts = options.resolveRuntimeFacts ?? requireDiscordGatewayRuntimeFactsFromCoreSnapshot;
  const reconciliationIntervalMs = options.reconciliationIntervalMs ?? RECOVERY_INTERVAL_MS;
  const stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;
  if (!Number.isSafeInteger(reconciliationIntervalMs) || reconciliationIntervalMs <= 0) {
    throw new Error('Discord Gateway reconciliation interval must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(stopWaitMs) || stopWaitMs <= 0) {
    throw new Error('Discord Gateway stop wait must be a positive safe integer.');
  }

  // Gateway reconciliation owns only workers and transport facts. Event
  // candidates pass to Channels through observation ingress; this loop never
  // scans or admits Automation sources directly.
  const workers = new Map<string, WorkerEntry>();
  const pendingFacts = new Map<string, PendingTransportFact[]>();
  // A connection fingerprint is built from the core reconciliation snapshot,
  // which identifies the selected Connected Account but carries no revision of
  // the credential material inside it. Repairing a wrong bot token therefore
  // produces a byte-identical fingerprint, so the terminal reason is retained
  // and the host's credential resync — not the fingerprint — retires the one
  // reason that repair can fix.
  const terminalReasonByFingerprint = new Map<string, DiscordGatewayTerminalReason>();
  const blockedUntilByFingerprint = new Map<string, number>();
  const reportedNotRunning = new Set<string>();
  let supervisorAbort: AbortController | null = null;
  let runPromise: Promise<void> | null = null;
  let disposed = false;
  let invalidateSupervisor = (): void => {};
  let recoveryAt: number | undefined;
  let updateRequired = false;

  const stopOnCollectionUpdateRequired = (error: unknown, context: PluginInvocationContext): boolean => {
    if (!isPluginError(error) || error.code !== 'collection_update_required') return false;
    if (!updateRequired) {
      updateRequired = true;
      supervisorAbort?.abort(error);
      stopAllWorkers('generationRetired');
      context.services.logger.warn('[Channels] Account Collection requires an update', {
        code: 'collection_update_required', retryable: false, recovery: 'updateHappierOnThisMachine',
      });
    }
    return true;
  };

  const retryReconciliation = (): void => {
    recoveryAt = clock.now() + reconciliationIntervalMs;
  };

  const addFact = (snapshot: ConversationProviderConnectionReconciliationSnapshotV1, fact: PendingTransportFact): void => {
    const key = connectionFactKey(snapshot);
    const facts = pendingFacts.get(key) ?? [];
    if (!facts.some((candidate) => sameFact(candidate, fact))) {
      pendingFacts.set(key, [...facts, fact]);
      invalidateSupervisor();
    }
  };

  const stopWorker = (entry: WorkerEntry, intent: WorkerStopIntent): void => {
    if (entry.stopIntent === null || intent === 'explicit') entry.stopIntent = intent;
    if (!entry.controller.signal.aborted) entry.controller.abort(new Error(`Discord Gateway worker stopped for ${intent}.`));
    entry.worker?.stop();
  };

  const stopAllWorkers = (intent: WorkerStopIntent): void => {
    for (const entry of workers.values()) stopWorker(entry, intent);
  };

  const recordWorkerResult = (entry: WorkerEntry, result: DiscordGatewayWorkerResult): void => {
    const transportFact = result.kind === 'historyGap'
      ? result
      : result.kind === 'notReady'
        ? result.transportFact
        : undefined;
    if (transportFact !== undefined) addFact(entry.snapshot, transportFact);
    // Authority loss and generation retirement attribute the gap to the old
    // authority. A material reconciliation replacement instead attributes its
    // distinct provider-history gap to the successor below. Explicit stops
    // report their own stopConfirmed custody and never create either gap.
    if (
      (entry.stopIntent === 'authorityUnavailable' || entry.stopIntent === 'generationRetired')
      && result.kind === 'stopped'
      && result.unprovenContinuity === true
    ) {
      addFact(entry.snapshot, UNPROVEN_CONTINUITY_GAP_FACT);
    }
    if (
      entry.stopIntent === 'reconcile'
      && entry.replacementSnapshot !== null
      && result.kind === 'stopped'
      && result.unprovenContinuity === true
    ) {
      // The old Gateway cannot prove it resumed through the material
      // configuration change. Attribute the existing provider-history gap to
      // the successor authority so core blocks that replacement until the
      // fact has been projected; the retired snapshot is no longer current.
      addFact(entry.replacementSnapshot, REPLACEMENT_CONTINUITY_GAP_FACT);
    }
    const providerReadinessFact = providerReadinessFactFromWorkerResult(result);
    if (providerReadinessFact !== undefined) addFact(entry.snapshot, providerReadinessFact);
    if (entry.stopIntent === 'explicit') {
      addFact({
        ...entry.snapshot,
        authorityEpoch: entry.explicitStopAuthorityEpoch ?? entry.snapshot.authorityEpoch,
      }, { kind: 'stopConfirmed', reason: 'explicitStop' });
    }
    // Queue truthful current attention before retaining the no-retry memo. The
    // next reconciliation publishes the fact through core's existing owner,
    // then the unchanged fingerprint remains terminal.
    if (result.kind === 'terminal') terminalReasonByFingerprint.set(entry.fingerprint, result.reason);
    if (result.kind === 'blocked') blockedUntilByFingerprint.set(entry.fingerprint, result.retryAtMs);
    if (result.kind === 'notReady') {
      blockedUntilByFingerprint.set(entry.fingerprint, clock.now() + reconciliationIntervalMs);
    }
    if (result.kind === 'messageContentIntentRecoveryRequired' && result.source === 'gateway4014') {
      blockedUntilByFingerprint.set(
        entry.fingerprint,
        clock.now() + MESSAGE_CONTENT_RECHECK_DELAY_MS,
      );
    }
  };

  const runWorkerAttempt = async (
    snapshot: ConversationProviderConnectionReconciliationSnapshotV1,
    context: PluginInvocationContext,
  ): Promise<void> => {
    const caller = context.caller;
    if (
      caller?.kind !== 'plugin'
      || caller.pluginId !== DISCORD_PLUGIN_ID
      || caller.contribution.id !== DISCORD_GATEWAY_BACKGROUND_SERVICE_ID
      || caller.contribution.qualifiedId
        !== `${DISCORD_PLUGIN_ID}/backgroundServices/${DISCORD_GATEWAY_BACKGROUND_SERVICE_ID}`
      || caller.originSurface !== 'background'
    ) {
      throw new Error('Discord Gateway worker attempts may only be started by the Gateway supervisor.');
    }
    const entry = workers.get(snapshot.connectionId);
    if (
      !entry
      || entry.fingerprint !== connectionFingerprint(snapshot)
      || entry.controller.signal.aborted
      || context.signal.aborted
    ) return;
    const runtime = resolveRuntimeFacts(snapshot);
    let result: DiscordGatewayWorkerResult = { kind: 'stopped' };
    try {
      const configuration = readDiscordConnectionConfiguration(snapshot);
      if ('kind' in configuration) {
        result = { kind: 'notReady', failure: configuration };
        return;
      }
      if (!snapshot.credentialRef) {
        result = {
          kind: 'notReady',
          failure: {
            kind: 'notReady',
            reason: 'credentialInvalid',
            diagnostic: 'The Discord bot credential is unavailable.',
          },
        };
        return;
      }
      const token = await materializeExactDiscordBotToken(context, snapshot.credentialRef);
      if (typeof token !== 'string') {
        result = { kind: 'notReady', failure: token };
        return;
      }
      if (context.signal.aborted || entry.controller.signal.aborted) return;
      const api = createDiscordBotApi({ token, http: context.services.http });
      const identity = await api.getIdentity({ signal: context.signal });
      if ('kind' in identity) {
        result = { kind: 'notReady', failure: identity };
        return;
      }
      if (
        identity.applicationId !== configuration.applicationId
        || identity.botUserId !== configuration.botUserId
      ) {
        result = {
          kind: 'notReady',
          failure: {
            kind: 'notReady',
            reason: 'invalidConfiguration',
            diagnostic: 'The selected Discord bot no longer matches this Channel connection.',
          },
        };
        return;
      }
      if (context.signal.aborted || entry.controller.signal.aborted) return;
      const worker = workerFactory({
        connection: {
          connectionId: snapshot.connectionId,
          authorityEpoch: snapshot.authorityEpoch,
          applicationId: configuration.applicationId,
          botUserId: configuration.botUserId,
          token,
          runtime,
          applicationMessageContentIntentPermission: identity.applicationMessageContentIntentPermission,
        },
        api,
        webSockets: context.services.http,
        admitObservation: async (admission, admissionOptions) => {
          try { await context.services.actions.execute(
            {
              pluginId: CHANNELS_CORE_PLUGIN_ID,
              localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest,
            },
            admission,
            admissionOptions,
          ); } catch (error) {
            stopOnCollectionUpdateRequired(error, context);
            throw error;
          }
        },
        reportConnectionStatus: async (status) => {
          // The worker never writes status. It can only queue a fact through
          // the current supervisor entry; the core transport-fact Action is
          // still the single persistence and projection owner.
          if (
            workers.get(snapshot.connectionId) !== entry
            || entry.controller.signal.aborted
            || context.signal.aborted
          ) return;
          if (status === 'ready') {
            blockedUntilByFingerprint.delete(entry.fingerprint);
            addFact(snapshot, { kind: 'providerReadiness', status: 'ready' });
          }
          await projectDiscordAutomationSourceConnectionStatus(snapshot, status, context);
        },
        signal: context.signal,
        identifyConcurrency,
      });
      entry.worker = worker;
      result = await worker.result;
    } catch (error) {
      if (!stopOnCollectionUpdateRequired(error, context) && !isAbort(error, context.signal) && !entry.controller.signal.aborted) {
        result = {
          kind: 'notReady',
          failure: { kind: 'notReady', reason: 'network', diagnostic: 'Discord Gateway worker could not be initialized.' },
        };
      }
    } finally {
      recordWorkerResult(entry, result);
      const sourceStatus = automationSourceStatusFromWorkerResult(result);
      if (
        sourceStatus !== null
        && workers.get(snapshot.connectionId) === entry
        && !entry.controller.signal.aborted
        && !context.signal.aborted
      ) {
        await projectDiscordAutomationSourceConnectionStatus(snapshot, sourceStatus, context);
      }
      if (workers.get(snapshot.connectionId) === entry) workers.delete(snapshot.connectionId);
    }
  };

  const startWorker = (snapshot: ConversationProviderConnectionReconciliationSnapshotV1, _runtime: DiscordGatewayRuntimeFacts, context: BackgroundServiceContext): void => {
    const fingerprint = connectionFingerprint(snapshot);
    const controller = new AbortController();
    const entry: WorkerEntry = {
      snapshot,
      fingerprint,
      controller,
      worker: null,
      stopIntent: null,
      replacementSnapshot: null,
      explicitStopAuthorityEpoch: null,
      completion: Promise.resolve(),
    };
    workers.set(snapshot.connectionId, entry);
    entry.completion = (async () => {
      try {
        await context.services.actions.execute(
          {
            pluginId: context.plugin.id,
            localId: DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
          },
          snapshot,
          { signal: controller.signal },
        );
      } catch (error) {
        if (!isAbort(error, controller.signal) && workers.get(snapshot.connectionId) === entry) {
          recordWorkerResult(entry, {
            kind: 'notReady',
            failure: { kind: 'notReady', reason: 'network', diagnostic: 'Discord Gateway worker could not be initialized.' },
          });
        }
      } finally {
        if (workers.get(snapshot.connectionId) === entry) workers.delete(snapshot.connectionId);
        // A worker that stops unexpectedly is no longer healthy. Reuse the
        // existing recovery interval, without shortening an explicit provider
        // retry deadline or retiring a terminal authentication memo.
        if (!entry.controller.signal.aborted && entry.stopIntent === null
          && !terminalReasonByFingerprint.has(fingerprint)
          && !blockedUntilByFingerprint.has(fingerprint)) {
          blockedUntilByFingerprint.set(fingerprint, clock.now() + reconciliationIntervalMs);
        }
        invalidateSupervisor();
      }
    })();
  };

  const reportPendingFacts = async (snapshot: ConversationProviderConnectionReconciliationSnapshotV1, context: BackgroundServiceContext): Promise<boolean> => {
    if (updateRequired || context.signal.aborted) return false;
    const key = connectionFactKey(snapshot);
    const facts = pendingFacts.get(key);
    if (!facts || facts.length === 0) return true;
    let blocksAdmission = false;
    for (const fact of facts) {
      if (updateRequired || context.signal.aborted) return false;
      let result: unknown;
      try {
        result = await context.services.actions.execute(
          {
            pluginId: CHANNELS_CORE_PLUGIN_ID,
            localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport,
          },
          { connectionId: snapshot.connectionId, authorityEpoch: snapshot.authorityEpoch, fact },
          { signal: context.signal },
        );
      } catch (error) {
        if (!stopOnCollectionUpdateRequired(error, context)) retryReconciliation();
        return false;
      }
      const parsed = ConversationTransportFactReportResultV1Schema.safeParse(result);
      if (!parsed.success) {
        retryReconciliation();
        return false;
      }
      if (parsed.data.kind === 'staleAuthority') {
        pendingFacts.delete(key);
        return false;
      }
      if (fact.kind === 'historyGap') {
        await projectDiscordAutomationSourceConnectionStatus(
          snapshot,
          'historyGap',
          context,
        );
        // The report mutates Channels' canonical connection admission state.
        // Do not let this stale pre-report snapshot start a successor worker.
        // A later reconciliation can start normally only after Channels has
        // explicitly cleared the gap and returns the connection again.
        blocksAdmission = true;
      }
    }
    pendingFacts.delete(key);
    return !blocksAdmission;
  };

  /**
   * A list is discovery only: before a Gateway worker or a transport fact can
   * act on a connection, re-read that exact caller-filtered id from Channels'
   * Account authority. The empty or malformed result is intentionally treated
   * as no current connection, never as permission to use the list snapshot.
   * A read failure is reported separately so the supervisor can treat the
   * stop of a still-resumable worker as an authority loss, not as removal.
   */
  const readCurrentConnection = async (
    listed: ConversationProviderConnectionReconciliationSnapshotV1,
    context: BackgroundServiceContext,
  ): Promise<
    | Readonly<{ kind: 'snapshot'; snapshot: ConversationProviderConnectionReconciliationSnapshotV1 }>
    | Readonly<{ kind: 'readFailed' }>
  > => {
    let result: unknown;
    try {
      result = await context.services.actions.execute(
        {
          pluginId: CHANNELS_CORE_PLUGIN_ID,
          localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead,
        },
        { connectionId: listed.connectionId },
        { signal: context.signal },
      );
    } catch (error) {
      stopOnCollectionUpdateRequired(error, context);
      return { kind: 'readFailed' };
    }
    const parsed = ConversationProviderConnectionReadResultV1Schema.safeParse(result);
    if (!parsed.success) return { kind: 'readFailed' };
    const entries = Object.entries(parsed.data);
    if (entries.length !== 1) return { kind: 'readFailed' };
    const [connectionId, snapshot] = entries[0]!;
    return connectionId === listed.connectionId && snapshot.connectionId === listed.connectionId
      ? { kind: 'snapshot', snapshot }
      : { kind: 'readFailed' };
  };

  /**
   * Stops the exact workers whose reconciliation authority could not be
   * established and waits for their outcomes, so their continuity facts are
   * queued before the next reconciliation can publish or restart admission.
   */
  const stopWorkersForAuthorityLoss = async (entries: readonly WorkerEntry[]): Promise<void> => {
    for (const entry of entries) stopWorker(entry, 'authorityUnavailable');
    await Promise.allSettled(entries.map((entry) => entry.completion));
  };

  const reconcile = async (context: BackgroundServiceContext): Promise<void> => {
    if (updateRequired) return;
    recoveryAt = undefined;
    let source: unknown;
    try {
      source = await context.services.actions.execute(
        {
          pluginId: CHANNELS_CORE_PLUGIN_ID,
          localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
        },
        {},
        { signal: context.signal },
      );
    } catch (error) {
      if (stopOnCollectionUpdateRequired(error, context)) return;
      await stopWorkersForAuthorityLoss([...workers.values()]);
      retryReconciliation();
      return;
    }
    const parsed = ConversationProviderConnectionsSnapshotV1Schema.safeParse(source);
    if (!parsed.success) {
      await stopWorkersForAuthorityLoss([...workers.values()]);
      retryReconciliation();
      return;
    }

    const snapshots: ConversationProviderConnectionReconciliationSnapshotV1[] = [];
    const authorityLossFactKeys = new Set<string>();
    for (const listed of Object.values(parsed.data)) {
      const read = await readCurrentConnection(listed, context);
      if (updateRequired || context.signal.aborted) return;
      if (read.kind === 'readFailed') {
        retryReconciliation();
        // The list proves the connection exists; only its authoritative read
        // failed. Stopping its worker is an authority loss, not a removal.
        const entry = workers.get(listed.connectionId);
        if (entry !== undefined) {
          authorityLossFactKeys.add(connectionFactKey(entry.snapshot));
          await stopWorkersForAuthorityLoss([entry]);
        }
        continue;
      }
      snapshots.push(read.snapshot);
    }
    const retainedFingerprints = new Set(snapshots.map(connectionFingerprint));
    for (const entry of workers.values()) retainedFingerprints.add(entry.fingerprint);
    for (const fingerprint of terminalReasonByFingerprint.keys()) {
      if (!retainedFingerprints.has(fingerprint)) terminalReasonByFingerprint.delete(fingerprint);
    }
    for (const fingerprint of blockedUntilByFingerprint.keys()) {
      if (!retainedFingerprints.has(fingerprint)) blockedUntilByFingerprint.delete(fingerprint);
    }
    const retainedFactKeys = new Set(snapshots.map(connectionFactKey));
    for (const entry of workers.values()) retainedFactKeys.add(connectionFactKey(entry.snapshot));
    for (const factKey of authorityLossFactKeys) retainedFactKeys.add(factKey);
    for (const factKey of reportedNotRunning) {
      if (!retainedFactKeys.has(factKey)) reportedNotRunning.delete(factKey);
    }
    // A queued fact is only ever published against a reconciled connection and
    // authority epoch. Once that pair leaves reconciliation nothing can select
    // it again, so retaining the payload for the rest of the daemon generation
    // only accumulates unreachable evidence under connection churn.
    for (const factKey of pendingFacts.keys()) {
      if (!retainedFactKeys.has(factKey)) pendingFacts.delete(factKey);
    }

    const currentIds = new Set<string>();
    for (const snapshot of snapshots) {
      currentIds.add(snapshot.connectionId);
      const factKey = connectionFactKey(snapshot);
      const fingerprint = connectionFingerprint(snapshot);
      const existing = workers.get(snapshot.connectionId);
      if (existing && existing.fingerprint !== fingerprint) {
        // Discord Resume cannot change Identify intents. Wait for the worker
        // owning the old strict demand to finish, then the next authoritative
        // reconciliation starts a fresh IDENTIFY under the new demand.
        existing.replacementSnapshot = snapshot;
        stopWorker(existing, 'reconcile');
        continue;
      }

      if (snapshot.deletionState === 'pendingStopReconciliation') {
        const hasPendingStopConfirmation = (pendingFacts.get(factKey) ?? []).some(
          (fact) => fact.kind === 'stopConfirmed',
        );
        if (!workers.has(snapshot.connectionId) && !reportedNotRunning.has(factKey) && !hasPendingStopConfirmation) {
          addFact(snapshot, { kind: 'stopConfirmed', reason: 'notRunningOnReconcile' });
          reportedNotRunning.add(factKey);
        }
        await reportPendingFacts(snapshot, context);
        continue;
      }
      if (!isEligibleSocketConnection(snapshot)) continue;
      if (!await reportPendingFacts(snapshot, context)) {
        const active = workers.get(snapshot.connectionId);
        if (active) stopWorker(active, 'reconcile');
        continue;
      }
      if (workers.get(snapshot.connectionId)?.fingerprint === fingerprint) continue;
      if (terminalReasonByFingerprint.has(fingerprint)) continue;
      const blockedUntil = blockedUntilByFingerprint.get(fingerprint);
      if (blockedUntil !== undefined && clock.now() < blockedUntil) continue;
      blockedUntilByFingerprint.delete(fingerprint);
      const runtime = resolveRuntimeFacts(snapshot);
      startWorker(snapshot, runtime, context);
    }

    for (const [connectionId, entry] of workers) {
      if (!currentIds.has(connectionId)) stopWorker(entry, 'reconcile');
    }
  };

  const run = async (context: BackgroundServiceContext): Promise<void> => {
    if (disposed) throw new Error('Discord Gateway supervisor is disposed.');
    if (runPromise) throw new Error('Discord Gateway supervisor is already running.');
    if (updateRequired) return;
    const controller = new AbortController();
    supervisorAbort = controller;
    const abortFromContext = (): void => controller.abort(context.signal.reason);
    if (context.signal.aborted) abortFromContext();
    else context.signal.addEventListener('abort', abortFromContext, { once: true });
    let invalidated = true;
    let resumeWait: (() => void) | undefined;
    const wake = (): void => {
      invalidated = true;
      resumeWait?.();
    };
    invalidateSupervisor = wake;
    controller.signal.addEventListener('abort', wake, { once: true });
    // The manifest handler forwards content-free hints to this run's wake.
    // Initial admission reads unconditionally, and invalidations during a read
    // remain set until the next census, including at the read-to-wait boundary.
    // The selected Connected Account is a separate authority whose credential
    // material can change without changing any fact in the core reconciliation
    // snapshot. This resync is the only signal that tells the supervisor a
    // Gateway authentication failure is worth another attempt.
    const credentialResync: Disposable = context.services.connectedAccounts.watch(
      DISCORD_BOT_CREDENTIAL_PURPOSE,
      () => {
        for (const [fingerprint, reason] of terminalReasonByFingerprint) {
          if (reason === 'authenticationFailed') terminalReasonByFingerprint.delete(fingerprint);
        }
        wake();
      },
    );
    runPromise = (async () => {
      try {
        while (!controller.signal.aborted) {
          invalidated = false;
          await reconcile({ ...context, signal: controller.signal });
          if (controller.signal.aborted) break;
          if (invalidated) continue;
          const deadlines = [...blockedUntilByFingerprint.values()].filter(at => at > clock.now());
          if (recoveryAt !== undefined) deadlines.push(recoveryAt);
          const deadline = deadlines.length === 0 ? undefined : Math.min(...deadlines);
          const waitController = new AbortController();
          try {
            const changed = new Promise<void>(resolve => { resumeWait = resolve; });
            if (invalidated || controller.signal.aborted) resumeWait?.();
            if (deadline === undefined) await changed;
            else await Promise.race([
              changed,
              clock.sleep(Math.max(0, deadline - clock.now()), waitController.signal),
            ]);
          } catch {
            if (!controller.signal.aborted) throw new Error('Discord Gateway reconciliation wait failed.');
          } finally {
            resumeWait = undefined;
            waitController.abort();
          }
        }
      } finally {
        invalidateSupervisor = () => {};
        controller.signal.removeEventListener('abort', wake);
        await credentialResync.dispose();
        context.signal.removeEventListener('abort', abortFromContext);
        stopAllWorkers('generationRetired');
        await Promise.allSettled([...workers.values()].map((entry) => entry.completion));
        await identifyConcurrency.waitForCommittedWindows();
        supervisorAbort = null;
      }
    })();
    try {
      await runPromise;
    } finally {
      runPromise = null;
    }
  };

  const stop = async (input: unknown, context: PluginInvocationContext): Promise<ConversationProviderConnectionStopResultV1> => {
    assertDiscordChannelsCoreCaller(context);
    const request = ConversationProviderConnectionStopInputV1Schema.parse(input);
    const entry = workers.get(request.connectionId);
    if (!entry) {
      return ConversationProviderConnectionStopResultV1Schema.parse({ kind: 'notRunning' });
    }
    if (!isExactFrozenOldWorker({ snapshot: entry.snapshot, request })) {
      return ConversationProviderConnectionStopResultV1Schema.parse({
        kind: 'notReady',
        reason: 'invalidConfiguration',
        diagnostic: 'Discord Gateway worker does not match the frozen old connection stop request.',
      });
    }
    entry.explicitStopAuthorityEpoch = request.authorityEpoch;
    stopWorker(entry, 'explicit');
    const stopped = await waitForCompletion(entry.completion, context.signal, clock, stopWaitMs);
    return ConversationProviderConnectionStopResultV1Schema.parse({ kind: stopped ? 'stopped' : 'pending' });
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    supervisorAbort?.abort(new Error('Discord Gateway supervisor was disposed.'));
    stopAllWorkers('generationRetired');
    await Promise.allSettled([...workers.values()].map((entry) => entry.completion));
    await identifyConcurrency.waitForCommittedWindows();
  };

  return Object.freeze({
    run, reconcile, runWorkerAttempt, stop, dispose,
    invalidateConnections() { invalidateSupervisor(); },
  });
}
