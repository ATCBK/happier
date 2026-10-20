import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';

import { isRpcMethodNotAvailableError, readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { isSocketIoAckTimeoutError } from '@happier-dev/sync-client';

const TERMINAL_AUTO_RETRY_BASE_DELAY_MS = 250;
const TERMINAL_AUTO_RETRY_MAX_DELAY_MS = 4_000;
export const TERMINAL_AUTO_RETRY_MAX_ATTEMPTS = 6;
const TERMINAL_RECOVERABLE_SESSION_ERROR_CODES = new Set(['terminal_not_found']);

export function isRecoverableTerminalRpcError(error: unknown, phase: 'admission' | 'stream' = 'admission'): boolean {
    if (isSocketIoAckTimeoutError(error)) {
        return true;
    }
    if (!error || typeof error !== 'object') {
        return false;
    }
    const errorCode = readRpcErrorCode(error)
        ?? ('code' in error && typeof error.code === 'string' ? error.code : undefined)
        ?? ('ok' in error && error.ok === false && 'errorCode' in error && typeof error.errorCode === 'string'
            ? error.errorCode : undefined);
    return isRpcMethodNotAvailableError(error)
        || errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        || errorCode === RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE
        || (phase === 'stream' && errorCode === MACHINE_RPC_TIMEOUT_ERROR_CODE);
}

export function isRecoverableTerminalSessionErrorCode(errorCode: string | null | undefined): boolean {
    if (typeof errorCode !== 'string') return false;
    return TERMINAL_RECOVERABLE_SESSION_ERROR_CODES.has(errorCode.trim());
}

export function resolveTerminalAutoRetryDelayMs(attempt: number): number {
    const safeAttempt = Math.max(1, attempt);
    const delayMs = TERMINAL_AUTO_RETRY_BASE_DELAY_MS * (2 ** (safeAttempt - 1));
    return Math.min(TERMINAL_AUTO_RETRY_MAX_DELAY_MS, delayMs);
}

export function safeTimeoutSet(cb: () => void, delayMs: number): ReturnType<typeof setTimeout> | null {
    if (typeof setTimeout !== 'function') return null;
    return setTimeout(cb, delayMs);
}

export function safeTimeoutClear(timeoutId: ReturnType<typeof setTimeout> | null) {
    if (!timeoutId) return;
    if (typeof clearTimeout !== 'function') return;
    clearTimeout(timeoutId);
}
