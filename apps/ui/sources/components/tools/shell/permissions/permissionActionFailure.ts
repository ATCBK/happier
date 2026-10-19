import { useSyncExternalStore } from 'react';
import { log } from '@/log';
import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export type PermissionActionFailureKind =
    | 'approve'
    | 'approve_all_edits'
    | 'approve_for_session'
    | 'approve_for_session_subcommand'
    | 'approve_for_session_command'
    | 'approve_execpolicy'
    | 'deny'
    | 'stop';

/**
 * `failed`: the response is known not to have been applied, so answering again is safe.
 * `outcomeUnknown`: the response was dispatched but its result was lost, so it may already be applied.
 */
export type PermissionActionDisposition = 'failed' | 'outcomeUnknown';

export type PermissionActionFailureState = Readonly<{
    action: PermissionActionFailureKind;
    disposition: PermissionActionDisposition;
    sequence: number;
}>;

const OUTCOME_UNKNOWN_CODES: ReadonlySet<string> = new Set([RPC_ERROR_CODES.OUTCOME_UNKNOWN, 'action_outcome_unknown']);

/** The Action front door rethrows the typed RPC code on `code`; a raw RPC rejection carries `rpcErrorCode`. */
export function readPermissionActionDisposition(error: unknown): PermissionActionDisposition {
    const code = readRpcErrorCode(error) ?? readErrorRecordValue(error, 'code');
    return typeof code === 'string' && OUTCOME_UNKNOWN_CODES.has(code) ? 'outcomeUnknown' : 'failed';
}

function readErrorRecordValue(error: unknown, key: string): unknown {
    if (!error || typeof error !== 'object') return undefined;
    return (error as Record<string, unknown>)[key];
}

function summarizePermissionActionFailure(error: unknown): string {
    const code = readErrorRecordValue(error, 'code');
    if (typeof code === 'string' && code.length > 0) {
        return `code=${code}`;
    }

    const status = readErrorRecordValue(error, 'status');
    if (typeof status === 'number' && Number.isFinite(status)) {
        return `status=${status}`;
    }

    if (error instanceof Error && error.name.length > 0) {
        return `name=${error.name}`;
    }

    return `type=${typeof error}`;
}

export function recordPermissionActionFailure(
    action: PermissionActionFailureKind,
    error: unknown,
    previousFailure: PermissionActionFailureState | null,
): PermissionActionFailureState {
    log.log(`[PermissionFooter] permission action failed: action=${action} ${summarizePermissionActionFailure(error)}`);
    return {
        action,
        disposition: readPermissionActionDisposition(error),
        sequence: (previousFailure?.sequence ?? 0) + 1,
    };
}

/**
 * Requests whose answer was sent but not confirmed. Every footer that shows the same request reads this
 * one set, so neither the transcript card nor the prompt tray offers a second answer while it is unconfirmed.
 * A request leaves the set when it settles or when a re-read confirms it is still pending.
 */
const unconfirmedAnswers = new Set<string>();

/** The key one request has in the unconfirmed set, however many cards show it. */
export function permissionAnswerRequestKey(identity: Readonly<{
    originId: string;
    serverId?: string | null;
    permissionId: string;
    turnId?: string;
}>): string {
    return [identity.originId, identity.serverId ?? '', identity.permissionId, identity.turnId ?? ''].join('\u0000');
}
const unconfirmedListeners = new Set<() => void>();

function setPermissionAnswerUnconfirmed(requestKey: string, unconfirmed: boolean): void {
    if (unconfirmedAnswers.has(requestKey) === unconfirmed) return;
    if (unconfirmed) unconfirmedAnswers.add(requestKey);
    else unconfirmedAnswers.delete(requestKey);
    unconfirmedListeners.forEach((listener) => listener());
}

export const isPermissionAnswerUnconfirmed = (requestKey: string) => unconfirmedAnswers.has(requestKey);
export const markPermissionAnswerUnconfirmed = (requestKey: string) => setPermissionAnswerUnconfirmed(requestKey, true);
export const clearPermissionAnswerUnconfirmed = (requestKey: string) => setPermissionAnswerUnconfirmed(requestKey, false);

export function usePermissionAnswerUnconfirmed(requestKey: string): boolean {
    return useSyncExternalStore(
        (listener) => {
            unconfirmedListeners.add(listener);
            return () => { unconfirmedListeners.delete(listener); };
        },
        () => unconfirmedAnswers.has(requestKey),
        () => false,
    );
}
