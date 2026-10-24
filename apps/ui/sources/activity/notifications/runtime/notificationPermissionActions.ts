import { isNotificationPermissionAction, parseNotificationTap, type ParsedNotificationTap } from '../notificationRouting';
import { createNotificationPermissionCoordinator, type NotificationPermissionOutcome } from './notificationPermissionCoordinator';
import { markNotificationResponseHandled } from './notificationResponseConsumption';
import { markNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { withTimeout } from '@/utils/timing/time';

const coordinate = createNotificationPermissionCoordinator();

function reportOutcome(outcome: NotificationPermissionOutcome): NotificationPermissionOutcome {
    if (outcome.status !== 'confirmed' && outcome.status !== 'ignored') {
        console.warn('[notifications] Permission action requires in-app review:', outcome.status);
        try {
            markNotificationPermissionRecoveryNeeded();
        } catch {
            console.warn('[notifications] Permission action recovery storage unavailable');
        }
    }
    return outcome;
}

export async function executeNotificationPermissionAction(
    parsed: ParsedNotificationTap,
    options: Readonly<{
        allowExecution?: boolean;
        // Bundle-loader boundary; target/authentication logic remains real.
        importTarget?: () => Promise<typeof import('./resolveNotificationPermissionTarget')>;
    }> = {},
): Promise<NotificationPermissionOutcome> {
    if (!isNotificationPermissionAction(parsed)) return { status: 'ignored' };
    // Cached notification delivery is observation, never authorization to send.
    if (options.allowExecution === false) return { status: 'not_sent' };
    markNotificationResponseHandled(parsed);
    if (!parsed.permissionAction?.occurrenceId || !parsed.serverUrl) return reportOutcome({ status: 'not_sent' });
    const { sessionId, requestId, occurrenceId, action } = parsed.permissionAction;
    const serverUrl = parsed.serverUrl;
    if (!sessionId.trim() || !requestId.trim()) return reportOutcome({ status: 'not_sent' });

    const lifetime = new AbortController();
    let issued = false;
    try {
        // One action lifetime uses the existing scoped-operation budget across
        // preparation and dispatch. This is not an Android execution guarantee.
        return reportOutcome(await withTimeout(async () => {
            const { resolveNotificationPermissionTarget } = await (options.importTarget ?? (() => import('./resolveNotificationPermissionTarget')))();
            const scope = await resolveNotificationPermissionTarget(serverUrl, parsed.accountId);
            if (!scope || lifetime.signal.aborted) return { status: 'not_sent' } as const;
            return coordinate({ ...scope, sessionId, requestId, occurrenceId, action }, async (onIssued, signal) => {
                const { sessionPermissionDecisionWithServerAccountScope } = await import('@/sync/ops/sessionPermissionDecision');
                return sessionPermissionDecisionWithServerAccountScope({
                    scope, sessionId, requestId, occurrenceId, action,
                    networkMode: 'background-task',
                    signal,
                    onIssued: () => { onIssued(); issued = true; },
                });
            }, { signal: lifetime.signal });
        }, DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS, 'notification permission action'));
    } catch {
        return reportOutcome({ status: issued ? 'unconfirmed' : 'not_sent' });
    } finally {
        lifetime.abort();
    }
}

export async function handleNotificationBackgroundTask(body: unknown): Promise<NotificationPermissionOutcome> {
    if (typeof body !== 'object' || body === null || !('data' in body)) return { status: 'ignored' };
    if ('error' in body && body.error) return reportOutcome({ status: 'not_sent' });
    const data = body.data;
    if (typeof data !== 'object' || data === null || !('actionIdentifier' in data)) return { status: 'ignored' };
    const parsed = parseNotificationTap({ response: data, defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
    return parsed ? executeNotificationPermissionAction(parsed) : { status: 'ignored' };
}
