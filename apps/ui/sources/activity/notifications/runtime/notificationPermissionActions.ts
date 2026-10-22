import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { parseNotificationTap, type ParsedNotificationTap } from '../notificationRouting';
import { createNotificationPermissionCoordinator, type NotificationPermissionOutcome } from './notificationPermissionCoordinator';
import { withTimeout } from '@/utils/timing/time';
import { EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS } from '@/utils/platform/loadExpoNotifications';

type ImportJournal = () => Promise<typeof import('./notificationPermissionJournal')>;
const importJournalModule: ImportJournal = () => import('./notificationPermissionJournal');

let coordinator: ReturnType<typeof createNotificationPermissionCoordinator> | undefined;

export function isNotificationPermissionAction(parsed: ParsedNotificationTap): boolean {
    return parsed.actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1
        || parsed.actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1;
}

async function reportOutcome(outcome: NotificationPermissionOutcome, importJournal: ImportJournal = importJournalModule): Promise<NotificationPermissionOutcome> {
    if (outcome.status !== 'confirmed' && outcome.status !== 'ignored') {
        // An on-by-default, content-free signal, including failures before a scope
        // can be resolved. Detailed RPC errors may contain sensitive identifiers.
        console.warn('[notifications] Permission action requires in-app review:', outcome.status);
        try {
            const { markNotificationPermissionRecoveryNeeded } = await withTimeout(
                importJournal, EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS, 'notification recovery module load',
            );
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
        explicitRetry?: boolean;
        // Bundle-loader seams, like loadExpoNotifications; domain behavior stays real.
        importTarget?: () => Promise<typeof import('./resolveNotificationPermissionTarget')>;
        importJournal?: ImportJournal;
    }> = {},
): Promise<NotificationPermissionOutcome> {
    const importJournal = options.importJournal ?? importJournalModule;
    const report = (outcome: NotificationPermissionOutcome) => reportOutcome(outcome, importJournal);
    if (!isNotificationPermissionAction(parsed)) return { status: 'ignored' };
    if (!parsed.permissionAction || !parsed.serverUrl) return report({ status: 'not_sent' });
    const serverUrl = parsed.serverUrl;
    const { sessionId, requestId, action } = parsed.permissionAction;
    if (!sessionId.trim() || !requestId.trim()) return report({ status: 'not_sent' });
    try {
        // Share the existing authentication deadline across its lazy imports and
        // target resolution. The preflight cannot issue; coordinator entry stays
        // OUTSIDE the timed promise, so late completion never starts a decision.
        const preflight = await withTimeout(async () => {
            const { resolveNotificationPermissionTarget } = await (options.importTarget ?? (() => import('./resolveNotificationPermissionTarget')))();
            const scope = await resolveNotificationPermissionTarget(serverUrl, parsed.accountId);
            if (!scope) return null;
            const { notificationPermissionJournal } = await importJournal();
            return { scope, journal: notificationPermissionJournal };
        }, 30_000, 'notification permission preflight');
        if (!preflight) return report({ status: 'not_sent' });
        const { scope, journal } = preflight;
        coordinator ??= createNotificationPermissionCoordinator(journal);
        const request = { ...scope, sessionId, requestId, action };
        // getLastNotificationResponseAsync is a saved event, not new user intent.
        // It may report an issued result, but must never initiate/retry a decision.
        return report(await coordinator(request, async (onIssued, signal) => {
            const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
            return sessionRpcWithServerAccountScope<unknown, { id: string; approved: boolean; decision: string; reason?: string }>({
                scope,
                sessionId,
                method: 'permission',
                networkMode: 'background-task',
                signal,
                payload: action === 'allow'
                    ? { id: requestId, approved: true, decision: 'approved' }
                    : { id: requestId, approved: false, decision: 'denied', reason: 'Denied from notification' },
                onIssued,
            });
        }, options));
    } catch {
        return report({ status: 'not_sent' });
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
