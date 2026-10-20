import * as React from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ResolvedPaneLayout } from './paneBreakpoints';
import { ResizableDockedPane } from './ResizableDockedPane';
import { PaneAnimatedScrimPressable } from './motion/PaneAnimatedScrimPressable';
import {
    ModalPaneBoundaryView,
    useModalPaneBoundary,
    useModalPanePresentation,
} from './ModalPaneBoundary';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { FocusReturnMutableRef } from '@/keyboard/focusReturn';
import { ESCAPE_LAYER_PRIORITIES } from '@/keyboard/escape';
import { t } from '@/text';
import { shadowLevelStyle } from '@/shadowElevation';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { RetainedPanelSurface } from './RetainedPanelSurface';
import { DEFAULT_DETAILS_MIN_PX, DEFAULT_RIGHT_MIN_PX, DEFAULT_SESSION_MIN_PX, DEFAULT_SESSION_WIDTH_PX } from './paneBreakpoints';
import { usePaneRegionFocusBoundary } from '@/components/appShell/panes/paneRegion';

// A pane floating over the main content (overlay presentation) rounds the one edge that shows.
const PANE_OVERLAY_CORNER_RADIUS_PX = 16;
// The pre-boundary Escape owner closes Details before Right when both docked
// columns are present. Keep that user-visible precedence inside the one pane
// layer rather than relying on hook registration order.
const DOCKED_DETAILS_ESCAPE_PRIORITY = ESCAPE_LAYER_PRIORITIES.pane + 1;
const NOOP = () => {};

export type MultiPaneHostProps = Readonly<{
    main: React.ReactNode;
    hideMain?: boolean;
    mirrored?: boolean;
    detailsClosable?: boolean;
    mainDrawerOpen?: boolean;
    mainAccessibilityLabel?: string;
    mainOverlayFocusReturnRef?: FocusReturnMutableRef;
    mainDockWidthPx?: number;
    mainDockMaxWidthPx?: number;
    onCloseMain?: () => void;
    onCommitMainDockWidthPx?: (widthPx: number) => void;
    onDragMainDockWidthPx?: React.ComponentProps<typeof ResizableDockedPane>['onDragWidthPx'];
    onResetMainDockWidthPx?: () => void;
    onResetRightDockWidthPx?: () => void;
    onResetDetailsDockWidthPx?: () => void;
    rightPane: React.ReactNode | null;
    detailsPane: React.ReactNode | null;
    layout: ResolvedPaneLayout;
    rightDockWidthPx: number;
    detailsDockWidthPx: number;
    rightDockMinWidthPx?: number;
    rightDockMaxWidthPx?: number;
    detailsDockMinWidthPx?: number;
    detailsDockMaxWidthPx?: number;
    onCloseRight: () => void;
    onCloseDetails: () => void;
    onCommitRightDockWidthPx: (widthPx: number) => void;
    onCommitDetailsDockWidthPx: (widthPx: number) => void;
    onDragRightDockWidthPx?: React.ComponentProps<typeof ResizableDockedPane>['onDragWidthPx'];
    onDragDetailsDockWidthPx?: React.ComponentProps<typeof ResizableDockedPane>['onDragWidthPx'];
    rightOverlayFocusReturnRef?: FocusReturnMutableRef;
    detailsOverlayFocusReturnRef?: FocusReturnMutableRef;
    /**
     * `soft` when Details is a drawer opened from the side column's list: the list beside it stays
     * the context, so main is only quieted, not shaded (details lab 2, Q1).
     */
    detailsScrim?: 'standard' | 'soft';
}>;

export const MultiPaneHost = React.memo((props: MultiPaneHostProps) => {
    const {
        main,
        hideMain,
        rightPane,
        detailsPane,
        layout,
        rightDockWidthPx,
        detailsDockWidthPx,
        onCloseRight,
        onCloseDetails,
    } = props;

    const { theme } = useUnistyles();
    const overlayZIndexBase = 50;
    const mirrored = props.mirrored === true;
    const mainModalActive = layout.main === 'overlay' && props.mainDrawerOpen === true && hideMain !== true;
    const mainLabel = props.mainAccessibilityLabel ?? t('ui.modalPane.right');
    const mainPresence = useModalPanePresentation({ targetOpen: mainModalActive, node: main, overlay: true,
        onClose: props.onCloseMain ?? NOOP });
    const mainModalBoundary = useModalPaneBoundary({ active: mainModalActive, label: mainLabel,
        focusReturnRef: props.mainOverlayFocusReturnRef,
        discardPendingFocusReturn: hideMain !== true && layout.main !== 'overlay',
        onRequestClose: mainPresence.requestClose, escapeEnabled: mainModalActive,
        escapePriority: ESCAPE_LAYER_PRIORITIES.overlay + 1, allowEditableEscape: mainModalActive });

    // Pane *presence* is the logical open signal. Layout controls whether it's docked/overlay/hidden.
    // This lets us keep a pane mounted (state preserved) even when the layout temporarily hides it
    // (e.g. overlayStack where details overlays and right is hidden).
    const detailsPresence = useModalPanePresentation({
        targetOpen: Boolean(detailsPane),
        node: detailsPane,
        overlay: layout.details === 'overlay',
        onClose: onCloseDetails,
    });
    const rightPresence = useModalPanePresentation({
        targetOpen: Boolean(rightPane),
        node: rightPane,
        overlay: layout.right === 'overlay',
        onClose: onCloseRight,
    });
    const rightModalActive = layout.right === 'overlay' && rightPresence.present && !mainModalActive;
    const detailsModalActive = layout.details === 'overlay' && detailsPresence.present && !rightModalActive && !mainModalActive;
    const rightModalLabel = t('ui.modalPane.right');
    const detailsModalLabel = t('ui.modalPane.details');
    const detailsModalBoundary = useModalPaneBoundary({
        active: detailsModalActive,
        label: detailsModalLabel,
        onRequestClose: detailsPresence.requestClose,
        focusReturnRef: props.detailsOverlayFocusReturnRef,
        discardPendingFocusReturn: Boolean(detailsPane) && layout.details !== 'overlay',
        escapeEnabled: props.detailsClosable !== false && (detailsModalActive || (layout.details === 'docked' && detailsPresence.present)),
        escapePriority: detailsModalActive
            ? ESCAPE_LAYER_PRIORITIES.overlay
            : DOCKED_DETAILS_ESCAPE_PRIORITY,
        allowEditableEscape: detailsModalActive,
    });
    const rightModalBoundary = useModalPaneBoundary({
        active: rightModalActive,
        label: rightModalLabel,
        onRequestClose: rightPresence.requestClose,
        focusReturnRef: props.rightOverlayFocusReturnRef,
        discardPendingFocusReturn: Boolean(rightPane) && layout.right !== 'overlay',
        escapeEnabled: rightModalActive || (layout.right === 'docked' && rightPresence.present),
        escapePriority: rightModalActive
            ? ESCAPE_LAYER_PRIORITIES.overlay
            : ESCAPE_LAYER_PRIORITIES.pane,
        allowEditableEscape: rightModalActive,
    });
    const {
        nativeAccessibilityFocusAnchor: detailsNativeAccessibilityFocusAnchor,
        nativeBackLayer: detailsNativeBackLayer,
        ...detailsModalOverlayProps
    } = detailsModalBoundary.overlayProps;
    const {
        nativeAccessibilityFocusAnchor: rightNativeAccessibilityFocusAnchor,
        nativeBackLayer: rightNativeBackLayer,
        ...rightModalOverlayProps
    } = rightModalBoundary.overlayProps;
    const activeMainBoundary = rightModalActive
        ? rightModalBoundary
        : detailsModalActive
            ? detailsModalBoundary
            : null;
    const setMainUnderlayFocusRef = React.useCallback<React.RefCallback<HTMLElement>>((node) => {
        detailsModalBoundary.setUnderlayFocusRef(node);
        rightModalBoundary.setUnderlayFocusRef(node);
    }, [detailsModalBoundary, rightModalBoundary]);
    // The pane host already owns these visible/covered facts. Feed them into
    // the private focus boundary instead of asking plugin surfaces to infer
    // their own presentation state.
    const mainFocusEligible = activeMainBoundary === null;
    const mainRegionFocus = usePaneRegionFocusBoundary('main', mainFocusEligible && hideMain !== true && (layout.main !== 'overlay' || mainModalActive));
    const detailsOverlayFocusEligible = detailsModalActive && !detailsPresence.closing;
    const rightOverlayFocusEligible = rightModalActive && !rightPresence.closing;

    const detailsDocked = layout.details === 'docked' && detailsPresence.present;
    const rightDocked = layout.right === 'docked' && rightPresence.present;
    const shouldHideDockedMainRegion = hideMain === true;
    const mainWidthPx = props.mainDockWidthPx ?? DEFAULT_SESSION_WIDTH_PX;
    const mainFocusRef = React.useCallback((node: unknown) => {
        mainRegionFocus.ref(node);
        if (mainModalActive) mainModalBoundary.setOverlayFocusRef(node as HTMLElement | null);
    }, [mainModalActive, mainModalBoundary.setOverlayFocusRef, mainRegionFocus.ref]);

    return (
        <View style={{ flex: 1, flexDirection: mirrored ? 'row-reverse' : 'row', position: 'relative' }}>
                <View key="main" ref={mainFocusRef} testID="multi-pane-main-column" onFocusCapture={mainRegionFocus.onFocusCapture}
                    onFocus={mainRegionFocus.onFocus} role={Platform.OS === 'web' ? 'region' : undefined}
                    accessibilityLabel={mainLabel}
                    style={shouldHideDockedMainRegion ? { position: 'absolute', width: 0, height: '100%', overflow: 'hidden', opacity: 0, zIndex: -1 }
                        : layout.main === 'overlay' ? { position: 'absolute', top: 0, right: 0, bottom: 0, width: mainWidthPx, zIndex: overlayZIndexBase + 5, backgroundColor: theme.colors.surface.base }
                            : { flex: mirrored ? undefined : 1, width: mirrored ? mainWidthPx : undefined, minWidth: 0, minHeight: 0, position: 'relative' }}>
                    <RetainedPanelSurface isActive={!shouldHideDockedMainRegion} mode="flow" testID="multi-pane-main-retained">
                    <ResizableDockedPane widthPx={mainWidthPx}
                        minWidthPx={mirrored && layout.main !== 'overlay' ? DEFAULT_SESSION_MIN_PX : mainWidthPx}
                        maxWidthPx={mirrored && layout.main !== 'overlay' ? props.mainDockMaxWidthPx ?? mainWidthPx : mainWidthPx}
                        resizeEdge="left" onCommitWidthPx={props.onCommitMainDockWidthPx ?? NOOP}
                        onDragWidthPx={props.onDragMainDockWidthPx} onResetRequest={props.onResetMainDockWidthPx}>
                    <ModalPaneBoundaryView
                        ref={setMainUnderlayFocusRef}
                        testID="multi-pane-main-underlay"
                        style={{ flex: 1, minWidth: 0, minHeight: 0 }}
                        {...(mainModalActive ? mainModalBoundary.overlayProps : activeMainBoundary?.underlayProps ?? {})}
                    >
                        <PluginSurfaceFocusEligibilityProvider active={mainFocusEligible}>
                            {main}
                        </PluginSurfaceFocusEligibilityProvider>
                    </ModalPaneBoundaryView>
                    {!mirrored && detailsModalActive ? (
                        <PaneAnimatedScrimPressable
                            testID="multi-pane-details-scrim"
                            accessibilityRole="button"
                            accessibilityLabel={t('ui.modalPane.dismiss', { pane: detailsModalLabel })}
                            onPress={detailsPresence.requestClose}
                            animatedStyle={{
                                position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
                                zIndex: overlayZIndexBase,
                                backgroundColor: props.detailsScrim === 'soft'
                                    ? (theme.dark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.07)')
                                    : (theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)'),
                                opacity: detailsPresence.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                            }}
                        />
                    ) : null}
                    {!mirrored && rightModalActive ? (
                        <PaneAnimatedScrimPressable
                            testID="multi-pane-right-scrim"
                            accessibilityRole="button"
                            accessibilityLabel={t('ui.modalPane.dismiss', { pane: rightModalLabel })}
                            onPress={rightPresence.requestClose}
                            animatedStyle={{
                                position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
                                zIndex: overlayZIndexBase + 2,
                                backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
                                opacity: rightPresence.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                            }}
                        />
                    ) : null}
                    </ResizableDockedPane>
                    </RetainedPanelSurface>
                </View>
            {detailsPresence.present ? (
                <PaneColumn
                    key="details"
                    name="details"
                    mirrored={mirrored}
                    flexible={mirrored}
                    presentation={layout.details}
                    modalActive={detailsModalActive}
                    progress={detailsPresence.progress}
                    widthPx={detailsDockWidthPx}
                    minWidthPx={props.detailsDockMinWidthPx ?? DEFAULT_DETAILS_MIN_PX}
                    maxWidthPx={props.detailsDockMaxWidthPx ?? Number.POSITIVE_INFINITY}
                    onCommitWidthPx={props.onCommitDetailsDockWidthPx}
                    onDragWidthPx={props.onDragDetailsDockWidthPx}
                    onResetWidthPx={props.onResetDetailsDockWidthPx}
                    overlayRightInsetPx={rightDocked ? rightDockWidthPx : 0}
                    overlayZIndex={overlayZIndexBase + 1}
                    overlayFocusRef={detailsModalBoundary.setOverlayFocusRef}
                    overlayProps={detailsModalOverlayProps}
                    underlayProps={mainModalActive ? mainModalBoundary.underlayProps : rightModalActive ? rightModalBoundary.underlayProps : undefined}
                    underlayFocusRef={mirrored ? mainModalBoundary.setUnderlayFocusRef : undefined}
                    nativeAccessibilityFocusAnchor={detailsNativeAccessibilityFocusAnchor}
                    nativeBackLayer={detailsNativeBackLayer}
                    focusEligible={layout.details === 'docked' ? !rightModalActive && !mainModalActive : detailsOverlayFocusEligible}
                >
                    {detailsPresence.node}
                    {mirrored && (mainModalActive || rightModalActive) ? <PaneAnimatedScrimPressable
                        testID={mainModalActive ? 'multi-pane-main-scrim' : 'multi-pane-right-scrim'}
                        accessibilityRole="button" accessibilityLabel={t('ui.modalPane.dismiss', { pane: mainModalActive ? mainLabel : rightModalLabel })}
                        onPress={mainModalActive ? mainPresence.requestClose : rightPresence.requestClose}
                        animatedStyle={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: overlayZIndexBase + 4,
                            backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)' }} /> : null}
                </PaneColumn>
            ) : null}
            {rightPresence.present ? (
                <PaneColumn
                    key="right"
                    name="right"
                    mirrored={mirrored}
                    presentation={layout.right}
                    modalActive={rightModalActive}
                    progress={rightPresence.progress}
                    widthPx={rightDockWidthPx}
                    minWidthPx={props.rightDockMinWidthPx ?? DEFAULT_RIGHT_MIN_PX}
                    maxWidthPx={props.rightDockMaxWidthPx ?? Number.POSITIVE_INFINITY}
                    onCommitWidthPx={props.onCommitRightDockWidthPx}
                    onDragWidthPx={props.onDragRightDockWidthPx}
                    onResetWidthPx={props.onResetRightDockWidthPx}
                    overlayRightInsetPx={!mirrored && detailsDocked ? detailsDockWidthPx : 0}
                    overlayZIndex={overlayZIndexBase + 3}
                    overlayFocusRef={rightModalBoundary.setOverlayFocusRef}
                    overlayProps={rightModalOverlayProps}
                    underlayProps={mainModalActive ? mainModalBoundary.underlayProps : detailsModalActive ? detailsModalBoundary.underlayProps : undefined}
                    nativeAccessibilityFocusAnchor={rightNativeAccessibilityFocusAnchor}
                    nativeBackLayer={rightNativeBackLayer}
                    focusEligible={layout.right === 'docked' ? !detailsModalActive && !mainModalActive : rightOverlayFocusEligible}
                >
                    {rightPresence.node}
                </PaneColumn>
            ) : null}
        </View>
    );
});

/**
 * One mounted column per pane. Docking, overlaying and parking change its layout and modal
 * attributes, never its parents: a pane's editor draft, focus and scroll belong to this instance.
 */
function PaneColumn(props: Readonly<{
    name: 'right' | 'details';
    mirrored?: boolean;
    flexible?: boolean;
    presentation: ResolvedPaneLayout['details'];
    modalActive: boolean;
    progress: Animated.Value;
    widthPx: number;
    minWidthPx: number;
    maxWidthPx: number;
    onCommitWidthPx: (widthPx: number) => void;
    onDragWidthPx?: (widthPx: number | null) => void;
    onResetWidthPx?: () => void;
    overlayRightInsetPx: number;
    overlayZIndex: number;
    overlayFocusRef: ReturnType<typeof useModalPaneBoundary>['setOverlayFocusRef'];
    overlayProps: Omit<ReturnType<typeof useModalPaneBoundary>['overlayProps'], 'nativeAccessibilityFocusAnchor' | 'nativeBackLayer'>;
    underlayProps?: Readonly<Record<string, unknown>>;
    underlayFocusRef?: ReturnType<typeof useModalPaneBoundary>['setUnderlayFocusRef'];
    nativeAccessibilityFocusAnchor: ReturnType<typeof useModalPaneBoundary>['overlayProps']['nativeAccessibilityFocusAnchor'];
    nativeBackLayer: ReturnType<typeof useModalPaneBoundary>['overlayProps']['nativeBackLayer'];
    focusEligible: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const docked = props.presentation === 'docked';
    const overlay = props.presentation === 'overlay';
    const hidden = props.presentation === 'hidden';
    const regionFocus = usePaneRegionFocusBoundary(props.name, !hidden && props.focusEligible);
    const setFocusRef = React.useCallback((node: unknown) => {
        regionFocus.ref(node);
        props.underlayFocusRef?.(node as HTMLElement | null);
        if (props.modalActive) props.overlayFocusRef(node as HTMLElement | null);
    }, [props.modalActive, props.overlayFocusRef, props.underlayFocusRef, regionFocus.ref]);
    const boundaryProps = props.modalActive ? props.overlayProps : (props.underlayProps ?? {});
    return (
        <Animated.View
            style={docked ? {
                position: 'relative',
                flex: props.flexible ? 1 : undefined,
                minWidth: 0,
                width: props.progress.interpolate({ inputRange: [0, 1], outputRange: [0, props.widthPx] }),
                overflow: 'hidden',
                flexShrink: 0,
                alignSelf: 'stretch',
                height: '100%',
                opacity: props.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                transform: [{ translateX: props.progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
            } : {
                position: 'absolute',
                top: 0,
                ...(props.mirrored ? { left: props.overlayRightInsetPx } : { right: props.overlayRightInsetPx }),
                bottom: 0,
                zIndex: overlay ? props.overlayZIndex : -1,
                backgroundColor: 'transparent',
                opacity: overlay ? props.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) : 0,
                ...(overlay ? {
                    ...(props.mirrored ? { borderTopRightRadius: PANE_OVERLAY_CORNER_RADIUS_PX, borderBottomRightRadius: PANE_OVERLAY_CORNER_RADIUS_PX }
                        : { borderTopLeftRadius: PANE_OVERLAY_CORNER_RADIUS_PX, borderBottomLeftRadius: PANE_OVERLAY_CORNER_RADIUS_PX }),
                    overflow: 'hidden',
                    ...shadowLevelStyle(theme.colors.shadowLevels[6]),
                } : {}),
                transform: [{ translateX: overlay
                    ? props.progress.interpolate({ inputRange: [0, 1], outputRange: [props.mirrored ? -props.widthPx : props.widthPx, 0] })
                    : props.mirrored ? -props.widthPx : props.widthPx }],
            }}
        >
            <ModalPaneBoundaryView
                ref={setFocusRef}
                onFocusCapture={regionFocus.onFocusCapture}
                onFocus={regionFocus.onFocus}
                role={Platform.OS === 'web' ? 'region' : undefined}
                accessibilityLabel={props.name === 'right' ? t('ui.modalPane.right') : t('ui.modalPane.details')}
                testID={hidden ? `multi-pane-${props.name}-parked`
                    : props.modalActive ? `multi-pane-${props.name}-modal` : undefined}
                {...boundaryProps}
                suppressDescendantPaneBoundaries={hidden || (!props.modalActive && props.underlayProps?.suppressDescendantPaneBoundaries === true)}
                {...(hidden ? {
                    pointerEvents: 'none' as const,
                    ...(Platform.OS === 'web'
                        ? { inert: true, 'aria-hidden': true as const }
                        : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const }),
                } : {})}
                style={{ flex: 1, minHeight: 0, minWidth: 0, zIndex: overlay ? props.overlayZIndex : undefined }}
            >
                <ResizableDockedPane
                    testID={`multi-pane-${props.name}-${docked ? 'docked' : 'overlay'}`}
                    widthPx={props.widthPx}
                    minWidthPx={props.minWidthPx}
                    maxWidthPx={props.maxWidthPx}
                    onCommitWidthPx={props.onCommitWidthPx}
                    onDragWidthPx={props.onDragWidthPx}
                    onResetRequest={props.onResetWidthPx}
                    resizeEdge={props.mirrored ? 'right' : 'left'}
                >
                    <ModalPaneBoundaryView
                        nativeAccessibilityFocusAnchor={props.nativeAccessibilityFocusAnchor}
                        nativeBackLayer={props.nativeBackLayer}
                        style={{ flex: 1, minHeight: 0, minWidth: 0 }}
                    >
                        <GlassSurface surfaceGroup="content" solidColor={theme.colors.surface.base} finishRole={null} nested={docked} style={{
                            flex: 1, minHeight: 0, minWidth: 0,
                            borderLeftWidth: docked && !props.mirrored ? StyleSheet.hairlineWidth : 0,
                            borderRightWidth: docked && props.mirrored ? StyleSheet.hairlineWidth : 0,
                            borderLeftColor: theme.colors.border.subtle, borderRightColor: theme.colors.border.subtle,
                            overflow: 'hidden',
                        }}>
                            <PluginSurfaceFocusEligibilityProvider active={props.focusEligible}>
                                {props.children}
                            </PluginSurfaceFocusEligibilityProvider>
                        </GlassSurface>
                    </ModalPaneBoundaryView>
                </ResizableDockedPane>
            </ModalPaneBoundaryView>
        </Animated.View>
    );
}
