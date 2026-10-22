import type {
    ConnectionHealthKind,
    ConnectionHealthMachineLabelKey,
    ConnectionHealthStatusLabelKey,
} from '@/components/navigation/connectionStatus/connectionHealthTypes';

export type DesktopTrayStatus =
    | 'healthy'
    | 'attention_required'
    | 'connecting'
    | 'server_unreachable'
    | 'auth_required'
    | 'server_error'
    | 'no_machine'
    | 'machine_offline';

export type DesktopTrayState = Readonly<{
    status: DesktopTrayStatus;
    label: string;
    detail: string;
    /** The tray's optional Updates item ("Updates available (2)…"); absent means no item. */
    updatesLabel?: string;
    /** Absent means enabled; `false` while an update is already running. */
    updatesEnabled?: boolean;
}>;

/** The Updates item the tray should show, already localized by the Updates summary owner. */
export type DesktopTrayUpdatesItem = Readonly<{ label: string; enabled: boolean }>;

function withUpdatesItem(
    state: DesktopTrayState,
    updates: DesktopTrayUpdatesItem | null | undefined,
): DesktopTrayState {
    const label = updates?.label.trim() ?? '';
    if (!updates || !label) return state;
    return { ...state, updatesLabel: label, updatesEnabled: updates.enabled };
}

export function buildDesktopTrayState(params: Readonly<{
    health: Readonly<{
        kind: ConnectionHealthKind;
        machineCount: number;
        onlineCount: number;
        statusLabelKey: ConnectionHealthStatusLabelKey;
        machineLabelKey: ConnectionHealthMachineLabelKey;
    }>;
    relayDriftBannerTitle?: string | null;
    updates?: DesktopTrayUpdatesItem | null;
    t: (key: ConnectionHealthStatusLabelKey | ConnectionHealthMachineLabelKey) => string;
}>): DesktopTrayState {
    const driftTitle = typeof params.relayDriftBannerTitle === 'string'
        ? params.relayDriftBannerTitle.trim()
        : '';
    if (params.health.kind === 'healthy' && driftTitle) {
        return withUpdatesItem({
            status: 'attention_required',
            label: params.t('status.actionRequired'),
            detail: driftTitle,
        }, params.updates);
    }

    const label = params.t(params.health.statusLabelKey);
    const machineLabel = params.t(params.health.machineLabelKey);
    const showCounts = params.health.machineCount > 0 && params.health.machineLabelKey !== 'status.unknown';
    const status = params.health.kind === 'machine_not_ready'
        ? 'attention_required'
        : params.health.kind === 'server_restarting' || params.health.kind === 'machine_unknown'
            ? 'connecting'
        : params.health.kind;

    return withUpdatesItem({
        status,
        label,
        detail: showCounts ? `${machineLabel} · ${params.health.onlineCount}/${params.health.machineCount}` : machineLabel,
    }, params.updates);
}
