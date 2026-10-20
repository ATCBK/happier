import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DesktopMainContentDragSurface } from '@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface';
import { AtmosphereLayer } from '@/components/atmosphere/AtmosphereLayer';
import { glassSurfacePlaneStyle } from '@/components/ui/glass/glassSurfacePaint';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';
import { appShellColumnSurface } from './appRail/appShellColumnSurface';
import { APP_RAIL_WIDTH_PX } from './appRail/appRailMetrics';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { SidebarCollapseIcon } from './SidebarIcons';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * The sheet that holds the column and the page lies on the window's canvas, inset from the window's
 * right and bottom edges with rounded corners, the rail and title strip around it (lab `xrail-R1`).
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
    bottomChrome: {
        position: 'absolute',
        left: APP_RAIL_WIDTH_PX,
        right: 0,
        bottom: 0,
        height: CONTENT_SHEET_WINDOW_INSET_PX,
        ...glassSurfacePlaneStyle(theme.colors.background.canvas, 'chrome'),
    },
    rightChrome: {
        position: 'absolute',
        top: 0,
        bottom: CONTENT_SHEET_WINDOW_INSET_PX,
        right: 0,
        width: CONTENT_SHEET_WINDOW_INSET_PX,
        ...glassSurfacePlaneStyle(theme.colors.background.canvas, 'chrome'),
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
        flexDirection: 'row',
        marginRight: CONTENT_SHEET_WINDOW_INSET_PX,
        marginBottom: CONTENT_SHEET_WINDOW_INSET_PX,
        borderRadius: CONTENT_SHEET_RADIUS_PX,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    /**
     * The seam shadow. An inert overlay tracing the content sheet's exact footprint — same left
     * corners, transparent fill — whose only job is to cast the sheet's lift shadow leftward onto
     * the sidebar.
     *
     * It stays separate from the clipped content sheet so the shadow reaches the sidebar.
     * Its rounded shape keeps the cast aligned with the sheet's corners.
     */
    contentSheetSeamShadow: {
        position: 'absolute',
        top: 0,
        bottom: CONTENT_SHEET_WINDOW_INSET_PX,
        right: CONTENT_SHEET_WINDOW_INSET_PX,
        borderRadius: CONTENT_SHEET_RADIUS_PX,
        zIndex: 2,
        boxShadow: theme.colors.shadowSeamCastBoxShadow,
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
    children: React.ReactNode;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
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
            {props.showChrome ? <>
                <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} pointerEvents="none" style={styles.bottomChrome} />
                <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} pointerEvents="none" style={styles.rightChrome} />
            </> : null}
            {props.rail ? <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} style={[styles.chromePlane, { width: APP_RAIL_WIDTH_PX, flexShrink: 0 }]}>
                {props.rail}
            </AppShellMaterialPlane> : null}
            <View key="sheet" style={[styles.content, props.showChrome && styles.contentSheet]}>
                {props.column ? <AppShellMaterialPlane key="column" testID="navigation-sidebar" group="sidebar" color={theme.colors.surface.inset}
                    translucentColor={theme.colors.surface.selected} style={[appShellColumnSurface.column, {
                        // Past either bound the edge gives a little (rubber band), a pure function of the drag.
                        width: Math.max(0, props.sidebarWidth + (props.columnResizeState?.overshootPx ?? 0) * COLUMN_RUBBER_BAND_RESISTANCE),
                    }, columnSpringBack]}>
                    <View style={[styles.columnContent, props.columnResizeState?.collapseArmed ? styles.columnArmed : null]}>
                        {props.column}
                    </View>
                    {props.columnResizeState?.collapseArmed ? <ColumnReleaseToHide /> : null}
                </AppShellMaterialPlane> : null}
                <AppShellMaterialPlane key="route-content" group="content" color={theme.colors.surface.base} translucentColor={theme.colors.surface.selected} style={[styles.content, styles.contentPlane]}>
                    {props.children}
                </AppShellMaterialPlane>
                {props.peek}
            </View>
            {Platform.OS === 'web' && props.showChrome ? <View pointerEvents="none"
                style={[styles.contentSheetSeamShadow, { left: APP_RAIL_WIDTH_PX }]} /> : null}
        </View>
    </DesktopMainContentDragSurface>;
}
