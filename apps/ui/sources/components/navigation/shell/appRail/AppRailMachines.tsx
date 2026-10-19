import * as React from 'react';

import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { warmMachineResourceSummaries } from '@/sync/domains/machines/resources/warmMachineResourceSummaries';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { SidebarFooterPopoverButton, type SidebarFooterPopoverContentProps, type SidebarFooterPopoverTrigger } from '../sidebarFooter/SidebarFooterPopoverButton';
import { SidebarMachinesPopoverContent } from '../sidebarFooter/SidebarMachinesPopoverContent';
import { RAIL_POPOVER_ROSTER_MAX_HEIGHT_PX, RAIL_POPOVER_WIDE_WIDTH_PX } from '../sidebarFooter/sidebarFooterLayout';
import { AppRailBadge, AppRailMenuCount } from './AppRailBadge';
import { APP_RAIL_ICON_GLYPH_SIZE_PX, APP_RAIL_ITEM_SIZE_PX } from './appRailMetrics';
import { buildMachinesRailSeen, forgetRecoveredMachinesRailReasons, useMachinesRailSignal } from './useMachinesRailSignal';

/**
 * Pointer-enter / keyboard focus on the icon: one one-shot summary read per online machine this app
 * session has not read yet, so the popover's first frame already holds values (MPG-19). No watch, nothing
 * to release when the pointer leaves; only the opened popover starts live demand.
 */
function warmUnreadMachineSummaries(): void {
    const serverId = getActiveServerId();
    const state = storage.getState();
    const scope = selectActiveServerAccountScopeForServer(state.profileScope, serverId);
    const keys = Object.values(state.machines)
        .filter(machine => isMachineVisibleForLaunchSelection(machine) && isMachineSelectableForFleet(scope, machine))
        .map(machine => ({ serverId, machineId: machine.id, daemonStateVersion: machine.daemonStateVersion }));
    if (keys.length > 0) fireAndForget(warmMachineResourceSummaries(keys), { tag: 'AppRailMachines.warm' });
}

/**
 * The rail's Machines icon (lab `rm` I). Closed, it reads only the string-keyed fleet attention, what this
 * device has seen, and presence counts: a count when machines need you, an amber dot for a new "worth a
 * look", a muted dot when the guard acted since the popover was opened, nothing when calm or offline (R4).
 * The tooltip names the machine and its reason. Opening the popover records what was seen (MPG-16).
 */
export const AppRailMachines = React.memo(function AppRailMachines(props: Readonly<{
    renderTrigger?: SidebarFooterPopoverTrigger;
    /** The Machines page is open through the rail door (`/machines/**`): the icon is the selected destination (R1). */
    selected?: boolean;
}>) {
    const rail = useMachinesRailSignal();
    const [seen, setSeen] = useLocalSettingMutable('machinesRailSeenV1');
    const title = t('settings.machines');
    const label = rail.detail ? `${title} · ${rail.detail}` : title;
    const fleetRef = React.useRef(rail.fleet);
    fleetRef.current = rail.fleet;
    // "Since you last looked" compares against the opening before this one, read before this one records itself.
    const seenRef = React.useRef(seen);
    seenRef.current = seen;
    const previousFleetRef = React.useRef(rail.fleet);
    React.useEffect(() => {
        const previous = previousFleetRef.current;
        previousFleetRef.current = rail.fleet;
        // A real reporting transition clears recovered reasons. Mounting or changing Account/Home
        // establishes no recovery fact about the previously observed scope.
        if (previous === rail.fleet || !areServerAccountScopesEqual(previous.accountScope, rail.fleet.accountScope)) return;
        const next = forgetRecoveredMachinesRailReasons(rail.fleet, seenRef.current);
        if (next !== seenRef.current) setSeen(next);
    }, [rail.fleet, setSeen]);
    const previousGuardSeenAtRef = React.useRef(seen.guardSeenAt);
    const recordSeen = React.useCallback(() => {
        previousGuardSeenAtRef.current = seenRef.current.guardSeenAt;
        setSeen(buildMachinesRailSeen(fleetRef.current, Date.now()));
    }, [setSeen]);
    const renderMachines = React.useCallback((content: SidebarFooterPopoverContentProps) => (
        <SidebarMachinesPopoverContent {...content} guardSeenAt={previousGuardSeenAtRef.current} />
    ), []);
    const signal = rail.signal;
    const menuTrigger: SidebarFooterPopoverTrigger | undefined = props.renderTrigger ? state => props.renderTrigger?.({ ...state,
        right: signal?.kind === 'count' ? <AppRailMenuCount tone={signal.tone} value={signal.value} /> : undefined,
    }) : undefined;
    return (
        <>
            <SidebarFooterPopoverButton
                testID="app-rail-machines"
                iconName="desktop"
                label={label}
                placement="right"
                buttonSizePx={APP_RAIL_ITEM_SIZE_PX}
                iconSizePx={APP_RAIL_ICON_GLYPH_SIZE_PX}
                popoverWidthPx={RAIL_POPOVER_WIDE_WIDTH_PX}
                popoverMaxHeightPx={RAIL_POPOVER_ROSTER_MAX_HEIGHT_PX}
                renderContent={renderMachines}
                renderTrigger={menuTrigger}
                selected={props.selected}
                hoverPreview
                onOpenIntent={recordSeen}
                onWarmIntent={warmUnreadMachineSummaries}
            />
            {signal && !props.renderTrigger ? <AppRailBadge testID="app-rail-machines-badge" signal={signal} /> : null}
        </>
    );
});
