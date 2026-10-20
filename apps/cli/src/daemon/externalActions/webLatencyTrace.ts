import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@/ui/logger';

const context = new AsyncLocalStorage<Readonly<{
  requestId: string;
  sessionId?: string;
  sequence: { next: number };
  spanId?: number;
  parentSpanId?: number;
}>>();

export type WebLatencyTracePoint = Readonly<{ requestId: string; spanId?: number }>;

/** Owner-supplied code/identity facts only; never approval operands or errors. */
export type WebLatencyApprovalFacts = Readonly<{
  artifactId?: string;
  executionRequestId?: string;
  operationId?: string;
  liveWaiterCount?: number;
  detachedWaiterCount?: number;
  signalMatchesHostLifetime?: boolean;
  signalAborted?: boolean;
  resolved?: boolean;
  inputIdentityEqual?: boolean;
}>;

/** Diagnostic provenance for an already-shared promise, never an authority witness. */
export function readWebLatencyTracePoint(): WebLatencyTracePoint | undefined {
  const current = context.getStore();
  return process.env.HAPPIER_WEB_LATENCY_TRACE === '1' && current
    ? { requestId: current.requestId, ...(current.spanId === undefined ? {} : { spanId: current.spanId }) } : undefined;
}

export function withWebLatencyTrace<T>(requestId: unknown, operation: () => T, sessionId?: string): T {
  if (context.getStore()?.requestId === requestId) return operation();
  // MCP child spawns hash the parent/creation-key tuple to retain one root
  // across retries; ordinary Actions and new-Session attempts use UUIDs.
  return process.env.HAPPIER_WEB_LATENCY_TRACE === '1'
    && typeof requestId === 'string' && /^(?:(?:new-session-attempt-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{64})$/iu.test(requestId)
    ? context.run({ requestId, ...(sessionId ? { sessionId } : {}), sequence: { next: 0 } }, operation) : operation();
}

export async function timeWebLatencyPhase<T>(phase: string, operation: () => T | Promise<T>, source?: WebLatencyTracePoint,
  approvalFacts?: () => WebLatencyApprovalFacts): Promise<T> {
  if (process.env.HAPPIER_WEB_LATENCY_TRACE !== '1') return await operation();
  const started = performance.now();
  const parent = context.getStore();
  const span = parent ? { ...parent, spanId: ++parent.sequence.next,
    ...(parent.spanId === undefined ? {} : { parentSpanId: parent.spanId }) } : undefined;
  const correlation = { ...(source ? { sourceRequestId: source.requestId,
    ...(source.spanId === undefined ? {} : { sourceSpanId: source.spanId }) } : {}),
    ...(span ? { requestId: span.requestId, ...(span.sessionId ? { sessionId: span.sessionId } : {}),
      spanId: span.spanId, ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }) } : {}) };
  try { logger.warnLocalFile('[web-latency]', { phase, status: 'started', ...correlation, ...approvalFacts?.() }); } catch { /* Diagnostic only. */ }
  let status: 'completed' | 'failed' = 'failed';
  let current: boolean | undefined;
  try {
    const result = await (span ? context.run(span, operation) : operation());
    if (typeof result === 'boolean') current = result;
    status = 'completed';
    return result;
  }
  finally {
    try { logger.warnLocalFile('[web-latency]', { phase, elapsedMs: performance.now() - started,
      status, ...(current === undefined ? {} : { current }), ...correlation, ...approvalFacts?.() }); } catch { /* Diagnostic only. */ }
  }
}
