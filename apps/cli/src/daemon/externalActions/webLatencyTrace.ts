import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@/ui/logger';

const context = new AsyncLocalStorage<string>();

export function withWebLatencyTrace<T>(requestId: unknown, operation: () => T): T {
  return process.env.HAPPIER_WEB_LATENCY_TRACE === '1'
    && typeof requestId === 'string' && /^(?:new-session-attempt-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(requestId)
    ? context.run(requestId, operation) : operation();
}

export async function timeWebLatencyPhase<T>(phase: string, operation: () => T | Promise<T>): Promise<T> {
  if (process.env.HAPPIER_WEB_LATENCY_TRACE !== '1') return await operation();
  const started = performance.now();
  try { return await operation(); }
  finally {
    try { logger.warnLocalFile('[web-latency]', { phase, elapsedMs: performance.now() - started,
      ...(context.getStore() ? { requestId: context.getStore() } : {}) }); } catch { /* Diagnostic only. */ }
  }
}
