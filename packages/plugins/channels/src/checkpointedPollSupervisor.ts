import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import {
  MAX_CONVERSATION_RECEIVE_WAIT_MS,
} from '@happier-dev/channels-protocol/v1';

import {
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import {
  classifySupervisorFailure,
  isInactiveSupervisorCollectionFailure,
} from './supervisorFailure.js';
import {
  runConversationCheckpointedPollForInvocation,
  runConversationIngressDueWorkForInvocation,
  runConversationIngressRetentionForInvocation,
  type ConversationCheckpointedPollRunResult,
} from './ingress.js';
import type { ConversationPairingManager } from './management.js';
import { createSupervisorWake } from './supervisorWake.js';
import { createChannelsCollectionAccess } from './collectionUpdateRequired.js';

const RECOVERY_INTERVAL_MS = 1_000;

type Clock = Readonly<{
  now(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}>;

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type IngressSupervisorOptions = Readonly<{
  clock?: Clock;
  pairing?: ConversationPairingManager;
  reconciliationIntervalMs?: number;
  runPoll?: (
    input: Readonly<{ connectionId: string; waitMs: number }>,
    context: BackgroundServiceContext,
  ) => Promise<ConversationCheckpointedPollRunResult>;
  runDueWork?: (
    input: Readonly<{ now: number; limit: number }>,
    context: BackgroundServiceContext,
  ) => Promise<number>;
  runRetention?: (
    input: Readonly<{ now: number; limit: number; cursor?: string }>,
    context: BackgroundServiceContext,
  ) => Promise<Readonly<{ nextCursor?: string; nextRetentionAt?: number; retryRequired?: true }>>;
}>;

export type IngressSupervisor = Readonly<{
  run(context: BackgroundServiceContext): Promise<void>;
  dispose(): Promise<void>;
}>;

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Checkpointed poll supervisor was cancelled.'));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new Error('Checkpointed poll supervisor was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_CLOCK: Clock = Object.freeze({
  now: () => Date.now(),
  sleep: defaultSleep,
});

function positiveDelay(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function connectionIdFromRow(value: JsonValue): string | undefined {
  if (!isJsonRecord(value)) return undefined;
  if (value['record-kind'] !== CHANNEL_STATE_RECORD_KIND.connection) return undefined;
  return typeof value['connection-id'] === 'string' ? value['connection-id'] : undefined;
}

function logIngressSupervisorFailure(
  context: BackgroundServiceContext,
  boundary: 'due-work' | 'retention' | 'connection-discovery' | 'poll',
  error: unknown,
  connectionId?: string,
): void {
  if (isInactiveSupervisorCollectionFailure(error)) return;
  context.services.logger.warn('[Channels] ingress supervisor work failed', {
    boundary,
    ...(connectionId === undefined ? {} : { connectionId, collectionId: CHANNEL_STATE_COLLECTION.id }),
    ...(classifySupervisorFailure(error) ?? {}),
  });
}

async function readCurrentConnections(context: BackgroundServiceContext): Promise<readonly Readonly<{
  connectionId: string;
  retryAt?: number;
}>[]> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const result: Array<{ connectionId: string; retryAt?: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await collection.query({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.connection],
      order: 'asc',
      limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal: context.signal });
    for (const row of page.rows) {
      const connectionId = connectionIdFromRow(row.value);
      if (connectionId === undefined) continue;
      const payload = isJsonRecord(row.value) ? row.value.payload : undefined;
      const failure = payload !== undefined && isJsonRecord(payload) ? payload.pollFailure : undefined;
      const retryAt = failure !== undefined && isJsonRecord(failure) && failure.phase === 'retryDue'
        && typeof failure.retryNotBeforeMs === 'number' && Number.isSafeInteger(failure.retryNotBeforeMs)
        ? failure.retryNotBeforeMs : undefined;
      result.push({ connectionId, ...(retryAt === undefined ? {} : { retryAt }) });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return result;
}

/**
 * One core-owned background service reconstructs only persisted connection
 * rows on each wake. It has no retained connection cache, queue, or poll
 * cursor: the ingress owner rereads and fences every actual poll effect. Its
 * transient state tracks in-flight polls, owner-derived next deadlines and
 * Collection keyset position. None is a durable queue, checkpoint, retained
 * connection authority, or second owner of ingress effects.
 */
export function createIngressSupervisor(
  options: IngressSupervisorOptions = {},
): IngressSupervisor {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const reconciliationIntervalMs = positiveDelay(
    options.reconciliationIntervalMs,
    RECOVERY_INTERVAL_MS,
    'Checkpointed poll reconciliation interval',
  );
  const runPoll = options.runPoll ?? (async (input, context) => await runConversationCheckpointedPollForInvocation(
    input,
    context,
    options.pairing,
  ));
  const runDueWork = options.runDueWork ?? (async (input, context) => await runConversationIngressDueWorkForInvocation(
    input,
    context,
  ));
  const runRetention = options.runRetention ?? (async (input, context) => await runConversationIngressRetentionForInvocation(
    input,
    context,
  ));
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  let updateRequired = false;

  const run = async (context: BackgroundServiceContext): Promise<void> => {
    if (disposed) throw new Error('Checkpointed poll supervisor is disposed.');
    if (running !== null) throw new Error('Checkpointed poll supervisor is already running.');
    if (updateRequired) return;
    const supervisorController = new AbortController();
    controller = supervisorController;
    const abortFromContext = (): void => supervisorController.abort(context.signal.reason);
    if (context.signal.aborted) abortFromContext();
    else context.signal.addEventListener('abort', abortFromContext, { once: true });
    let retentionCursor: string | undefined;
    let retentionDeadline: number | undefined;
    let retentionRetryRequired = false;
    let retentionInvalidated = false;
    // The first wake owns the startup pass: there is no earlier sweep to pace.
    let nextRetentionSweepAt = 0;
    const wake = createSupervisorWake(supervisorController.signal);
    // null parks a permanent boundary failure until stored input changes;
    // Infinity remains an ordinary ineligible connection awaiting its watch.
    const pollDeadlines = new Map<string, number | null>();
    const observations: Array<{ dispose(): void }> = [];
    // The polls this generation started and has not yet seen settle, keyed by
    // connection. It is the whole of the concurrency contract: a key that is
    // still present is a connection whose provider round trip is outstanding,
    // so this wake does not start a second one for it and per-connection order
    // survives without serializing the sweep. It is generation-local — no
    // durable queue, no retained connection cache, no second scheduler — and
    // the generation is not retired until every entry has drained.
    const inFlightPollsByConnectionId = new Map<string, Promise<void>>();
    // The single outstanding retention pass, for exactly the same reason and
    // with exactly the same lifetime as the poll map above.
    let retentionPass: Promise<void> | null = null;
    running = (async () => {
      try {
        const access = createChannelsCollectionAccess(requireChannelsAccountStorage(context), (status, error) => {
          updateRequired = true;
          context.services.logger.warn('[Channels] Account Collection requires an update', status);
          supervisorController.abort(error);
        });
        context = { ...context, services: { ...context.services, storage: {
          ...context.services.storage, account: access.storage,
        } } };
        const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
        observations.push(collection.watch({ kind: 'collection' }, () => {
          // A checkpoint/census repair can unblock a failed poll without
          // changing the connection or binding index watched below.
          for (const [id, deadline] of pollDeadlines) {
            if (deadline === null) pollDeadlines.delete(id);
          }
          retentionInvalidated = true;
          nextRetentionSweepAt = 0;
          wake.wake();
        }));
        for (const kind of [CHANNEL_STATE_RECORD_KIND.connection, CHANNEL_STATE_RECORD_KIND.binding]) {
          observations.push(collection.watch({ index: CHANNEL_STATE_INDEX_ID.byKind, prefix: [kind], order: 'asc' }, () => {
            pollDeadlines.clear();
            wake.wake();
            void context.services.events.plugin.emit('connections-invalidated-v1', {}, { signal: supervisorController.signal })
              .catch(error => logIngressSupervisorFailure(context, 'connection-discovery', error));
          }));
        }
        while (!supervisorController.signal.aborted) {
          wake.reset();
          const workerContext = {
            ...context,
            signal: supervisorController.signal,
          } satisfies BackgroundServiceContext;
          const now = clock.now();
          let recoveryAt: number | undefined;
          // Retention is maintenance and one page of it walks a whole
          // census unit per row — up to a connection read plus one read per
          // matched binding. Awaiting it inline put thousands of serial storage
          // round trips in front of every connection poll on the sweeping
          // wakes, so live ingress stalled behind cleanup of rows that are
          // already past a horizon measured in minutes. The pass runs as this
          // generation's own work instead, and the wake that finds one still
          // outstanding simply does not start a second pass over the cursor it
          // is already advancing.
          if (retentionPass === null && now >= nextRetentionSweepAt) {
            if (retentionInvalidated && retentionCursor === undefined) {
              // Finish this keyset sweep before replaying invalidations. The
              // sweep's own compaction writes also publish Collection changes;
              // restarting every page would repeatedly reread its prefix.
              // Keep the pending invalidation until exhaustion so rows changed
              // behind the cursor are still covered by the following sweep.
              retentionDeadline = undefined;
              retentionInvalidated = false;
            }
            const pass = (async () => {
              try {
                const retention = await runRetention({
                  now,
                  limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
                  ...(retentionCursor === undefined ? {} : { cursor: retentionCursor }),
                }, workerContext);
                retentionCursor = retention.nextCursor;
                if (retention.nextRetentionAt !== undefined) {
                  retentionDeadline = Math.min(retentionDeadline ?? Infinity, retention.nextRetentionAt);
                }
                if (retention.retryRequired) {
                  retentionRetryRequired = true;
                  retentionDeadline = Math.min(retentionDeadline ?? Infinity, clock.now() + reconciliationIntervalMs);
                }
                // A live cursor means this sweep is still mid-collection, so the
                // next wake takes its next page. After exhaustion, replay any
                // pending invalidation before parking until an owner-derived
                // expiry. A soft failure on any page retains the existing
                // recovery deadline (or earlier expiry) after exhaustion;
                // this sweep's own writes must not immediately retry it.
                // Later Collection hints still wake fresh work immediately.
                nextRetentionSweepAt = retentionCursor !== undefined || (retentionInvalidated && !retentionRetryRequired)
                  ? now
                  : retentionDeadline ?? Number.POSITIVE_INFINITY;
                if (retentionCursor === undefined) {
                  retentionDeadline = undefined;
                  retentionRetryRequired = false;
                }
              } catch (error) {
                if (supervisorController.signal.aborted) return;
                logIngressSupervisorFailure(workerContext, 'retention', error);
                // A failed page keeps its cursor but loses its urgency: retrying
                // it immediately would continuously re-fail the same page.
                nextRetentionSweepAt = now + reconciliationIntervalMs;
              }
            })();
            retentionPass = pass;
            // Cleared the same way, and for the same reason, as a poll key.
            void pass.finally(() => {
              retentionPass = null;
              if (Number.isFinite(nextRetentionSweepAt)) wake.wake();
            });
          }
          try {
            await runDueWork({ now, limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 }, workerContext);
          } catch (error) {
            if (supervisorController.signal.aborted) break;
            logIngressSupervisorFailure(workerContext, 'due-work', error);
            recoveryAt = now + reconciliationIntervalMs;
          }
          let connections: Awaited<ReturnType<typeof readCurrentConnections>>;
          try {
            connections = await readCurrentConnections(workerContext);
          } catch (error) {
            if (supervisorController.signal.aborted) break;
            logIngressSupervisorFailure(workerContext, 'connection-discovery', error);
            try {
              await wake.wait(clock, now + reconciliationIntervalMs);
            } catch {
              if (!supervisorController.signal.aborted) {
                throw new Error('Checkpointed poll supervisor retry wait failed.');
              }
            }
            continue;
          }
          const currentIds = new Set(connections.map(connection => connection.connectionId));
          for (const id of pollDeadlines.keys()) if (!currentIds.has(id)) pollDeadlines.delete(id);
          for (const { connectionId, retryAt } of connections) {
            if (supervisorController.signal.aborted) break;
            // A provider long poll blocks for its own wait, not for the other
            // connections': awaiting each one in turn made connections share a
            // serial sweep, so the last connection waited for every earlier round trip before it was
            // polled again, and due work and retention below waited with it.
            if (inFlightPollsByConnectionId.has(connectionId)) continue;
            if (pollDeadlines.get(connectionId) === null) continue;
            const deadline = Math.max(pollDeadlines.get(connectionId) ?? 0, retryAt ?? 0);
            if (deadline > now) {
              pollDeadlines.set(connectionId, deadline);
              continue;
            }
            if (deadline === Number.POSITIVE_INFINITY) continue;
            // A connection watch clears this entry. A settling older read may
            // not overwrite that invalidation with an ineligible outcome.
            pollDeadlines.set(connectionId, Number.POSITIVE_INFINITY);
            const poll = (async () => {
              try {
                const result = await runPoll({ connectionId, waitMs: MAX_CONVERSATION_RECEIVE_WAIT_MS }, workerContext);
                if (pollDeadlines.has(connectionId)) {
                  pollDeadlines.set(connectionId, result.kind === 'retry' || result.kind === 'committed'
                    ? Math.min(Number.MAX_SAFE_INTEGER, clock.now() + (result.retryAfterMs ?? reconciliationIntervalMs))
                    : Number.POSITIVE_INFINITY);
                }
              } catch (error) {
                if (supervisorController.signal.aborted) return;
                logIngressSupervisorFailure(workerContext, 'poll', error, connectionId);
                if (pollDeadlines.has(connectionId)) {
                  pollDeadlines.set(connectionId, classifySupervisorFailure(error)?.retryable === false
                    ? null : clock.now() + reconciliationIntervalMs);
                }
              }
            })();
            inFlightPollsByConnectionId.set(connectionId, poll);
            // Released through `finally` on the settled promise rather than
            // inside the body: a poll that fails before its first suspension
            // point would otherwise release the key before it was recorded,
            // and the record written afterwards would mark that connection
            // permanently in flight for the rest of the generation.
            void poll.finally(() => {
              inFlightPollsByConnectionId.delete(connectionId);
              if (!pollDeadlines.has(connectionId) || Number.isFinite(pollDeadlines.get(connectionId))) wake.wake();
            });
          }
          if (supervisorController.signal.aborted) break;
          let dueAt: number | undefined;
          try {
            const due = await collection.query({
              index: CHANNEL_STATE_INDEX_ID.byIngressDue,
              prefix: [CHANNEL_STATE_RECORD_KIND.ingressObligation],
              range: { lower: 0 }, order: 'asc', limit: 1,
            }, { signal: supervisorController.signal });
            const dueValue = due.rows[0]?.value;
            const value = dueValue !== undefined && isJsonRecord(dueValue) ? dueValue['due-at'] : undefined;
            if (typeof value === 'number') dueAt = value;
          } catch (error) {
            if (supervisorController.signal.aborted) break;
            logIngressSupervisorFailure(workerContext, 'due-work', error);
            recoveryAt = clock.now() + reconciliationIntervalMs;
          }
          const deadlines = [...pollDeadlines.values()].filter((value): value is number => value !== null && Number.isFinite(value));
          if (retentionPass === null && Number.isFinite(nextRetentionSweepAt)) deadlines.push(nextRetentionSweepAt);
          if (dueAt !== undefined) deadlines.push(dueAt);
          if (recoveryAt !== undefined) deadlines.push(recoveryAt);
          try {
            await wake.wait(clock, deadlines.length === 0 ? undefined : Math.min(...deadlines));
          } catch {
            if (!supervisorController.signal.aborted) {
              throw new Error('Checkpointed poll supervisor wait failed.');
            }
          }
        }
      } finally {
        for (const observation of observations) observation.dispose();
        wake.dispose();
        // Provider I/O this generation started still belongs to it. Resolving
        // while a poll is outstanding would let the replacement generation
        // admitted by `run` poll the same connection concurrently, and would
        // let `dispose` report a stopped service that is still calling out.
        await Promise.allSettled([
          ...inFlightPollsByConnectionId.values(),
          ...(retentionPass === null ? [] : [retentionPass]),
        ]);
        context.signal.removeEventListener('abort', abortFromContext);
        controller = null;
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    controller?.abort(new Error('Checkpointed poll supervisor was disposed.'));
    await running;
  };

  return Object.freeze({ run, dispose });
}
