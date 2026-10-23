import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID, SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { SessionUsageLimitRecoveryAuthSelectionV1, SessionUsageLimitRecoveryResumePromptModeV1, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import {
  UsageLimitCheckNowRateLimiter,
  USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
} from '@/session/usageLimitRecoveryControls/usageLimitCheckNowRateLimiter';
import {
  hasSameUsageLimitRecoveryIdentity,
  isPendingUsageLimitRecoveryStatus,
  mergeUsageLimitRecoveryRearm,
  mergeUsageLimitRecoverySchedule,
} from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';
import {
  recordConnectedServiceDaemonRestartDiagnostic,
  type ConnectedServiceDaemonRestartDiagnosticRecorder,
} from '../sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import {
  DurableBackoffRecoveryScheduler,
  type DurableBackoffRecoveryStore,
  type DurableRecoveryGateResult,
} from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import { DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS } from '@/session/usageLimitRecoveryControls/createBackoffSessionUsageLimitRecoveryControlAdapter';
import { deterministicStringify } from '@/utils/deterministicJson';
import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import type { PendingResetStartBindingV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { evaluatePendingResetStartReadinessV1 } from '@happier-dev/protocol/sessions/pending/pendingResetStartReadinessV1';

export type PendingResetStartDemand = Readonly<{ localId: string; reset: PendingResetStartBindingV1 }>;
export type PendingResetStartSessionPorts = Readonly<{
  read: () => Promise<readonly PendingResetStartDemand[]>;
  readAuthority: (demand: PendingResetStartDemand) => Promise<boolean>;
  isCurrent: () => Promise<boolean>;
  readWitness: (reset: PendingResetStartBindingV1) => Promise<ProviderAccountUsageSnapshotV1 | null>;
  readCurrent: (reset: PendingResetStartBindingV1) => Promise<ProviderAccountUsageSnapshotV1 | null>;
  release: (input: PendingResetStartDemand) => Promise<void>;
}>;
export type PendingResetStartRecoveryPorts = Readonly<{
  withSession: (sessionId: string, run: (ports: PendingResetStartSessionPorts) => Promise<void>) => Promise<void>;
  onError?: (error: unknown) => void;
}>;

export const RUNTIME_USAGE_LIMIT_RECOVERY_FIELD = SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID;
export const METADATA_SESSION_USAGE_LIMIT_RECOVERY_V1_KEY = SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY;

export type UsageLimitRecoveryIntent = SessionUsageLimitRecoveryV1;

export type UsageLimitRecoverySchedulerRecoveryResult =
  | Readonly<{ status: 'ready'; selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1 }>
  | Readonly<{ status: 'resumed'; selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1 }>
  | Readonly<{ status: 'pause'; selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1 }>
  | Readonly<{ status: 'wait'; nextCheckAtMs: number; selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1; lastProbeError?: string | null }>
  | Readonly<{ status: 'exhausted'; lastProbeError?: string | null }>
  /**
   * The probe proved the intent is stale (e.g. the interrupted turn later
   * completed normally): cancel terminally without resuming.
   */
  | Readonly<{ status: 'superseded'; lastProbeError?: string | null }>
  | Readonly<{
    status: 'failed';
    resultStatus: string;
    errorCode?: string | null;
    lastProbeError?: string | null;
    details?: Readonly<Record<string, unknown>>;
  }>;

export type UsageLimitRecoveryCancelExactResult =
  | Readonly<{ status: 'cancelled'; intent: UsageLimitRecoveryIntent }>
  | Readonly<{ status: 'superseded'; intent: UsageLimitRecoveryIntent }>
  | Readonly<{ status: 'missing' }>;

function readUsageLimitRecoveryIntent(value: unknown): UsageLimitRecoveryIntent | null {
  const parsed = createStoredReadSchema(SessionUsageLimitRecoveryV1Schema).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readUsageLimitRecoveryServiceId(
  selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1,
): string | null {
  return selectedAuth.kind === 'native' ? null : selectedAuth.serviceId;
}

function readUsageLimitRecoveryProfileId(
  selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1,
): string | null {
  return selectedAuth.kind === 'native' ? null : selectedAuth.profileId;
}

function readUsageLimitRecoveryGroupId(
  selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1,
): string | null {
  return selectedAuth.kind === 'group' ? selectedAuth.groupId : null;
}

function normalizeScheduledUsageLimitRecoveryIntent(intent: UsageLimitRecoveryIntent): UsageLimitRecoveryIntent {
  if (!isPendingUsageLimitRecoveryStatus(intent.status)) return intent;
  return {
    ...intent,
    status: intent.status === 'checking' ? 'waiting' : intent.status,
    nextCheckAtMs: intent.nextCheckAtMs ?? intent.resetAtMs
      ?? intent.armedAtMs + DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS,
  };
}

const DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS = 3;
const DEFAULT_USAGE_LIMIT_RECOVERY_TERMINAL_RECORD_RETENTION_MS = 7 * 24 * 60 * 60_000;

function resolveUsageLimitRecoveryPruneReferenceMs(intent: UsageLimitRecoveryIntent): number {
  return Math.max(
    intent.armedAtMs,
    intent.resetAtMs ?? 0,
    intent.nextCheckAtMs ?? 0,
  );
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 {
  return value === 'off' || value === 'custom' ? value : 'standard';
}

/**
 * Same-fingerprint re-arm merge for `enable()`. Mirrors `mergeTemporaryThrottleIntent`:
 * a usage-limit that resurfaces for the SAME issue must NOT reset attemptCount to 0,
 * must NOT resurrect a cancelled/exhausted terminal state, and must keep the existing
 * waiting/checking lifecycle. It DOES adopt the latest selectedAuth/resumePromptMode and
 * takes the earlier of the two next-check times. A genuinely different fingerprint (or no
 * prior intent) starts fresh.
 */
export class UsageLimitRecoveryScheduler {
  private readonly checkNowRateLimiter: UsageLimitCheckNowRateLimiter;
  private readonly scheduler: DurableBackoffRecoveryScheduler<UsageLimitRecoveryIntent>;
  private disposed = false;
  private readonly pendingResetDemandKeys = new Map<string, Readonly<{ sessionId: string; localId: string }>>();
  private readonly pendingResetReconciliations = new Map<string, Promise<void>>();

  constructor(private readonly deps: Readonly<{
    nowMs: () => number;
    store?: DurableBackoffRecoveryStore<UsageLimitRecoveryIntent>;
    recover?: (intent: UsageLimitRecoveryIntent, context: Readonly<{ sessionId: string; reason: string }>) => Promise<UsageLimitRecoverySchedulerRecoveryResult>;
    resume?: (intent: UsageLimitRecoveryIntent) => Promise<void>;
    recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
    checkNowThrottleMs?: number;
    gate?: (input: Readonly<{ sessionId: string; intent: UsageLimitRecoveryIntent }>) => DurableRecoveryGateResult;
    /**
     * O4: optional resolver so callers with a known agent id (e.g. codex app-server) can
     * surface it in the restart diagnostic instead of leaving agentId null at the quota seam.
     */
    resolveAgentId?: (sessionId: string) => string | null;
    pendingResetStarts?: PendingResetStartRecoveryPorts;
  }>) {
    this.checkNowRateLimiter = new UsageLimitCheckNowRateLimiter({
      nowMs: deps.nowMs,
      throttleMs: deps.checkNowThrottleMs,
    });
    this.scheduler = new DurableBackoffRecoveryScheduler<UsageLimitRecoveryIntent>({
      nowMs: deps.nowMs,
      store: deps.store,
      normalizeIntent: readUsageLimitRecoveryIntent,
      isSameIntentVersion: (left, right) => (
        hasSameUsageLimitRecoveryIdentity(left, right)
        && deterministicStringify(left) === deterministicStringify(right)
      ),
      getStatus: (intent) => intent.status === 'armed' ? 'waiting' : (
        intent.status === 'waiting'
        || intent.status === 'checking'
        || intent.status === 'cancelled'
        || intent.status === 'exhausted'
          ? intent.status
          : 'cancelled'
      ),
      getNextRetryAtMs: (intent) => intent.nextCheckAtMs ?? intent.resetAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      terminalRecordRetentionMs: DEFAULT_USAGE_LIMIT_RECOVERY_TERMINAL_RECORD_RETENTION_MS,
      getTerminalPruneReferenceMs: resolveUsageLimitRecoveryPruneReferenceMs,
      // A readiness probe does not spend the continuation-attempt budget.
      markChecking: (intent) => ({
        ...intent,
        status: 'checking',
      }),
      markWaiting: (intent, next) => ({
        ...intent,
        status: 'waiting',
        nextCheckAtMs: next.nextRetryAtMs,
        lastProbeError: next.lastError,
      }),
      markCancelled: (intent) => ({
        ...intent,
        status: 'cancelled',
        nextCheckAtMs: null,
      }),
      markExhausted: (intent, next) => ({
        ...intent,
        status: 'exhausted',
        lastProbeError: next.lastError,
      }),
      recover: async (intent, context) => await this.recoverUsageLimitIntent(intent, context),
      gate: deps.gate,
      exhaustAfterWait: false,
      honorTimerNotBefore: true,
    });
  }

  read(sessionId: string): UsageLimitRecoveryIntent | null {
    return this.scheduler.read(sessionId);
  }

  hydrate(): ReadonlyArray<UsageLimitRecoveryIntent> {
    return this.scheduler.hydrate();
  }

  /** Reconstructs persisted state without scheduling or executing recovery. */
  hydratePassive(): ReadonlyArray<UsageLimitRecoveryIntent> {
    return this.scheduler.hydrate({ schedule: false });
  }

  load(input: Readonly<{
    sessionId: string;
    intent: UsageLimitRecoveryIntent;
  }>): UsageLimitRecoveryIntent {
    return this.scheduler.load(input);
  }

  async upsert(input: Readonly<{
    sessionId: string;
    intent: UsageLimitRecoveryIntent;
  }>): Promise<UsageLimitRecoveryIntent> {
    return await this.scheduler.upsert(input);
  }

  async upsertScheduled(input: Readonly<{
    sessionId: string;
    intent: UsageLimitRecoveryIntent;
  }>): Promise<UsageLimitRecoveryIntent> {
    return await this.scheduler.upsertMerged({
      sessionId: input.sessionId,
      intent: input.intent,
      merge: (previous, next) => normalizeScheduledUsageLimitRecoveryIntent(
        mergeUsageLimitRecoverySchedule(previous, next),
      ),
    });
  }

  async enable(input: Readonly<{
    sessionId: string;
    issueFingerprint: string;
    resetAtMs: number | null;
    nextCheckAtMs?: number | null;
    maxAttempts?: number;
    selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1;
    resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  }>): Promise<UsageLimitRecoveryIntent> {
    const nowMs = this.deps.nowMs();
    const maxAttempts = typeof input.maxAttempts === 'number' && Number.isFinite(input.maxAttempts)
      ? Math.max(0, Math.trunc(input.maxAttempts))
      : DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS;
    const intent: UsageLimitRecoveryIntent = {
      v: 1,
      issueFingerprint: input.issueFingerprint,
      status: 'waiting',
      resumePromptMode: readResumePromptMode(input.resumePromptMode),
      armedAtMs: nowMs,
      resetAtMs: input.resetAtMs,
      nextCheckAtMs: input.nextCheckAtMs ?? input.resetAtMs,
      attemptCount: 0,
      maxAttempts,
      lastProbeError: null,
      selectedAuth: input.selectedAuth,
    };
    // Merge instead of overwrite so a same-fingerprint resurfacing preserves attemptCount /
    // terminal (cancelled/exhausted) / next-check state rather than resetting the lifecycle to 0
    // and re-looping. Different fingerprint / no prior intent starts fresh.
    return await this.scheduler.upsertMerged({
      sessionId: input.sessionId,
      intent,
      merge: (previous, next) => normalizeScheduledUsageLimitRecoveryIntent(
        mergeUsageLimitRecoveryRearm(previous, next),
      ),
    });
  }

  async cancel(input: Readonly<{ sessionId: string }>): Promise<UsageLimitRecoveryIntent | null> {
    return await this.scheduler.cancel(input);
  }

  async cancelExact(input: Readonly<{
    sessionId: string;
    issueFingerprint: string;
    armedAtMs: number;
    runtimeAuthRecoveryAttemptId?: string;
  }>): Promise<UsageLimitRecoveryCancelExactResult> {
    // The canonical cancellation transaction also retires this exact intent's effect claim.
    let superseded: UsageLimitRecoveryIntent | null = null;
    const cancelled = await this.scheduler.cancel({
      sessionId: input.sessionId,
      matches: (current) => {
        if (hasSameUsageLimitRecoveryIdentity(current, input)) return true;
        superseded = current;
        return false;
      },
    });
    if (cancelled) return { status: 'cancelled', intent: cancelled };
    return superseded ? { status: 'superseded', intent: superseded } : { status: 'missing' };
  }

  async checkNow(input: Readonly<{ sessionId: string }>): Promise<Readonly<{
    status: string;
    errorCode?: string;
    retryAfterMs?: number;
  }>> {
    const current = this.read(input.sessionId);
    if (!current) return { status: 'inactive' };
    const rateLimit = this.checkNowRateLimiter.check(input.sessionId);
    if (!rateLimit.allowed) {
      return {
        status: 'rate_limited',
        errorCode: USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
        retryAfterMs: rateLimit.retryAfterMs,
      };
    }
    if (current.status === 'cancelled') return { status: 'inactive' };
    if (current.status === 'exhausted') return { status: 'exhausted' };
    if (current.status === 'paused') {
      await this.enable({
        sessionId: input.sessionId,
        issueFingerprint: current.issueFingerprint,
        resetAtMs: current.resetAtMs,
        nextCheckAtMs: this.deps.nowMs(),
        maxAttempts: current.maxAttempts,
        resumePromptMode: current.resumePromptMode,
        selectedAuth: current.selectedAuth,
      });
    }
    return await this.wake({ sessionId: input.sessionId, reason: 'check_now' });
  }

  async wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'check_now' }>): Promise<Readonly<{ status: string }>> {
    return await this.scheduler.wake(input);
  }

  /**
   * Retires this scheduler with the owner that created it: armed timers are cleared and later
   * wakes report `disposed` instead of claiming durable work. A machine-sync attempt that failed
   * hands its scheduler here before a replacement attempt hydrates the same durable store.
   */
  dispose(): void {
    this.disposed = true;
    this.pendingResetDemandKeys.clear();
    this.scheduler.dispose();
  }

  /** Pending owns persistence; restart and every wake re-read the exact held rows. */
  async reconcilePendingResetStarts(sessionId: string): Promise<void> {
    if (this.disposed || !this.deps.pendingResetStarts) return;
    const existing = this.pendingResetReconciliations.get(sessionId);
    if (existing) {
      await existing;
      return await this.reconcilePendingResetStarts(sessionId);
    }
    const operation = this.reconcilePendingResetStartsOnce(sessionId);
    this.pendingResetReconciliations.set(sessionId, operation);
    try { await operation; }
    finally {
      if (this.pendingResetReconciliations.get(sessionId) === operation) this.pendingResetReconciliations.delete(sessionId);
    }
  }

  async reconcilePendingResetStartsForTrackedSessions(): Promise<void> {
    const sessionIds = new Set([...this.pendingResetDemandKeys.values()].map(key => key.sessionId));
    await Promise.all([...sessionIds].map(sessionId => this.reconcilePendingResetStarts(sessionId)));
  }

  private async reconcilePendingResetStartsOnce(sessionId: string): Promise<void> {
    const ports = this.deps.pendingResetStarts;
    if (!ports || this.disposed) return;
    await ports.withSession(sessionId, async session => {
      const rows = await session.read();
      if (this.disposed || !await session.isCurrent()) return;
      const localIds = new Set(rows.map(row => row.localId));
      for (const [id, key] of this.pendingResetDemandKeys) {
        if (key.sessionId === sessionId && !localIds.has(key.localId)) {
          this.scheduler.clearDemand(key);
          this.pendingResetDemandKeys.delete(id);
        }
      }
      for (const row of rows) {
        if (this.disposed) return;
        const id = JSON.stringify([sessionId, row.localId]);
        const key = this.pendingResetDemandKeys.get(id) ?? { sessionId, localId: row.localId };
        this.pendingResetDemandKeys.set(id, key);
        this.scheduler.clearDemand(key);
        const authorityCurrent = await session.readAuthority(row);
        if (!authorityCurrent || this.disposed || !await session.isCurrent()) continue;
        const previous = await session.readWitness(row.reset);
        const current = await session.readCurrent(row.reset);
        const authorityCurrentAtDecision = !this.disposed && await session.isCurrent() && !this.disposed;
        const readiness = evaluatePendingResetStartReadinessV1({ reset: row.reset, witness: previous, current,
          nowMs: this.deps.nowMs(), authorityCurrent: authorityCurrentAtDecision });
        if (readiness.status === 'waiting' && readiness.nextCheckAtMs !== undefined) {
          this.scheduler.scheduleDemand({ key, notBeforeMs: readiness.nextCheckAtMs, wake: () => {
            void this.reconcilePendingResetStarts(sessionId).catch(error => ports.onError?.(error));
          } });
          continue;
        }
        if (readiness.status !== 'ready') continue;
        await session.release(row);
        if (this.disposed) return;
        this.pendingResetDemandKeys.delete(id);
      }
    });
  }

  private async recoverUsageLimitIntent(
    checking: UsageLimitRecoveryIntent,
    context: Readonly<{ sessionId: string; reason: string }>,
  ) {
    const recovery = this.deps.recover
      ? await this.deps.recover(checking, context)
      : { status: 'wait' as const, nextCheckAtMs: checking.nextCheckAtMs ?? checking.resetAtMs ?? this.deps.nowMs() };

    if (recovery.status === 'pause' || (recovery.status === 'ready'
      && (readResumePromptMode(checking.resumePromptMode) === 'off' || !this.deps.resume))) {
      return {
        // Settle the existing durable claim without the success path converting paused to cancelled.
        status: 'pending' as const,
        intent: {
          ...checking,
          status: 'paused' as const,
          nextCheckAtMs: null,
          lastProbeError: null,
          selectedAuth: recovery.selectedAuth ?? checking.selectedAuth,
        },
        wakeResult: { status: 'ready' },
      };
    }

    if (recovery.status === 'ready' || recovery.status === 'resumed') {
      const succeeded: UsageLimitRecoveryIntent = {
        ...checking,
        status: 'cancelled',
        attemptCount: checking.attemptCount + 1,
        selectedAuth: recovery.selectedAuth ?? checking.selectedAuth,
      };
      // O4: resolve agentId when a resolver is provided (e.g. codex app-server knows its agentId);
      // fall back to null for inactive-session schedulers that don't have agent context.
      const resolvedAgentId = this.deps.resolveAgentId
        ? this.deps.resolveAgentId(context.sessionId)
        : null;
      recordConnectedServiceDaemonRestartDiagnostic({
        diagnostic: {
          trigger: 'usage_limit_recovery',
          sessionId: context.sessionId,
          agentId: resolvedAgentId,
          serviceId: readUsageLimitRecoveryServiceId(succeeded.selectedAuth),
          profileId: readUsageLimitRecoveryProfileId(succeeded.selectedAuth),
          groupId: readUsageLimitRecoveryGroupId(succeeded.selectedAuth),
          reason: succeeded.issueFingerprint,
        },
        status: 'requested',
        nowMs: this.deps.nowMs,
        recordRestartDiagnostic: this.deps.recordRestartDiagnostic,
      });
      try {
        if (recovery.status === 'ready') await this.deps.resume?.(succeeded);
      } catch (error) {
        return {
          status: 'wait' as const,
          intent: succeeded,
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        status: 'success' as const,
        intent: succeeded,
        wakeResult: { status: 'resumed' },
      };
    }

    if (recovery.status === 'exhausted') {
      return {
        status: 'exhausted' as const,
        intent: checking,
        lastError: recovery.lastProbeError ?? null,
      };
    }

    if (recovery.status === 'superseded') {
      return {
        status: 'terminal' as const,
        intent: checking,
        lastError: recovery.lastProbeError ?? null,
      };
    }

    if (recovery.status === 'failed') {
      return {
        status: 'exhausted' as const,
        intent: checking,
        lastError: recovery.lastProbeError ?? recovery.errorCode ?? recovery.resultStatus,
        wakeResult: {
          status: recovery.resultStatus,
          ...(recovery.errorCode ? { errorCode: recovery.errorCode } : {}),
          ...(recovery.details ?? {}),
        },
      };
    }

    const nextCheckAtMs = recovery.nextCheckAtMs > this.deps.nowMs()
      ? recovery.nextCheckAtMs
      : this.deps.nowMs() + DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS;
    return {
      status: 'wait' as const,
      nextRetryAtMs: nextCheckAtMs,
      intent: recovery.selectedAuth
        ? {
            ...checking,
            selectedAuth: recovery.selectedAuth,
          }
        : checking,
      lastError: recovery.lastProbeError ?? null,
    };
  }
}
