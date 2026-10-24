import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from '@/utils/logging/log';

const context = new AsyncLocalStorage<Readonly<{
    requestId: string;
    sessionId?: string;
    sequence: { next: number };
    spanId?: number;
    parentSpanId?: number;
}>>();

export function withWebLatencyTrace<T>(requestId: unknown, operation: () => T, sessionId?: string): T {
    // Nested action dispatch keeps the request's identity and span sequence.
    if (context.getStore()) return operation();
    // RPC forwards need the existing HTTP root even when detailed phase timing
    // is disabled. Emission and SQL annotation keep their own existing gate.
    return typeof requestId === 'string' && /^(?:req-[0-9a-z]+|(?:new-session-attempt-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu.test(requestId)
        ? context.run({ requestId, ...(sessionId ? { sessionId } : {}), sequence: { next: 0 } }, operation) : operation();
}

/** The existing trace owner admits only content-free request identities. */
export function readWebLatencyRequestId(): string | undefined {
    return context.getStore()?.requestId;
}

/** Only validated trace identities enter SQL; never copy input, Session ids or query values. */
export function annotateWebLatencyQuery(sql: string): string {
    const current = context.getStore();
    return process.env.HAPPIER_WEB_LATENCY_TRACE === '1' && current?.spanId !== undefined
        ? `${sql}\n/* happier-web-latency:${current.requestId}:${current.spanId} */` : sql;
}

export async function timeWebLatencyPhase<T>(phase: string, operation: () => T | Promise<T>, transactionClass?: string): Promise<T> {
    if (process.env.HAPPIER_WEB_LATENCY_TRACE !== '1') return await operation();
    const started = performance.now();
    const parent = context.getStore();
    const span = parent ? { ...parent, spanId: ++parent.sequence.next,
        ...(parent.spanId === undefined ? {} : { parentSpanId: parent.spanId }) } : undefined;
    let status: 'completed' | 'failed' = 'failed';
    let outcome: { code?: string; sqlState?: string } = {};
    try {
        const result = await (span ? context.run(span, operation) : operation());
        status = 'completed';
        return result;
    } catch (error) {
        // Diagnostic projection only: preserve the original exception and never log its message/SQL.
        try {
            if (typeof error === 'object' && error !== null) {
                if ('code' in error && typeof error.code === 'string' && /^P\d{4}$/u.test(error.code)) outcome.code = error.code;
                if ('meta' in error && typeof error.meta === 'object' && error.meta !== null
                    && 'code' in error.meta && typeof error.meta.code === 'string' && /^[0-9A-Z]{5}$/u.test(error.meta.code)) {
                    outcome.sqlState = error.meta.code;
                }
            }
        } catch { /* Diagnostics cannot replace the operation's failure. */ }
        throw error;
    } finally {
        emitWebLatencyPhase(phase, performance.now() - started, transactionClass, status, outcome, span);
    }
}

/** Lifecycle hooks already own their stopwatch; keep their output and scope identical. */
export function recordWebLatencyPhase(phase: string, elapsedMs: number, transactionClass?: string): void {
    emitWebLatencyPhase(phase, elapsedMs, transactionClass);
}

function emitWebLatencyPhase(phase: string, elapsedMs: number, transactionClass?: string,
    status?: 'completed' | 'failed', outcome?: Readonly<{ code?: string; sqlState?: string }>, current = context.getStore()): void {
    if (process.env.HAPPIER_WEB_LATENCY_TRACE !== '1') return;
    // Successful per-query/callback timings dominate long-lived diagnostic logs.
    // Keep request summaries and failed spans at debug; full SQL span detail is trace.
    const level = phase.startsWith('db.') && status !== 'failed' ? 'trace' : 'debug';
    try { log({ level, module: 'web-latency', phase, elapsedMs,
        ...(transactionClass ? { transactionClass } : {}),
        ...(status ? { status, ...outcome } : {}),
        ...(current ? { requestId: current.requestId, ...(current.sessionId ? { sessionId: current.sessionId } : {}),
            ...(current.spanId === undefined ? {} : { spanId: current.spanId }),
            ...(current.parentSpanId === undefined ? {} : { parentSpanId: current.parentSpanId }) } : {}),
    }, '[web-latency]'); } catch { /* Diagnostic only. */ }
}
