import { resolveHomeDisplayLabel, resolveHomeDisplayNameForRelayUrl } from '@/components/settings/server/homeDisplayName';
import { formatAccountDisplayName, resolveViewerAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';

import {
    classifyRelayDrift,
    isDaemonOnActiveRelay,
    resolveThisComputerServiceState,
    type RelayDriftStatus,
    type ThisComputerServiceState,
} from './relayDriftModel';

/**
 * What a daemon reports about itself: the desktop's local status read for this computer, or a
 * machine's cached doctor snapshot. Unknown facts stay `undefined`.
 */
export type ThisComputerDaemonFacts = Readonly<{
    serviceInstalled?: boolean;
    daemonRunning?: boolean;
    needsAuth?: boolean;
    daemonServerUrl?: string | null;
    daemonAlternateRelayUrls?: readonly (string | null | undefined)[];
    daemonAccountId?: string | null;
    /** Readable label of the account the relay validated for the daemon, when the CLI reports one. */
    daemonAccountLabel?: string | null;
}>;

/**
 * The one description of "this computer" every surface shares: how its daemon relates to the Home
 * and account the app is on, with the exact names a sentence about it needs.
 */
export type ThisComputerConnection = Readonly<{
    status: RelayDriftStatus;
    homeLabel: string;
    daemonHomeLabel: string | null;
    appAccountLabel: string;
    daemonAccountLabel: string | null;
}>;

/**
 * `null` when there is nothing to say about this computer: no status read yet (or no local bridge,
 * as on web), or no daemon at all — nothing installed and nothing running is the ordinary first-run
 * state that setup owns, not drift.
 */
export function resolveThisComputerConnection(params: Readonly<{
    daemon: ThisComputerDaemonFacts | null;
    activeRelayUrl: string | null | undefined;
    activeLocalRelayUrl: string | null | undefined;
    appAccountId: string | null | undefined;
    appAccountLabel: string | null | undefined;
}>): ThisComputerConnection | null {
    const daemon = params.daemon;
    if (!daemon || (daemon.serviceInstalled === false && daemon.daemonRunning === false)) {
        return null;
    }
    const activeRelayUrl = String(params.activeRelayUrl ?? '').trim();
    if (!activeRelayUrl) {
        return null;
    }

    const classification = classifyRelayDrift({
        activeRelayUrl,
        activeLocalRelayUrl: params.activeLocalRelayUrl,
        daemonRelayUrl: daemon.daemonServerUrl,
        daemonAlternateRelayUrls: daemon.daemonAlternateRelayUrls,
        daemonAccountId: daemon.daemonAccountId,
        appAccountId: params.appAccountId,
        daemonNeedsAuth: daemon.needsAuth,
        daemonServiceInstalled: daemon.serviceInstalled,
        daemonRunning: daemon.daemonRunning,
    });

    const daemonServerUrl = String(daemon.daemonServerUrl ?? '').trim();
    const appAccountLabel = resolveViewerAccountDisplayName(params.appAccountLabel);
    const daemonName = formatAccountDisplayName({ name: daemon.daemonAccountLabel });
    const daemonIsViewer = isDaemonOnActiveRelay({
        activeRelayUrl,
        activeLocalRelayUrl: params.activeLocalRelayUrl,
        daemonRelayUrl: daemonServerUrl,
        daemonAlternateRelayUrls: daemon.daemonAlternateRelayUrls,
    }) === true && Boolean(daemon.daemonAccountId?.trim()) && daemon.daemonAccountId?.trim() === params.appAccountId?.trim();
    return {
        status: classification.status,
        homeLabel: resolveHomeDisplayNameForRelayUrl(activeRelayUrl) ?? resolveHomeDisplayLabel(null, ''),
        daemonHomeLabel: daemonServerUrl ? resolveHomeDisplayNameForRelayUrl(daemonServerUrl) ?? resolveHomeDisplayLabel(null, '') : null,
        appAccountLabel,
        daemonAccountLabel: daemonName ?? (daemonIsViewer ? appAccountLabel : daemon.daemonAccountId?.trim() ? t('accountDisplay.unnamed') : null),
    };
}

/** A background service's state as every "this computer" list shows it (R16 c). */
export type ThisComputerServiceRowState = ThisComputerServiceState;
export type ThisComputerServiceAction = 'start' | 'restart' | 'stop';

/**
 * One background service on this computer, one per Home it serves, as the executor lists it inside
 * `daemon.service.status.v1` (`serviceRows`). The executor decides the state, whether the desktop
 * manages the service and which lifecycle actions it allows; the app re-judges only its own Home.
 */
export type ThisComputerServiceRow = Readonly<{
    relayUrl: string;
    state: ThisComputerServiceRowState;
    appManaged: boolean;
    serviceTargetMode: 'default-following' | 'pinned';
    actions: readonly ThisComputerServiceAction[];
    /** A13-07 — agent sessions running for this service, only when the app can see them; omitted otherwise. */
    activeSessionCount?: number;
}>;

export type ThisComputerServiceRows =
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'failed' }>
    | Readonly<{ status: 'listed'; rows: readonly ThisComputerServiceRow[]; complete: boolean }>;

const SERVICE_ROW_STATES: ReadonlySet<string> = new Set<ThisComputerServiceRowState>(['connected', 'offline', 'needs_attention']);
const SERVICE_ACTIONS: ReadonlySet<string> = new Set<ThisComputerServiceAction>(['start', 'restart', 'stop']);

/** The executor's `serviceRows`; `null` when the status carried none. A malformed row is dropped. */
export function readThisComputerServiceRows(value: unknown): ThisComputerServiceRow[] | null {
    if (!Array.isArray(value)) return null;
    return value.flatMap((raw): ThisComputerServiceRow[] => {
        if (!raw || typeof raw !== 'object') return [];
        const record = raw as Record<string, unknown>;
        const relayUrl = typeof record.relayUrl === 'string' ? record.relayUrl.trim() : '';
        const state = typeof record.state === 'string' ? record.state : '';
        if (!relayUrl || !SERVICE_ROW_STATES.has(state)) return [];
        const actions = Array.isArray(record.actions)
            ? record.actions.filter((action): action is ThisComputerServiceAction => typeof action === 'string' && SERVICE_ACTIONS.has(action))
            : [];
        return [{
            relayUrl,
            state: state as ThisComputerServiceRowState,
            appManaged: record.appManaged === true,
            serviceTargetMode: record.serviceTargetMode === 'default-following' ? 'default-following' : 'pinned',
            actions,
        }];
    });
}


/**
 * The tray's rows: the executor's, with the row for the Home the app is on judged again against
 * the app's own account (the executor cannot know which account the app uses) by the same drift
 * classifier every other "this computer" surface uses. `status` is the app's own status read,
 * scoped to that Home; `null` until one answered.
 */
export function projectThisComputerServiceRowsForApp(params: Readonly<{
    status: (ThisComputerDaemonFacts & Readonly<{
        serviceRows?: readonly ThisComputerServiceRow[] | null;
        serviceRowsComplete?: boolean | null;
    }>) | null;
    activeRelayUrl: string | null | undefined;
    activeLocalRelayUrl: string | null | undefined;
    appAccountId: string | null | undefined;
    /** The app Home's running sessions when the app can see them (`readAppHomeSessionCount`); else null. */
    appHomeActiveSessionCount?: number | null;
}>): ThisComputerServiceRows {
    const status = params.status;
    const sessionCount = params.appHomeActiveSessionCount;
    if (!status) return { status: 'pending' };
    if (!status.serviceRows) return { status: 'failed' };
    const rows = status.serviceRows.map((row): ThisComputerServiceRow => {
        const onAppHome = isDaemonOnActiveRelay({
            activeRelayUrl: params.activeRelayUrl,
            activeLocalRelayUrl: params.activeLocalRelayUrl,
            daemonRelayUrl: row.relayUrl,
        }) === true;
        if (!onAppHome) return row;
        const state = resolveThisComputerServiceState(classifyRelayDrift({
            activeRelayUrl: row.relayUrl,
            daemonRelayUrl: status.daemonServerUrl,
            daemonAlternateRelayUrls: status.daemonAlternateRelayUrls,
            daemonAccountId: status.daemonAccountId,
            appAccountId: params.appAccountId,
            daemonNeedsAuth: status.needsAuth,
            daemonServiceInstalled: status.serviceInstalled,
            daemonRunning: status.daemonRunning,
        }).status);
        const counted = typeof sessionCount === 'number' && row.activeSessionCount !== sessionCount;
        if (state === row.state && !counted) return row;
        return { ...row, state, ...(typeof sessionCount === 'number' ? { activeSessionCount: sessionCount } : {}) };
    });
    return { status: 'listed', rows, complete: status.serviceRowsComplete !== false };
}
