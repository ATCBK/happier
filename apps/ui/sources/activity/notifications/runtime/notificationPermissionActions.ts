import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import type { ParsedNotificationTap } from '../notificationRouting';
import { resolveNotificationSavedHome } from '../resolveNotificationSavedHome';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { withTimeout } from '@/utils/timing/time';
import { markNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';

export type NotificationPermissionOutcome = Readonly<{
    status: 'ignored' | 'not_sent' | 'confirmed' | 'rejected' | 'unconfirmed' | 'conflict';
}>;

// Delivery/presentation bookkeeping only; this cannot authorize a mutation.
const handledResponses = new Set<string>();
const responses = new Map<string, { action: 'allow' | 'deny'; promise: Promise<NotificationPermissionOutcome> }>();

export function isNotificationPermissionAction(parsed: ParsedNotificationTap): boolean {
    return parsed.actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1
        || parsed.actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1;
}

function responseKey(parsed: ParsedNotificationTap): string | null {
    if (!isNotificationPermissionAction(parsed)) return null;
    if (!parsed.dedupeKey && parsed.command.kind !== 'executeAction') return null;
    return JSON.stringify([parsed.accountId, parsed.dedupeKey, parsed.command]);
}

export function wasNotificationResponseHandled(parsed: ParsedNotificationTap): boolean {
    const key = responseKey(parsed);
    return key !== null && handledResponses.has(key);
}

export function markNotificationResponseHandled(parsed: ParsedNotificationTap): void {
    const key = responseKey(parsed);
    if (key !== null) handledResponses.add(key);
}

function reportOutcome(outcome: NotificationPermissionOutcome): NotificationPermissionOutcome {
    if (outcome.status !== 'ignored' && outcome.status !== 'confirmed') {
        console.warn('[notifications] Permission action requires in-app review:', outcome.status);
        try { markNotificationPermissionRecoveryNeeded(); }
        catch { console.warn('[notifications] Permission action recovery storage unavailable'); }
    }
    return outcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Live Android callbacks share one exact request; a cached response only presents recovery. */
export async function executeNotificationPermissionAction(
    parsed: ParsedNotificationTap,
    options: Readonly<{ allowExecution?: boolean }> = {},
): Promise<NotificationPermissionOutcome> {
    if (!isNotificationPermissionAction(parsed)) return { status: 'ignored' };
    if (options.allowExecution === false) return reportOutcome({ status: 'not_sent' });
    markNotificationResponseHandled(parsed);
    const command = parsed.command;
    if (command.kind !== 'executeAction' || command.actionId !== 'session.permission.respond'
        || !isRecord(command.payload)) return reportOutcome({ status: 'not_sent' });
    const { sessionId, requestId, turnId, decision } = command.payload;
    if (typeof sessionId !== 'string' || !sessionId.trim() || typeof requestId !== 'string' || !requestId.trim()
        || typeof turnId !== 'string' || !turnId.trim() || (decision !== 'allow' && decision !== 'deny')) {
        return reportOutcome({ status: 'not_sent' });
    }
    const serverUrl = command.target.serverUrl;
    if (!serverUrl) return reportOutcome({ status: 'not_sent' });
    const home = resolveNotificationSavedHome({ serverId: command.target.serverId, serverUrl });
    if (!home) return reportOutcome({ status: 'not_sent' });
    const lifetime = new AbortController();
    let issued = false;
    try {
        return reportOutcome(await withTimeout(async () => {
            const binding = await resolveServerCredentialAccountScope(home.id);
            if (binding.kind !== 'bound' || lifetime.signal.aborted
                || parsed.accountId && parsed.accountId !== binding.scope.accountId) return { status: 'not_sent' } as const;
            const key = JSON.stringify([binding.scope.serverId, binding.scope.accountId, sessionId, turnId, requestId]);
            const pending = responses.get(key);
            if (pending) return pending.action === decision ? pending.promise : { status: 'conflict' } as const;
            const send = (async (): Promise<NotificationPermissionOutcome> => {
                let finished = false;
                let rejectAborted: (() => void) | undefined;
                const aborted = new Promise<never>((_, reject) => {
                    rejectAborted = () => reject(new Error('Notification permission action ended'));
                    lifetime.signal.addEventListener('abort', rejectAborted, { once: true });
                });
                try {
                    await Promise.race([(async () => {
                        const { sessionRespondToPermissionWithServerAccountScope } = await import('@/sync/ops/sessions');
                        if (lifetime.signal.aborted) throw new Error('Notification permission action ended');
                        await sessionRespondToPermissionWithServerAccountScope(sessionId, {
                            id: requestId, turnId, approved: decision === 'allow',
                            decision: decision === 'allow' ? 'approved' : 'denied',
                        }, { scope: binding.scope, networkMode: 'background-task', signal: lifetime.signal,
                            onIssued: () => {
                                if (finished || lifetime.signal.aborted) throw new Error('Notification permission action ended');
                                issued = true;
                            } });
                    })(), aborted]);
                    return { status: issued ? 'confirmed' : 'not_sent' };
                } catch (error) {
                    return { status: !issued ? 'not_sent' : readRpcErrorCode(error)?.startsWith('permission_')
                        ? 'rejected' : 'unconfirmed' };
                } finally {
                    finished = true;
                    if (rejectAborted) lifetime.signal.removeEventListener('abort', rejectAborted);
                }
            })();
            responses.set(key, { action: decision, promise: send });
            void send.then((outcome) => {
                // Reuse only an actual acknowledgement for this exact occurrence.
                // All other outcomes stay retryable within this JS runtime.
                if (outcome.status !== 'confirmed' && responses.get(key)?.promise === send) responses.delete(key);
            });
            return await send;
        }, DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS, 'notification permission action'));
    } catch {
        return reportOutcome({ status: issued ? 'unconfirmed' : 'not_sent' });
    } finally {
        lifetime.abort();
    }
}
