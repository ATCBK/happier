import { logger as defaultLogger } from '@/ui/logger';

import { drainRuntimeAuthFailureReportOutboxToDaemon } from './runtimeAuthFailureReportOutboxDrain';
import { sanitizeConnectedServiceDiagnosticError } from '../sanitizeConnectedServiceDiagnosticString';

type RuntimeAuthFailureReportOutboxDrainLogger = Readonly<{
  debug: (message: string, error?: unknown) => void;
}>;

type Timer = ReturnType<typeof setTimeout>;

const DEFAULT_DRAIN_DELAY_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 10_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

let scheduledTimer: Timer | null = null;
let drainInFlight = false;
let pendingDrainInput: DrainScheduleInput | null = null;

function clearScheduledTimer(clearTimeoutFn: typeof clearTimeout = clearTimeout): void {
  if (!scheduledTimer) return;
  clearTimeoutFn(scheduledTimer);
  scheduledTimer = null;
}

function unrefTimer(timer: Timer): void {
  const maybeUnref = (timer as { unref?: () => void }).unref;
  if (typeof maybeUnref === 'function') {
    maybeUnref.call(timer);
  }
}

function readDelayMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

type DrainScheduleInput = Readonly<{
  outboxDir?: string;
  logger?: RuntimeAuthFailureReportOutboxDrainLogger;
  logPrefix?: string;
  delayMs?: number;
  retryDelayMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  drain?: typeof drainRuntimeAuthFailureReportOutboxToDaemon;
}>;

async function drainOnce(input: DrainScheduleInput, automaticAttempt: number): Promise<void> {
  if (drainInFlight) return;

  const logger = input.logger ?? defaultLogger;
  const logPrefix = input.logPrefix ?? '[connected-services]';
  const drain = input.drain ?? drainRuntimeAuthFailureReportOutboxToDaemon;
  let shouldRetry = false;

  drainInFlight = true;
  try {
    const result = await drain({
      ...(input.outboxDir ? { outboxDir: input.outboxDir } : {}),
    });
    shouldRetry = result.retried > 0;
  } catch (error) {
    shouldRetry = true;
    logger.debug(`${logPrefix} Failed to drain connected-service runtime auth failure report outbox (non-fatal): ${sanitizeConnectedServiceDiagnosticError(error)}`);
  } finally {
    drainInFlight = false;
  }

  const pending = pendingDrainInput;
  pendingDrainInput = null;
  if (shouldRetry) {
    const retryDelayMs = readDelayMs(input.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
    scheduleDrain({
      ...input,
      delayMs: Math.min(
        retryDelayMs * (2 ** Math.max(0, automaticAttempt - 1)),
        DEFAULT_MAX_RETRY_DELAY_MS,
      ),
    }, automaticAttempt + 1);
  } else if (pending) {
    scheduleDrain(pending, 1);
  }
}

export function resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests(): void {
  clearScheduledTimer();
  drainInFlight = false;
  pendingDrainInput = null;
}

function scheduleDrain(input: DrainScheduleInput, automaticAttempt: number): void {
  if (drainInFlight) {
    pendingDrainInput = input;
    return;
  }
  if (scheduledTimer) return;

  const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
  const delayMs = readDelayMs(input.delayMs, DEFAULT_DRAIN_DELAY_MS);
  scheduledTimer = setTimeoutFn(() => {
    clearScheduledTimer(clearTimeoutFn);
    void drainOnce(input, automaticAttempt);
  }, delayMs);
  unrefTimer(scheduledTimer);
}

export function scheduleRuntimeAuthFailureReportOutboxDrainToDaemon(
  input: DrainScheduleInput = {},
): void {
  scheduleDrain(input, 1);
}
