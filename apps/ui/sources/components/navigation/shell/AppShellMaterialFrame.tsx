import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DesktopMainContentDragSurface } from '@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface';
import { AtmosphereLayer } from '@/components/atmosphere/AtmosphereLayer';
import { glassSurfacePlaneStyle } from '@/components/ui/glass/glassSurfacePaint';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';
import { appShellColumnPlaneColor, appShellColumnSurface } from './appRail/appShellColumnSurface';
import { APP_RAIL_WIDTH_PX } from './appRail/appRailMetrics';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { SidebarCollapseIcon } from './SidebarIcons';
import { AppShellTailContext, type AppShellRightPanelPlacement, type AppShellTail } from './appShellTail';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * The page is the one lifted sheet: it lies on the window's canvas, inset from the window's right and
 * bottom edges with rounded corners. The rail, the title strip and the navigation column stand around
 * it on that canvas plane (labs `xrail-R1`, calm-shell `csedge.S1`).
 */
const CONTENT_SHEET_RADIUS_PX = 12;
const CONTENT_SHEET_WINDOW_INSET_PX = 8;

const stylesheet = StyleSheet.create((theme) => ({
    columnContent: { flex: 1, minHeight: 0, minWidth: 0 },
    // Armed to hide: the rows step back so the capsule's sentence leads (lab D2).
    columnArmed: { opacity: 0.38 },
    releaseLayer: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
    releaseCapsule: {
        flexDirection: 'row', alignItems: 'center', gap: theme.space.s6,
        paddingHorizontal: theme.space.s12, paddingVertical: theme.space.s6,
        borderRadius: 999, borderWidth: StyleSheet.hairlineWidth,
    },
    releaseLabel: { ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.primary },
    root: {
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        position: 'relative',
    },
    body: {
        flexDirection: 'row',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        position: 'relative',
    },
    chromePlane: {
        ...glassSurfacePlaneStyle(theme.colors.background.canvas, 'chrome'),
    },
    /**
     * The page's slot beside the column. It owns the sheet's place in the row, so the page and its
     * seam move together through ordinary layout when the column's drawn width changes.
     */
    pageSlot: {
        flex: 1,
        flexDirection: 'row',
        minWidth: 0,
        minHeight: 0,
    },
    sheetColumn: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
    },
    sheetColumnInset: {
        paddingBottom: CONTENT_SHEET_WINDOW_INSET_PX,
    },
    bottomChrome: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: CONTENT_SHEET_WINDOW_INSET_PX,
        ...glassSurfacePlaneStyle(theme.colors.background.canvas, 'chrome'),
    },
    /**
     * The trailing slot: the window's right inset, and with the `canvas` placement the page's docked
     * right panel and its rail before it, on the navigation plane like the left column.
     */
    tail: {
        flexDirection: 'row',
        flexShrink: 0,
        paddingRight: CONTENT_SHEET_WINDOW_INSET_PX,
        ...glassSurfacePlaneStyle(appShellColumnPlaneColor(theme.colors), 'sidebar'),
    },
    tailHost: {
        flexDirection: 'row',
        flexShrink: 0,
        alignSelf: 'stretch',
    },
    content: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
    contentPlane: {
        ...glassSurfacePlaneStyle(theme.colors.surface.base, 'content'),
    },
    contentSheet: {
        borderRadius: CONTENT_SHEET_RADIUS_PX,
        overflow: 'hidden',
    },
    /**
     * The seam shadow. An inert overlay tracing the page sheet's exact footprint (same corners,
     * transparent fill) whose only job is to cast the sheet's lift onto the navigation plane beside it.
     * It is the sheet's sibling, not its child, so the clip never cuts the cast; it lives in the page's
     * slot, so it follows the page edge wherever the column's drawn width puts it.
     */
    contentSheetSeamShadow: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: CONTENT_SHEET_WINDOW_INSET_PX,
        borderRadius: CONTENT_SHEET_RADIUS_PX,
        zIndex: 2,
        boxShadow: theme.colors.shadowSeamCastBoxShadow,
    },
    /** With the right panel on the canvas, the page casts on both of its edges. */
    contentSheetSeamShadowBoth: {
        boxShadow: theme.colors.shadowSeamCastBothBoxShadow,
    },
    /** The peek floats over the column's place (or the page's leading edge), right after the rail. */
    peekLayer: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
        zIndex: 3,
    },
}));

/** Structural coats share the surface owner; Wallpaper filters paint beside their content. */
export function AppShellMaterialPlane(props: Readonly<{
    group: GlassSurfaceGroup;
    color: string;
    translucentColor: string;
    style: StyleProp<ViewStyle>;
    testID?: string;
    pointerEvents?: 'none';
    nested?: boolean;
    children?: React.ReactNode;
}>) {
    if (props.pointerEvents === 'none') return <View pointerEvents="none" style={[props.style, { backgroundColor: 'transparent' }]}>
        <GlassSurface plane surfaceGroup={props.group} solidColor={props.color} translucentColor={props.translucentColor} finishRole={null} nested={props.nested} style={StyleSheet.absoluteFillObject}>
            {props.children}
        </GlassSurface>
    </View>;
    return <GlassSurface plane testID={props.testID} surfaceGroup={props.group} solidColor={props.color} translucentColor={props.translucentColor} finishRole={null} nested={props.nested} style={props.style}>
        {props.children}
    </GlassSurface>;
}


/** How much the column edge follows the pointer past its bounds while dragging (lab ade-shell D2). */
const COLUMN_RUBBER_BAND_RESISTANCE = 0.55;

/** The column's drawn width while a drag gives past a bound: a pure function of the core's overshoot. */
export function resolveColumnDrawnWidthPx(widthPx: number, overshootPx: number): number {
    return Math.max(0, widthPx + overshootPx * COLUMN_RUBBER_BAND_RESISTANCE);
}

/**
 * The armed collapse's hint (lab ade-shell D2): while the drag has passed half the column's minimum,
 * the rows fade and this capsule says what releasing does; moving back disarms it.
 */
function ColumnReleaseToHide() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <View pointerEvents="none" style={styles.releaseLayer} accessibilityLiveRegion="polite">
            <View style={[styles.releaseCapsule, { backgroundColor: theme.colors.surface.base, borderColor: theme.colors.border.strong }]}>
                <SidebarCollapseIcon size={16} color={theme.colors.text.primary} />
                <Text numberOfLines={1} style={styles.releaseLabel}>{t('panes.mainColumn.sidebarReleaseToHide')}</Text>
            </View>
        </View>
    );
}

/** Paint and geometry for the real shell, independent of navigation/settings subscriptions. */
export function AppShellMaterialFrame(props: Readonly<{
    showChrome: boolean;
    dragEnabled: boolean;
    leftOffsetPx: number;
    sidebarWidth: number;
    /** Resize feedback supplied by the shared core; the sidebar presentation owns its paint. */
    columnResizeState?: Readonly<{ collapseArmed: boolean; overshootPx: number; dragging: boolean }>;
    titleStrip: React.ReactNode;
    rail: React.ReactNode;
    column: React.ReactNode;
    peek: React.ReactNode;
    /** The person's right panel position; the frame resolves it for this window (`sheet` without chrome or off the web). */
    rightPanelPlacement?: AppShellRightPanelPlacement;
    children: React.ReactNode;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    // The seam lift and the tail hosts are web only, and a phone has no side panel: those keep the sheet.
    const placement: AppShellRightPanelPlacement = props.showChrome && Platform.OS === 'web' ? props.rightPanelPlacement ?? 'sheet' : 'sheet';
    const [rightHost, setRightHost] = React.useState<HTMLElement | null>(null);
    const [railHost, setRailHost] = React.useState<HTMLElement | null>(null);
    // On the web a View's ref is its element: the tail hosts a page's panel and rail portal into.
    const attachRightHost = React.useCallback((node: unknown) => setRightHost(node as HTMLElement | null), []);
    const attachRailHost = React.useCallback((node: unknown) => setRailHost(node as HTMLElement | null), []);
    const [pageSlotWidthPx, setPageSlotWidthPx] = React.useState<number | null>(null);
    const containerWidthPx = pageSlotWidthPx === null ? null : Math.max(0, pageSlotWidthPx - CONTENT_SHEET_WINDOW_INSET_PX);
    const tail = React.useMemo<AppShellTail>(() => ({
        placement,
        rightHost: placement === 'canvas' ? rightHost : null,
        railHost: placement === 'canvas' ? railHost : null,
        containerWidthPx: placement === 'canvas' ? containerWidthPx : null,
    }), [containerWidthPx, placement, railHost, rightHost]);
    const reducedMotion = useReducedMotionPreference();
    // Released past a bound, the edge springs back to the width it kept instead of snapping; while the
    // pointer holds it, it follows 1:1. Reduced motion: it is placed at once.
    const columnSpringBack = Platform.OS === 'web' && !reducedMotion && props.columnResizeState?.dragging !== true ? {
        transitionProperty: 'width',
        transitionDuration: `${motionTokens.spring.travel.durationMs}ms`,
        transitionTimingFunction: motionTokens.easingCss.standard,
    // react-native-web transition style keys; React Native's ViewStyle does not declare them.
    } as unknown as ViewStyle : null;
    return <DesktopMainContentDragSurface enabled={props.dragEnabled} leftOffsetPx={props.leftOffsetPx}
        style={styles.root}>
        {/* The atmosphere's picture lies under every plane; route changes only change the content coat. */}
        <AtmosphereLayer sheetRadius={CONTENT_SHEET_RADIUS_PX} chrome={props.showChrome} />
        {props.titleStrip ? <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} style={styles.chromePlane}>
            <RetainedPanelSurface isActive={props.showChrome}>
                {props.titleStrip}
            </RetainedPanelSurface>
        </AppShellMaterialPlane> : null}
        <View key="shell-body" style={styles.body}>
            {props.rail ? <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} style={[styles.chromePlane, { width: APP_RAIL_WIDTH_PX, flexShrink: 0 }]}>
                {props.rail}
            </AppShellMaterialPlane> : null}
            {props.column ? <AppShellMaterialPlane key="column" testID="navigation-sidebar" group="sidebar" color={appShellColumnPlaneColor(theme.colors)}
                translucentColor={theme.colors.surface.selected} style={[appShellColumnSurface.column, {
                    // Past either bound the edge gives a little (rubber band), a pure function of the drag.
                    width: resolveColumnDrawnWidthPx(props.sidebarWidth, props.columnResizeState?.overshootPx ?? 0),
                }, columnSpringBack]}>
                <View style={[styles.columnContent, props.columnResizeState?.collapseArmed ? styles.columnArmed : null]}>
                    {props.column}
                </View>
                {props.columnResizeState?.collapseArmed ? <ColumnReleaseToHide /> : null}
            </AppShellMaterialPlane> : null}
            <View key="page-slot" style={styles.pageSlot} onLayout={(event) => {
                const next = Math.round(event.nativeEvent.layout.width);
                setPageSlotWidthPx((previous) => (previous === next ? previous : next));
            }}>
                <View key="sheet-column" style={[styles.sheetColumn, props.showChrome && styles.sheetColumnInset]}>
                    {props.showChrome ? <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} pointerEvents="none" style={styles.bottomChrome} /> : null}
                    <View key="sheet" style={[styles.content, props.showChrome && styles.contentSheet]}>
                        <AppShellMaterialPlane key="route-content" group="content" color={theme.colors.surface.base} translucentColor={theme.colors.surface.selected} style={[styles.content, styles.contentPlane]}>
                            <AppShellTailContext.Provider value={tail}>
                                {props.children}
                            </AppShellTailContext.Provider>
                        </AppShellMaterialPlane>
                    </View>
                    {Platform.OS === 'web' && props.showChrome ? <View pointerEvents="none"
                        style={[styles.contentSheetSeamShadow, placement === 'canvas' && styles.contentSheetSeamShadowBoth]} /> : null}
                </View>
                {props.showChrome ? <AppShellMaterialPlane key="tail" testID="app-shell-tail" group="sidebar" color={appShellColumnPlaneColor(theme.colors)}
                    translucentColor={theme.colors.surface.selected} style={styles.tail}>
                    <View ref={attachRightHost} testID="app-shell-tail-right" style={styles.tailHost} />
                    <View ref={attachRailHost} testID="app-shell-tail-rail" style={styles.tailHost} />
                </AppShellMaterialPlane> : null}
            </View>
            {props.peek ? <View pointerEvents="box-none" style={[styles.peekLayer, { left: props.rail ? APP_RAIL_WIDTH_PX : 0 }]}>
                {props.peek}
            </View> : null}
        </View>
    </DesktopMainContentDragSurface>;
}
