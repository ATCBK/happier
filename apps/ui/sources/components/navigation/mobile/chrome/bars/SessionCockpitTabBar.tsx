import { useSessionCollaborationDestinationAdmitted } from '@/hooks/session/useSessionCollaborationAvailability';
import { useSessionBoardFeatureEnabled } from '@/components/sessions/board/useSessionBoardFeatureEnabled';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import * as React from 'react';
import { listPendingPermissionRequests } from '@/utils/sessions/sessionUtils';
import { useWindowDimensions } from 'react-native';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { useSession, useSessionProjectScmStatus, useSetting } from '@/sync/domains/state/storage';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { useAppRightSidebarTabInputs } from '@/components/appShell/rightSidebar/appRightSidebarTabs';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { resolveGitTabBadge } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import {
    resolveSessionCockpitMobileCatalog,
    resolveSessionCockpitMobileTabVisibility,
    type SessionCockpitMobileCatalogEntry,
} from '@/components/workspaceCockpit/session/sessionCockpitMobileCatalog';
import { type NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { NavigationPlacementPinButton } from '@/components/ui/navigation/NavigationPlacementPinButton';
import { Modal } from '@/modal';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveFloatingTabBarSlotCount } from '@/components/ui/navigation/FloatingTabBarSurface';
import { resolveTabBarMetrics, type TabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { layout } from '@/components/ui/layout/layout';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { SessionCollaborationRailBadge } from '@/components/sessions/collaboration/sessionConversationAttention';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { PendingNavigationPill } from '@/components/sessions/pendingNavigation/PendingNavigationPill';

import { useSessionSwitcherBand } from '../lateralSwipe/SessionSwitcherBand';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import {
    CockpitTabBar,
    CockpitTabBarAction,
    CockpitTabBarView,
    CockpitTabBarActionView,
    type CockpitTabBarTabDefinition,
} from './CockpitTabBar';
import { publishCockpitBarScrolls } from './cockpitBarScrollState';
import { sfSymbolForCockpitTabIcon } from './cockpitTabSymbols';

export type SessionCockpitTabBarProps = Readonly<{
    sessionId: string;
    /** Route server scope, so the capsule and the picker anchor on the same entry. */
    serverId?: string | null;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    openDetailsTabCount: number;
    pluginPlacements?: readonly PluginUiSurfacePlacementProjection[];
    onSurfacePress: (surface: SessionMobileSurface) => void;
}>;

export type SessionCockpitTabDefinition = CockpitTabBarTabDefinition<SessionMobileSurface> & Readonly<{ sfSymbol: string }>;

const PREVIOUS_SESSION_ACTION = 'previousSession';
const NEXT_SESSION_ACTION = 'nextSession';
const SWITCH_SESSION_ACTION = 'switchSession';
const ignorePreviewPress = () => {};

/** Placement-only specimen: captured descriptors, with no Session readers or live menu owners. */
function SessionCockpitTabBarPreview(props: Readonly<{
    catalog: readonly SessionCockpitMobileCatalogEntry[];
    tabs: readonly SessionCockpitTabDefinition[];
    preferences: NavigationPlacementPreferences;
    activeSurface: SessionMobileSurface;
    slotCount: number;
    alwaysSwipe: boolean;
    metrics: TabBarMetrics;
}>) {
    const visibility = resolveSessionCockpitMobileTabVisibility(props);
    const tabs = visibility.visible.flatMap(entry => props.tabs.filter(tab => tab.id === entry.id));
    const activeBehindMore = [...visibility.held, ...visibility.overflow].some(entry => entry.id === props.activeSurface)
        ? props.tabs.find(tab => tab.id === props.activeSurface) ?? null : null;
    return <CockpitTabBarView activeSurface={props.activeSurface} tabs={tabs}
        barTestId="session-cockpit-preview" tabTestIdPrefix="session-cockpit-preview-tab-"
        metrics={props.metrics} bottomInset={0} layout={visibility.mode === 'scroll' ? 'scroll' : 'fit'}
        onSurfacePress={ignorePreviewPress} trailing={<CockpitTabBarActionView metrics={props.metrics}
            testID="session-cockpit-preview-more" label={activeBehindMore?.label ?? t('common.more')}
            icon={activeBehindMore && typeof activeBehindMore.icon === 'string' ? activeBehindMore.icon : 'dots-three'}
            selected={activeBehindMore !== null} onPress={ignorePreviewPress} />} />;
}

/** Catalog admission and presentation facts shared by both phone bar presenters. */
export function useSessionCockpitTabDefinitions(props: Pick<SessionCockpitTabBarProps,
    'sessionId' | 'serverId' | 'terminalTabAvailable' | 'openDetailsTabCount' | 'pluginPlacements'>) {
    const sessionServerId = usePreferredServerIdForSession({ serverId: props.serverId, sessionId: props.sessionId });
    const collaborationAdmitted = useSessionCollaborationDestinationAdmitted(sessionServerId ?? '');
    const sessionSharingAvailable = Boolean(sessionServerId) && collaborationAdmitted;
    const collaborationTarget = React.useMemo(
        () => normalizeSessionAddress(sessionServerId, props.sessionId),
        [props.sessionId, sessionServerId],
    );
    const boardFeatureEnabled = useSessionBoardFeatureEnabled(sessionServerId);
    const session = useSession(props.sessionId, props.serverId);
    const pendingNavigationAddress = React.useMemo(
        () => normalizeSessionAddress(props.serverId ?? session?.serverId, props.sessionId),
        [props.serverId, props.sessionId, session?.serverId],
    );
    const scmStatus = useSessionProjectScmStatus(props.sessionId, props.serverId);
    const gitBadgeMode = useSetting('tabBarGitBadgeMode');
    const openTabsBadgeEnabled = useSetting('tabBarOpenTabsBadgeEnabled');
    // A session whose Agent cannot be named has no brand for this tab. The
    // catalog identity owner already renders that neutrally; substituting the
    // product default would label another Agent's session Claude.
    const agentId = React.useMemo(
        () => (session ? readSessionPresentationAgentId(session) : null) ?? '',
        [session],
    );
    // The session's reachable machine target scopes catalog identity resolution;
    // the same owner the Session header uses, so the capsule and the header
    // cannot resolve one session's Agent through two different machines.
    const reachableMachineTarget = useSessionReachableMachineTarget(props.sessionId, props.serverId);
    const agentCore = isBundledAgentId(agentId) ? getAgentCore(agentId) : null;
    const gitBadge = resolveGitTabBadge(gitBadgeMode, scmStatus);
    const pendingPermissionCount = React.useMemo(
        () => (session ? listPendingPermissionRequests(session).length : 0),
        [session],
    );
    const appTabInputs = useAppRightSidebarTabInputs();

    const catalog = React.useMemo(() => resolveSessionCockpitMobileCatalog({
        ...appTabInputs,
        sessionSharingAvailable,
        boardFeatureEnabled,
        terminalTabAvailable: props.terminalTabAvailable,
        pluginPlacements: props.pluginPlacements,
    }), [appTabInputs, boardFeatureEnabled, sessionSharingAvailable, props.pluginPlacements, props.terminalTabAvailable]);
    const tabForEntry = (entry: SessionCockpitMobileCatalogEntry): SessionCockpitTabDefinition => {
        if (entry.owner === 'host') {
            if (entry.id === 'chat') {
                return {
                    id: 'chat',
                    sfSymbol: 'bubble.left',
                    label: agentCore
                        ? t(agentCore.displayNameKey)
                        // No Agent to name yet (unhydrated or unpublished): the tab names its pane.
                        : agentId ? formatAgentLikeIdForDisplay(agentId) : t('phoneNav.rail.chatPane'),
                    icon: {
                        render: ({ size, tintColor }) => (
                            <SessionAgentCatalogIdentityIcon
                                agentId={agentId}
                                machineId={reachableMachineTarget?.machineId ?? null}
                                serverId={props.serverId ?? null}
                                color={tintColor}
                                size={size}
                                testID="session-cockpit-tab-chat-agent-icon"
                            />
                        ),
                    },
                };
            }
            if (entry.id === 'companion') {
                return {
                    id: 'companion',
                    label: t('sessionBoard.companion.title'),
                    icon: 'stack-simple',
                    sfSymbol: sfSymbolForCockpitTabIcon('stack-simple'),
                    // The Companion holds the ask with its answers (lab CAp): an amber
                    // dot says something there is waiting, from the canonical pending flag.
                    ...(pendingPermissionCount > 0
                        ? {
                            badge: { kind: 'attention' as const },
                            accessibilityLabel: t('sessionCompanion.needsYouA11y', { count: pendingPermissionCount }),
                        }
                        : {}),
                };
            }
            return {
                id: 'tabs',
                // "Open files": the Details views open in this session. Not "Tabs" (that word now
                // means the account's open tabs), and not the Companion's layered glyph.
                label: t('phoneNav.bar.openFiles'),
                icon: 'files',
                sfSymbol: sfSymbolForCockpitTabIcon('files'),
                badge: openTabsBadgeEnabled && props.openDetailsTabCount > 0
                    ? { kind: 'count', value: props.openDetailsTabCount }
                    : undefined,
            };
        }
        const tab = entry.tab;
        return {
            id: entry.id,
            label: tab.owner === 'plugin' ? tab.label : t(tab.labelKey),
            icon: tab.icon,
            sfSymbol: sfSymbolForCockpitTabIcon(tab.icon),
            ...(entry.id === 'git' && gitBadge ? { badge: gitBadge } : {}),
        };
    };
    return { catalog, tabForEntry, pendingNavigationAddress, collaborationTarget, agentId, hasBundledAgent: agentCore !== null };
}

export const SessionCockpitTabBar = React.memo((props: SessionCockpitTabBarProps) => {
    const { catalog, tabForEntry, pendingNavigationAddress, collaborationTarget, agentId, hasBundledAgent } = useSessionCockpitTabDefinitions(props);
    // The band's actions are built HERE because a tab is the only element in the band a screen
    // reader can focus, and an action only reaches the rotor through the element that owns it.
    // They are the switcher's non-gesture path: step either way, or open it for tapping.
    const switcherBand = useSessionSwitcherBand();
    const bandAccessibilityActions = React.useMemo(() => (switcherBand ? [
        { name: SWITCH_SESSION_ACTION, label: t('phoneNav.switcher.switchSessionAction') },
        { name: PREVIOUS_SESSION_ACTION, label: t('workspaceCockpit.previousSession') },
        { name: NEXT_SESSION_ACTION, label: t('workspaceCockpit.nextSession') },
    ] : undefined), [switcherBand]);
    const handleBandAccessibilityAction = React.useCallback((actionName: string) => {
        if (!switcherBand) return;
        if (actionName === SWITCH_SESSION_ACTION) { switcherBand.dock(); return; }
        const direction = actionName === PREVIOUS_SESSION_ACTION ? 'previous' : actionName === NEXT_SESSION_ACTION ? 'next' : null;
        if (direction && !switcherBand.step(direction)) {
            announceAccessibilityMessage(t(direction === 'next' ? 'phoneNav.switcher.noOlderSessions' : 'phoneNav.switcher.noNewerSessions'));
        }
    }, [switcherBand]);
    const { preferences } = useNavigationSurfacePlacement('sessionTabBar');
    // "Always swipe between sessions" depends on the sideways swipe itself.
    const alwaysSwipeSetting = useSetting('sessionCockpitSwipeAlwaysSessionsEnabled');
    const swipeSetting = useSetting('sessionCockpitSwipeNavigationEnabled');
    const alwaysSwipe = alwaysSwipeSetting === true && swipeSetting !== false;
    const windowWidth = useWindowDimensions().width;
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    const tabMinWidth = metrics.tabMinWidth;
    const slotCount = resolveFloatingTabBarSlotCount({ windowWidth, maxWidth: layout.maxWidth, tabMinWidth });
    const [moreOpen, setMoreOpen] = React.useState(false);
    const visibility = React.useMemo(() => resolveSessionCockpitMobileTabVisibility({
        catalog,
        preferences,
        slotCount,
        alwaysSwipe,
    }), [alwaysSwipe, preferences, catalog, slotCount]);
    // A scrolling bar owns the horizontal axis; the band's session swipe reads this and steps aside.
    const barScrolls = visibility.mode === 'scroll';
    React.useEffect(() => {
        publishCockpitBarScrolls(barScrolls);
        return () => publishCockpitBarScrolls(false);
    }, [barScrolls]);
    const tabs = visibility.visible.map(tabForEntry);
    // More lists every tool: what is on the bar first (pinned, including any that wait here while
    // "Always swipe" keeps the bar to what fits), then the rest. Every row can be pinned.
    const heldIds = new Set(visibility.held.map((entry) => entry.id));
    const menuEntries: readonly Readonly<{ entry: SessionCockpitMobileCatalogEntry; pinned: boolean }>[] = [
        ...visibility.visible.filter((entry) => entry.id !== 'chat').map((entry) => ({ entry, pinned: true })),
        ...visibility.held.map((entry) => ({ entry, pinned: true })),
        ...visibility.overflow.map((entry) => ({ entry, pinned: false })),
    ];
    const customize = () => {
        setMoreOpen(false);
        const previewTabs = catalog.map(tabForEntry).map(tab => tab.id === 'chat'
            ? { ...tab, icon: { render: ({ size, tintColor }: Readonly<{ size: number; tintColor: string }>) =>
                <AgentIcon agentId={hasBundledAgent ? agentId : null} size={size} color={tintColor} /> } }
            : tab);
        fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ NavigationPlacementCustomizer }) => {
            Modal.show({ component: NavigationPlacementCustomizer, props: {
                surfaceId: 'sessionTabBar',
                items: catalog.filter((entry) => entry.id !== 'chat').map((entry) => {
                    const tab = tabForEntry(entry);
                    return { id: entry.id, title: tab.label, icon: typeof tab.icon === 'string' ? tab.icon : 'puzzle-piece' as const, defaultPlacement: entry.defaultPlacement };
                }),
                testID: 'session-cockpit-customizer',
                renderPreview: (next: NavigationPlacementPreferences) => <SessionCockpitTabBarPreview
                    catalog={catalog} tabs={previewTabs} preferences={next} metrics={metrics}
                    activeSurface={props.activeSurface} slotCount={slotCount} alwaysSwipe={alwaysSwipe} />,
            } });
        }), { tag: 'SessionCockpitTabBar.customize' });
    };
    const menuItems: readonly DropdownMenuItem[] = [...menuEntries.map(({ entry, pinned }) => {
        const tab = tabForEntry(entry);
        const pinLabel = t(pinned ? 'phoneNav.bar.removeFromBar' : 'phoneNav.bar.keepOnBar');
        return {
            id: entry.id,
            testID: `session-cockpit-more-item:${entry.id}`,
            title: tab.label,
            category: t(pinned ? 'phoneNav.bar.onTheBar' : 'phoneNav.bar.more'),
            ...(heldIds.has(entry.id) ? { subtitle: t('phoneNav.bar.heldInMore') } : {}),
            icon: <Icon name={typeof tab.icon === 'string' ? tab.icon : 'puzzle-piece'} size={18} />,
            rightElement: (
                <>
                    {/* Collaboration says only news: a dot when someone mentioned you (the rail's dot). */}
                    {entry.id === 'collaboration' && collaborationTarget ? (
                        <SessionCollaborationRailBadge
                            target={collaborationTarget}
                            placement="inline"
                            testID="session-cockpit-more-fact:collaboration"
                        />
                    ) : null}
                    <NavigationPlacementPinButton surfaceId="sessionTabBar" testID={`session-cockpit-pin:${entry.id}`}
                        entryId={entry.id} pinned={pinned} label={pinLabel} preferences={preferences} />
                </>
            ),
        };
    }), { id: 'customize', title: t('navigationPlacement.customize'), icon: <Icon name="sliders-horizontal" size={18} />, testID: 'session-cockpit-more-customize' }];
    // A tool opened from More lives behind it: the More slot shows that tool, selected.
    const activeBehindMore = visibility.visible.some((entry) => entry.id === props.activeSurface)
        ? null
        : menuEntries.find(({ entry }) => entry.id === props.activeSurface)?.entry ?? null;
    const activeBehindMoreTab = activeBehindMore ? tabForEntry(activeBehindMore) : null;

    return (
        <CockpitTabBar
            activeSurface={props.activeSurface}
            barTestId={`session-cockpit-tabbar-${props.sessionId}`}
            tabs={tabs}
            tabTestIdPrefix="session-cockpit-tab-"
            layout={barScrolls ? 'scroll' : 'fit'}
            onSurfacePress={props.onSurfacePress}
            bandAccessibilityActions={bandAccessibilityActions}
            onBandAccessibilityAction={bandAccessibilityActions ? handleBandAccessibilityAction : undefined}
            trailing={<>
                <PendingNavigationPill address={pendingNavigationAddress} presentation="phone" />
                {menuItems.length > 0 ? (
                <DropdownMenu
                    open={moreOpen}
                    onOpenChange={setMoreOpen}
                    items={menuItems}
                    selectedId={activeBehindMore ? props.activeSurface : null}
                    showCategoryTitles
                    onSelect={(surface) => {
                        if (surface === 'customize') { customize(); return; }
                        setMoreOpen(false);
                        props.onSurfacePress(surface as SessionMobileSurface);
                    }}
                    matchTriggerWidth={false}
                    placement="top"
                    trigger={({ open, toggle }) => (
                        <CockpitTabBarAction
                            testID="session-cockpit-tab-more"
                            label={activeBehindMoreTab?.label ?? t('common.more')}
                            icon={activeBehindMoreTab && typeof activeBehindMoreTab.icon === 'string' ? activeBehindMoreTab.icon : 'dots-three'}
                            selected={activeBehindMoreTab !== null}
                            expanded={open}
                            onPress={toggle}
                        />
                    )}
                />
                ) : null}
            </>}
        />
    );
});
