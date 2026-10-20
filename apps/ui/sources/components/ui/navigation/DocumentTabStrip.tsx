import * as React from 'react';
import { I18nManager, Image, Platform, Pressable, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { PinIcon } from '@/components/sessions/shell/sessionPinIcons';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, happierFocusRingStyle, isHappierFocusVisible, resolveHappierTabKeySelection, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { shadowLevelStyle } from '@/shadowElevation';
import type { EntityDragItemV1, EntityDragKindV1, EntityDragScopeV1, EntityDropAdmissionV1, EntityDropEffectV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { measureWindowBounds, readWindowBounds, useEntityDragSource, useEntityDropTarget, useEntityDropTargetState, type EntityDragDropRuntime, type EntityDragInput, type WindowBounds } from '@/components/ui/treeDragDrop';
import { isSecondaryEntityRowControl, useEntityDragDomBinding, useEntityDropDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { TreeDropIndicatorLine } from '@/components/ui/treeDragDrop/ui/TreeDropIndicatorLine';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { createEntityDragGestureAdapter, ENTITY_DRAG_ACTIVATION_DISTANCE_PX } from '@/components/ui/treeDragDrop/entityDragGestureAdapter';
import { resolveTreeDropAutoscrollTarget } from '@/components/ui/treeDragDrop/autoscroll/useTreeDropAutoscroll';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';

export type DocumentTabEntityDragSource = Readonly<{
    runtime: EntityDragDropRuntime;
    id: string;
    scope: EntityDragScopeV1;
    getItem: (tabKey: string) => EntityDragItemV1 | null;
    isCurrent?: () => boolean;
    /** Phone rails keep horizontal scrolling while a vertical pan carries the shown entity. */
    nativeDragAxis?: 'vertical';
}>;
export type DocumentTabEntityDragDrop = DocumentTabEntityDragSource & Readonly<{
    acceptedKinds: readonly EntityDragKindV1[];
    resolve: (input: Readonly<{ item: EntityDragItemV1; beforeTabId: string | null; input: EntityDragInput }>) => EntityDropAdmissionV1;
    execute: (effect: EntityDropEffectV1) => Promise<EntityDropOutcomeV1>;
}>;

type ScrollPropagationEvent = Readonly<{ stopPropagation?: () => void }>;
type DocumentTabWebPressableProps = React.ComponentPropsWithRef<typeof Pressable> & Readonly<{
    onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
    onAuxClick?: React.MouseEventHandler<HTMLElement>;
}>;

const DocumentTabWebPressable = Pressable as unknown as React.ComponentType<DocumentTabWebPressableProps>;

export type DocumentTabStripTestIds = Readonly<{
    tab?: (tabKey: string) => string | null | undefined;
    tabPin?: (tabKey: string) => string | null | undefined;
    tabUnpin?: (tabKey: string) => string | null | undefined;
    tabClose?: (tabKey: string) => string | null | undefined;
    tabFavicon?: (tabKey: string) => string | null | undefined;
    tabSpinner?: (tabKey: string) => string | null | undefined;
    tabUnsaved?: (tabKey: string) => string | null | undefined;
    tabStatus?: (tabKey: string) => string | null | undefined;
}>;

/**
 * Generic, kind-agnostic per-tab leading-glyph presentation. A consumer surface (e.g. the browser
 * `browser-view` tab) supplies a live favicon URL and/or loading flag per tab; the canonical strip
 * renders a spinner while loading, then the favicon, falling back to the per-kind icon. This is the
 * single home for tab leading chrome — the browser no longer ships a bespoke tab strip.
 */
export type DocumentTabPresentation = Readonly<{
    faviconUrl?: string | null;
    isLoading?: boolean;
    /**
     * Live status in the tab chrome. Close takes the bar/rail slot on the active tab and on hover;
     * pinned marks keep a small status overlay. The label is read with the tab's name.
     */
    status?: DocumentTabStatus | null;
}>;

/**
 * The dot a tab status draws: live tones (running, needs you) carry a soft halo, settled ones do not
 * (terminal lab B1). Lists that show the same statuses use this too, so a tab and its row agree.
 */
export function resolveDocumentTabStatusDot(
    theme: Readonly<{ colors: Readonly<{ state: Readonly<{ success: Readonly<{ foreground: string; background: string }>; warning: Readonly<{ foreground: string; background: string }> }>; status: Readonly<{ error: string }>; text: Readonly<{ tertiary: string }> }> }>,
    tone: DocumentTabStatus['tone'],
): Readonly<{ color: string; halo?: string }> {
    switch (tone) {
        case 'running': return { color: theme.colors.state.success.foreground, halo: theme.colors.state.success.background };
        case 'attention': return { color: theme.colors.state.warning.foreground, halo: theme.colors.state.warning.background };
        case 'ended': return { color: theme.colors.text.tertiary };
        case 'working':
        case 'offline': return { color: theme.colors.text.tertiary };
        case 'failed': return { color: theme.colors.status.error };
    }
}

export type DocumentTabStatus = Readonly<{
    tone: 'running' | 'working' | 'attention' | 'ended' | 'offline' | 'failed';
    /** Already translated: "Running", "Needs you". */
    label: string;
}>;

export type DocumentTabItem = Readonly<{
    key: string;
    title: string;
    subtitle?: string | null;
    isPreview: boolean;
    isPinned: boolean;
    canPin?: boolean;
    /** Still open, but this device cannot show it: the tab stays, quiet, and says so when opened. */
    isUnavailable?: boolean;
}>;

export type DocumentTabStripProps<T extends DocumentTabItem> = Readonly<{
    tabs: readonly T[];
    activeTabKey: string | null;
    accessibilityLabel: string;
    onActivate: (key: string) => void;
    onPin: (key: string) => void;
    onUnpin: (key: string) => void;
    onClose: (key: string) => void;
    renderLeadingIcon: (tab: T, active: boolean) => React.ReactNode;
    /** A destination owner may add its row gestures around the shared tab anatomy. */
    wrapTab?: (tab: T, content: React.ReactNode) => React.ReactNode;
    resolveTabPresentation?: ((tab: T) => DocumentTabPresentation | null | undefined) | null;
    tabNativeId: (key: string) => string;
    panelNativeId: (key: string) => string;
    unsavedTabKeys?: ReadonlySet<string>;
    testIds?: DocumentTabStripTestIds;
    /**
     * `strip` (default): the Details strip — tabs scroll, each shows its pin and close.
     * `bar`: the workspace bar (workspace lab T) — pinned marks stay fixed, while every other tab
     * shrinks to its minimum width and then scrolls. Close appears on hover and on the open tab
     * in one always-reserved trailing slot. Pinning lives in the tab's menu.
     * `rail`: the phone's open-tabs rail (phone-nav lab R) — the bar's anatomy as pills that scroll
     * sideways: each tab rests on a hairline, the open one takes the selection fill and its close,
     * and `subtitle` reads as a quiet count after the title (a split's panes).
     */
    variant?: 'strip' | 'bar' | 'rail';
    /** `rail` only: what follows the last tab inside the scroll (the "Synced" note). */
    railTrailing?: React.ReactNode;
    /**
     * `bar` only. `raised`: the open tab is lifted onto paper — the focused pane's tab, the one
     * focus signal. `quiet`: the open tab of a pane that is not focused takes a selection tint.
     */
    activeEmphasis?: 'raised' | 'quiet';
    /** `bar` and `rail`: a tab's menu, from a right click or a long press. */
    onTabMenu?: (key: string, event: unknown) => void;
    /** Retire an open press menu when this tab becomes the carried source. */
    onDismissTabMenu?: (key: string) => void;
    /** `bar` only: the tablist's own height (30 in the title strip, 28 in a pane's own strip). */
    barTabHeightPx?: number;
    entityDragDrop?: DocumentTabEntityDragDrop;
    /** A tab may carry its entity without advertising this strip as a drop destination. */
    entityDragSource?: DocumentTabEntityDragSource;
    /**
     * `bar` only, while an item is carried (DnD lab C2): `dropSlot` shows the place a kept tab will
     * land at the end of the strip; `dropRingTabKey` rings the tab an already-open item will go to.
     */
    dropSlot?: boolean;
    dropRingTabKey?: string | null;
    /** `bar` only: the surface under the strip, which its edge fades blend into. */
    barFadeColor?: string;
}>;

/** The bar variant's measures (workspace lab T: 30 tall in the title strip, 28 in a pane strip). */
export const DOCUMENT_TAB_BAR_METRICS = Object.freeze({
    tabHeightPx: 30,
    tabRadiusPx: 9,
    tabPaddingStartPx: 10,
    tabPaddingEndPx: 5,
    tabGapPx: 7,
    tabMinWidthPx: 144,
    tabMaxWidthPx: 212,
    glyphBoxPx: 16,
    trailingSlotPx: 18,
    trailingRadiusPx: 5,
    stripGapPx: 2,
});
const B = DOCUMENT_TAB_BAR_METRICS;
/** Room above and below the bar's tabs, inside its scroll clip, for the raised tab's shadow. */
const BAR_SCROLL_BLEED_PX = 4;

// Details lab 2 (`dl-strip`): tabs sit borderless on the strip; the open one takes the selection
// fill, a preview tab reads in italics, a pinned tab shows its pin and an edited one its dot.
const stylesheet = StyleSheet.create((theme) => ({
    tabsScroll: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    tabsContent: {
        alignItems: 'center',
        gap: M.tabGapPx,
    },
    tab: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: M.tabRadiusPx,
        maxWidth: M.tabMaxWidthPx,
        flexShrink: 0,
    },
    tabContent: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        paddingLeft: M.tabPaddingStartPx,
        paddingRight: theme.space.s2,
        minHeight: M.tabHeightPx,
    },
    tabActive: {
        backgroundColor: theme.colors.surface.elevated,
    },
    tabLabel: {
        flexShrink: 1,
        ...M.tabLabel,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    tabLabelActive: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    tabLabelPreview: {
        fontStyle: 'italic',
    },
    tabCopy: {
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.space.s6,
    },
    tabSubtitle: {
        ...M.tabSubtitle,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
        // The subtitle gives way first: a narrow tab keeps its title readable ("Checkout UI…")
        // rather than shrinking both to "C…" and "R…".
        flexShrink: 1000,
        minWidth: 0,
    },
    tabActions: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: M.tabPaddingEndPx,
    },
    unsavedDot: {
        width: M.tabUnsavedDotPx,
        height: M.tabUnsavedDotPx,
        borderRadius: M.tabUnsavedDotPx / 2,
        backgroundColor: theme.colors.text.secondary,
    },
    favicon: {
        width: M.tabGlyphPx,
        height: M.tabGlyphPx,
        borderRadius: 3,
    },
    bar: {
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: B.stripGapPx,
    },
    /** The scrolling part of the bar: as wide as its tabs, never wider than the room it has. */
    barViewport: {
        flexShrink: 1,
        minWidth: 0,
        marginVertical: -BAR_SCROLL_BLEED_PX,
    },
    barScroll: {
        flexGrow: 0,
        flexShrink: 1,
    },
    barContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: B.stripGapPx,
        // Room inside the clip for the raised tab's shadow and, at either end, the insertion mark
        // (DnD lab C2), so the strip never reflows when a carry starts.
        paddingVertical: BAR_SCROLL_BLEED_PX,
        paddingHorizontal: B.stripGapPx,
        // Tabs shrink to fit the visible strip before it scrolls (web resolves this against the
        // scroller's own width).
        maxWidth: '100%',
    },
    barFrame: {
        flexShrink: 1,
        minWidth: B.tabMinWidthPx,
        maxWidth: B.tabMaxWidthPx,
    },
    /** The open tab keeps its whole name while its neighbours shrink. */
    barFrameOpen: {
        flexShrink: 0,
    },
    barTab: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: B.tabRadiusPx,
        // Tabs shrink toward their minimum only when crowded; the consumer moves the rest behind
        // "+N" before that, so a short title keeps its natural width (workspace lab V).
        minWidth: 0,
        maxWidth: B.tabMaxWidthPx,
        flexShrink: 1,
        // Every tab reserves the raised tab's hairline, so raising one never shifts its neighbours.
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'transparent',
    },
    barTabPinned: {
        minWidth: 0,
        flexShrink: 0,
    },
    barTabOpen: {
        flexShrink: 0,
    },
    // Hover and the open tab of a pane that is not focused take the strip's own control hover
    // (the same fill as the back/forward buttons beside them); only the focused pane's open tab is
    // raised (workspace lab T: "that is the whole focus indicator").
    barTabHovered: {
        backgroundColor: theme.colors.surface.selected,
    },
    barTabQuiet: {
        backgroundColor: theme.colors.surface.selected,
    },
    barTabRaised: {
        backgroundColor: theme.colors.surface.pressed,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    entityTab: {
        flexShrink: 1,
        minWidth: 0,
    },
    /** A pinned mark keeps its whole box: its drag wrapper must not be crushed under a crowded strip. */
    entityTabFixed: {
        flexShrink: 0,
    },
    /** The carried item lands before this tab: a mark in the gap, so no tab moves under the pointer. */
    entityTabInsertion: {
        position: 'absolute',
        top: 4,
        bottom: 4,
        width: 2,
        flexDirection: 'row',
    },
    /** The tab an already-open item goes to (lab C2s "Already open somewhere"). */
    barTabGoToRing: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        borderRadius: B.tabRadiusPx,
        borderWidth: 2,
        borderColor: theme.colors.state.active.foreground,
    },
    barTabPress: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: B.tabGapPx,
        paddingLeft: B.tabPaddingStartPx,
    },
    barTabPressPinned: {
        paddingLeft: 0,
        justifyContent: 'center',
    },
    barGlyph: {
        width: B.glyphBoxPx,
        height: B.glyphBoxPx,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    /** Pinned tabs (marks alone) lead; a short hairline separates them from the rest. */
    barPinSeparator: {
        width: StyleSheet.hairlineWidth,
        height: 16,
        marginHorizontal: theme.space.s4,
        backgroundColor: theme.colors.border.strong,
        flexShrink: 0,
    },
    barTrailing: {
        paddingRight: B.tabPaddingEndPx,
        paddingLeft: theme.space.s2,
    },
    railContent: {
        alignItems: 'center',
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s12,
    },
    railTab: {
        borderRadius: B.tabHeightPx / 2,
        borderColor: theme.colors.border.default,
        maxWidth: 168,
        flexShrink: 0,
    },
    railTabOpen: {
        borderColor: 'transparent',
        backgroundColor: theme.colors.surface.selected,
    },
    railCount: {
        ...M.tabSubtitle,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    tabLabelUnavailable: {
        color: theme.colors.text.tertiary,
    },
    barTrailingSlot: {
        width: B.trailingSlotPx,
        height: B.trailingSlotPx,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pinnedStatus: {
        position: 'absolute',
        right: -2,
        bottom: -1,
    },
}));

export function DocumentTabStrip<T extends DocumentTabItem>(props: DocumentTabStripProps<T>) {
    const entitySource = props.entityDragDrop ?? props.entityDragSource;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const styles = { ...stylesheet, tabActive: [stylesheet.tabActive, { backgroundColor: materialColor(theme.colors.surface.elevated) }] };
    // A finger gets the platform touch floor; a precise pointer keeps the dense strip (details lab 2),
    // with its pin and close still at least the WCAG 2.5.8 target.
    const touchFloorPx = resolveTouchTargetFloorPx(Platform.OS);
    const interactiveTargetStyle = React.useMemo(() => (touchFloorPx === null ? null : {
        minWidth: touchFloorPx,
        minHeight: touchFloorPx,
    }), [touchFloorPx]);
    const actionSize = Math.max(M.tabActionTargetPx, touchFloorPx ?? 0);
    const refreshDropMeasurements = React.useCallback(() => {
        void props.entityDragDrop?.runtime.refreshMeasurements();
    }, [props.entityDragDrop?.runtime]);
    const tabFocusTargetsRef = React.useRef(new Map<string, { focus?: () => void }>());
    const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>, currentIndex: number) => {
        const key = event.key;
        const nextIndex = resolveHappierTabKeySelection({
            tabs: props.tabs,
            key,
            currentIndex,
            rtl: I18nManager.isRTL,
        });
        if (nextIndex === null) return;
        event.preventDefault();
        const nextTab = props.tabs[nextIndex];
        if (!nextTab) return;
        props.onActivate(nextTab.key);
        if (nextIndex !== currentIndex) tabFocusTargetsRef.current.get(nextTab.key)?.focus?.();
    }, [props.tabs, props.onActivate]);

    if (props.variant === 'rail') {
        return <DocumentRail strip={props} actionSize={actionSize} onKeyDown={handleKeyDown} focusTargets={tabFocusTargetsRef.current} />;
    }

    if (props.variant === 'bar') {
        return <DocumentBar strip={props} actionSize={actionSize} onKeyDown={handleKeyDown} focusTargets={tabFocusTargetsRef.current} />;
    }

    return (
        <ScrollView
            horizontal
            style={styles.tabsScroll}
            contentContainerStyle={styles.tabsContent}
            showsHorizontalScrollIndicator={false}
            accessibilityRole="tablist"
            accessibilityLabel={props.accessibilityLabel}
            onLayout={refreshDropMeasurements}
            onScroll={refreshDropMeasurements}
        >
            {props.tabs.map((tab, tabIndex) => {
                const isActive = props.activeTabKey ? tab.key === props.activeTabKey : false;
                const isUnsaved = props.unsavedTabKeys?.has(tab.key) === true;
                const safeTabKey = toTestIdSafeValue(tab.key);
                const presentation = props.resolveTabPresentation?.(tab) ?? null;
                const content = (
                    <View
                        key={tab.key}
                        style={[styles.tab, isActive ? styles.tabActive : null]}
                    >
                        <DocumentTabWebPressable
                            ref={(target) => {
                                if (target) tabFocusTargetsRef.current.set(tab.key, target);
                                else tabFocusTargetsRef.current.delete(tab.key);
                            }}
                            onPress={() => props.onActivate(tab.key)}
                            onAuxClick={Platform.OS === 'web' ? (event) => closeTabOnMiddleClick(event, tab.key, props.onClose) : undefined}
                            onKeyDown={Platform.OS === 'web'
                                ? (event) => handleKeyDown(event, tabIndex)
                                : undefined}
                            testID={props.testIds?.tab?.(safeTabKey) ?? undefined}
                            style={[
                                styles.tabContent,
                                interactiveTargetStyle,
                            ]}
                            accessibilityRole="tab"
                            accessibilityLabel={presentation?.status
                                ? `${t('session.detailsPanel.openTabA11y', { title: tab.title })}, ${presentation.status.label}`
                                : t('session.detailsPanel.openTabA11y', { title: tab.title })}
                            accessibilityState={{ selected: isActive }}
                            aria-selected={isActive}
                            nativeID={props.tabNativeId(tab.key)}
                            aria-controls={props.panelNativeId(tab.key)}
                            tabIndex={isActive ? 0 : -1}
                        >
                            {presentation?.isLoading ? (
                                <ActivitySpinner
                                    size={M.tabGlyphPx - 3}
                                    color={theme.colors.text.secondary}
                                    testID={props.testIds?.tabSpinner?.(safeTabKey) ?? undefined}
                                />
                            ) : presentation?.faviconUrl ? (
                                <Image
                                    source={{ uri: presentation.faviconUrl }}
                                    style={styles.favicon}
                                    testID={props.testIds?.tabFavicon?.(safeTabKey) ?? undefined}
                                />
                            ) : props.renderLeadingIcon(tab, isActive)}
                            <View style={styles.tabCopy}>
                                <Text
                                    style={[
                                        styles.tabLabel,
                                        isActive ? styles.tabLabelActive : null,
                                        tab.isPreview ? styles.tabLabelPreview : null,
                                    ]}
                                    numberOfLines={1}
                                >
                                    {tab.title}
                                </Text>
                                {typeof tab.subtitle === 'string' && tab.subtitle.trim().length > 0 ? (
                                    <Text style={styles.tabSubtitle} numberOfLines={1}>
                                        {tab.subtitle}
                                    </Text>
                                ) : null}
                            </View>
                        </DocumentTabWebPressable>
                        <View style={styles.tabActions}>
                            {presentation?.status && (tab.isPinned || !isActive) ? (
                                <DocumentTabStatusMark
                                    status={presentation.status}
                                    compact={tab.isPinned}
                                    testID={props.testIds?.tabStatus?.(safeTabKey) ?? undefined}
                                    spinnerTestID={props.testIds?.tabSpinner?.(safeTabKey) ?? undefined}
                                />
                            ) : null}
                            {tab.isPreview || tab.canPin ? (
                                <IconButton
                                    onPress={(event: unknown) => {
                                        if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                                            (event as ScrollPropagationEvent).stopPropagation?.();
                                        }
                                        props.onPin(tab.key);
                                    }}
                                    testID={props.testIds?.tabPin?.(safeTabKey) ?? undefined}
                                    accessibilityLabel={`${t('session.detailsPanel.pinTabA11y')}: ${tab.title}`}
                                    tooltip={`${t('session.detailsPanel.pinTabA11y')}: ${tab.title}`}
                                    variant="plain"
                                    size={actionSize}
                                    minimumInteractiveTargetSize={actionSize}
                                    iconSize={12}
                                    icon={<PinIcon size={12} color={theme.colors.text.tertiary} />}
                                />
                            ) : tab.isPinned ? (
                                <IconButton
                                    onPress={(event: unknown) => {
                                        if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                                            (event as ScrollPropagationEvent).stopPropagation?.();
                                        }
                                        props.onUnpin(tab.key);
                                    }}
                                    testID={props.testIds?.tabUnpin?.(safeTabKey) ?? undefined}
                                    accessibilityLabel={`${t('session.detailsPanel.unpinTabA11y')}: ${tab.title}`}
                                    tooltip={`${t('session.detailsPanel.unpinTabA11y')}: ${tab.title}`}
                                    variant="plain"
                                    size={actionSize}
                                    minimumInteractiveTargetSize={actionSize}
                                    iconSize={12}
                                    icon={<PinIcon size={12} color={theme.colors.text.secondary} />}
                                />
                            ) : null}
                            <IconButton
                                onPress={(event: unknown) => {
                                    if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                                        (event as ScrollPropagationEvent).stopPropagation?.();
                                    }
                                    props.onClose(tab.key);
                                }}
                                testID={props.testIds?.tabClose?.(safeTabKey) ?? undefined}
                                accessibilityLabel={`${isUnsaved
                                    ? t('detailsSurface.chrome.closeUnsavedTabA11y')
                                    : t('session.detailsPanel.closeTabA11y')}: ${tab.title}`}
                                tooltip={`${isUnsaved
                                    ? t('detailsSurface.chrome.closeUnsavedTabA11y')
                                    : t('session.detailsPanel.closeTabA11y')}: ${tab.title}`}
                                variant="plain"
                                size={actionSize}
                                minimumInteractiveTargetSize={actionSize}
                                iconSize={M.tabCloseGlyphPx}
                                icon={isUnsaved ? (
                                    <View
                                        testID={props.testIds?.tabUnsaved?.(safeTabKey) ?? undefined}
                                        style={styles.unsavedDot}
                                    />
                                ) : (
                                    <Icon name="x" size={M.tabCloseGlyphPx} color={theme.colors.text.tertiary} />
                                )}
                            />
                        </View>
                    </View>
                );
                const wrapped = props.wrapTab ? props.wrapTab(tab, content) : content;
                return <React.Fragment key={tab.key}>{entitySource
                    ? <DocumentEntityTab tab={tab} binding={entitySource} dropBinding={props.entityDragDrop} gapPx={M.tabGapPx} first={tabIndex === 0}>{wrapped}</DocumentEntityTab>
                    : wrapped}</React.Fragment>;
            })}
        </ScrollView>
    );
}

/**
 * Keeps the open tab in view in a strip that scrolls sideways: when it changes (a tab opened from
 * elsewhere, chosen from the tab list, a preview replaced) and when the strip is first measured,
 * without animating on arrival.
 */
function useRevealedActiveTab(activeTabKey: string | null) {
    const scrollRef = React.useRef<ScrollView | null>(null);
    const frames = React.useRef(new Map<string, { x: number; width: number }>());
    const frameNodes = React.useRef(new Map<string, unknown>());
    const viewport = React.useRef({ x: 0, width: 0 });
    // The web reports a layout only when a size changes, so a tab pushed along by its neighbours
    // keeps a stale position; read the live DOM there and the measured layout elsewhere.
    const readViewport = React.useCallback(() => {
        const node = (scrollRef.current as { getScrollableNode?: () => unknown } | null)?.getScrollableNode?.() as
            { scrollLeft?: unknown; clientWidth?: unknown } | null | undefined;
        return typeof node?.scrollLeft === 'number' && typeof node.clientWidth === 'number' && node.clientWidth > 0
            ? { x: node.scrollLeft, width: node.clientWidth } : viewport.current;
    }, []);
    const readFrame = React.useCallback((key: string) => {
        const node = frameNodes.current.get(key) as { offsetLeft?: unknown; offsetWidth?: unknown } | undefined;
        return typeof node?.offsetLeft === 'number' && typeof node.offsetWidth === 'number' && node.offsetWidth > 0
            ? { x: node.offsetLeft, width: node.offsetWidth } : frames.current.get(key);
    }, []);
    const reveal = React.useCallback((key: string | null, animated: boolean) => {
        const frame = key ? readFrame(key) : undefined;
        const { x, width } = readViewport();
        if (!frame || width === 0) return;
        if (frame.x < x + 12) scrollRef.current?.scrollTo({ x: Math.max(0, frame.x - 12), animated });
        else if (frame.x + frame.width > x + width - 12) scrollRef.current?.scrollTo({ x: frame.x + frame.width - width + 12, animated });
    }, [readFrame, readViewport]);
    const registerFrameNode = React.useCallback((key: string, node: unknown) => {
        if (node) frameNodes.current.set(key, node);
        else frameNodes.current.delete(key);
    }, []);
    React.useEffect(() => { reveal(activeTabKey, false); }, [reveal, activeTabKey]);
    return { scrollRef, frames, viewport, reveal, readViewport, registerFrameNode };
}

/**
 * The bar's scroller, for the tabs inside it: a tab scrolled out of view is not a destination (its
 * box still lies beyond the clip, over whatever is drawn there), and a carry near either end scrolls
 * the strip.
 */
type DocumentBarScroll = Readonly<{
    containsPointer: (pointer: Readonly<{ x: number; y: number }>) => boolean;
    autoscroll: (pointer: Readonly<{ x: number; y: number }>) => void;
    /** Native: re-read the visible strip's window frame with the tabs' own measurement. */
    measure: () => Promise<void>;
}>;
const DocumentBarScrollContext = React.createContext<DocumentBarScroll | null>(null);

type WheelLikeEvent = Readonly<{ deltaX?: number; deltaY?: number; nativeEvent?: Readonly<{ deltaX?: number; deltaY?: number }> }>;

/**
 * The workspace bar (workspace lab T): pinned tabs stay at the leading edge as their marks; every
 * other tab sits in one strip that scrolls sideways. Tabs keep their natural width while they fit,
 * shrink toward their minimum when crowded, and only then scroll. A soft fade marks an edge with
 * more beyond it; a mouse wheel scrolls the strip sideways.
 */
function DocumentBar<T extends DocumentTabItem>(props: Readonly<{
    strip: DocumentTabStripProps<T>;
    actionSize: number;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>, currentIndex: number) => void;
    focusTargets: Map<string, { focus?: () => void }>;
}>) {
    const styles = stylesheet;
    const { strip } = props;
    const { theme } = useUnistyles();
    const { scrollRef, frames, viewport, reveal, readViewport, registerFrameNode } = useRevealedActiveTab(strip.activeTabKey);
    const fades = useScrollEdgeFades({ enabledEdges: { left: true, right: true }, overflowThreshold: 2, edgeThreshold: 2 });
    const viewportHost = React.useRef<unknown>(null);
    const viewportBounds = React.useRef<WindowBounds | null>(null);
    const heightPx = strip.barTabHeightPx ?? B.tabHeightPx;
    const pinned = strip.tabs.filter(tab => tab.isPinned);
    const unpinned = strip.tabs.filter(tab => !tab.isPinned);
    const refresh = strip.entityDragDrop?.runtime;
    const measureViewport = React.useCallback(async () => {
        const node = viewportHost.current;
        const bounds = await measureWindowBounds(node);
        if (viewportHost.current === node) viewportBounds.current = bounds;
    }, []);
    const autoscroll = React.useCallback((pointer: Readonly<{ x: number; y: number }>) => {
        const bounds = readWindowBounds(viewportHost.current) ?? viewportBounds.current;
        if (!bounds) return;
        const content = Array.from(frames.current.values()).reduce((end, frame) => Math.max(end, frame.x + frame.width), 0);
        const next = resolveTreeDropAutoscrollTarget({ pointerY: pointer.x, viewportTopY: bounds.x,
            viewportHeight: bounds.width, scrollOffsetY: readViewport().x, contentHeight: content });
        if (next !== readViewport().x) scrollRef.current?.scrollTo({ x: next, animated: false });
    }, [frames, readViewport, scrollRef]);
    const containsPointer = React.useCallback((pointer: Readonly<{ x: number; y: number }>) => {
        const bounds = readWindowBounds(viewportHost.current) ?? viewportBounds.current;
        return !bounds || (pointer.x >= bounds.x && pointer.x <= bounds.x + bounds.width);
    }, []);
    const scrollBinding = React.useMemo(() => ({ containsPointer, autoscroll, measure: measureViewport }), [autoscroll, containsPointer, measureViewport]);
    const tabProps = (tab: T) => {
        const index = strip.tabs.indexOf(tab);
        return {
            tab, index,
            active: strip.activeTabKey ? tab.key === strip.activeTabKey : false,
            emphasis: strip.activeEmphasis ?? 'raised',
            unsaved: strip.unsavedTabKeys?.has(tab.key) === true,
            heightPx, actionSize: props.actionSize, strip, onKeyDown: props.onKeyDown,
            registerFocusTarget: (target: { focus?: () => void } | null) => {
                if (target) props.focusTargets.set(tab.key, target);
                else props.focusTargets.delete(tab.key);
            },
        } as const;
    };
    const onWheel = React.useCallback((event: WheelLikeEvent) => {
        const deltaX = event.deltaX ?? event.nativeEvent?.deltaX ?? 0;
        const deltaY = event.deltaY ?? event.nativeEvent?.deltaY ?? 0;
        // A trackpad already scrolls sideways; a vertical wheel turns into sideways movement here.
        if (Math.abs(deltaY) <= Math.abs(deltaX)) return;
        scrollRef.current?.scrollTo({ x: Math.max(0, readViewport().x + deltaY), animated: false });
    }, [readViewport, scrollRef]);
    return (
        <View style={styles.bar} accessibilityRole="tablist" accessibilityLabel={strip.accessibilityLabel}
            onLayout={() => { void refresh?.refreshMeasurements(); }}>
            {pinned.map(tab => <DocumentBarTab key={tab.key} {...tabProps(tab)} />)}
            {pinned.length > 0 && unpinned.length > 0 ? <View style={styles.barPinSeparator} /> : null}
            <View ref={(node) => { viewportHost.current = node; }} testID="document-tab-viewport" style={styles.barViewport} onLayout={() => { void measureViewport(); }}>
                <DocumentBarScrollContext.Provider value={scrollBinding}>
                    <ScrollView
                        ref={scrollRef}
                        horizontal
                        style={[styles.barScroll, { height: heightPx + 2 * BAR_SCROLL_BLEED_PX }]}
                        contentContainerStyle={[styles.barContent, {
                            minWidth: unpinned.length * (B.tabMinWidthPx + B.stripGapPx) + B.stripGapPx,
                        }]}
                        showsHorizontalScrollIndicator={false}
                        scrollEventThrottle={32}
                        onLayout={(event) => {
                            viewport.current = { ...viewport.current, width: event.nativeEvent.layout.width };
                            fades.onViewportLayout(event);
                            reveal(strip.activeTabKey, false);
                            void measureViewport();
                            void refresh?.refreshMeasurements();
                        }}
                        onContentSizeChange={(width, height) => {
                            fades.onContentSizeChange(width, height);
                            // A tab that just opened at the end widens the strip after its own layout.
                            reveal(strip.activeTabKey, false);
                        }}
                        onScroll={(event) => {
                            viewport.current = { ...viewport.current, x: event.nativeEvent.contentOffset.x };
                            fades.onScroll(event);
                            void refresh?.refreshMeasurements();
                        }}
                        {...(Platform.OS === 'web' ? { onWheel } : null)}
                    >
                        {unpinned.map(tab => (
                            <View key={tab.key} testID={`document-tab-frame-${toTestIdSafeValue(tab.key)}`}
                                ref={(node) => registerFrameNode(tab.key, node)}
                                style={[styles.barFrame, tab.key === strip.activeTabKey ? styles.barFrameOpen : null]}
                                onLayout={(event) => {
                                    const { x, width } = event.nativeEvent.layout;
                                    frames.current.set(tab.key, { x, width });
                                    if (tab.key === strip.activeTabKey) reveal(tab.key, false);
                                }}>
                                <DocumentBarTab {...tabProps(tab)} />
                            </View>
                        ))}
                    </ScrollView>
                </DocumentBarScrollContext.Provider>
                <ScrollEdgeFades color={strip.barFadeColor ?? theme.colors.background.canvas} size={20} edges={fades.visibility} />
            </View>
        </View>
    );
}

/** The rail's pills are 30 tall; the press reaches the platform's comfortable touch height. */
const RAIL_HIT_SLOP = { top: 7, bottom: 7 } as const;

/**
 * The phone's open-tabs rail: the bar's tabs as scrolling pills. The open tab is kept in view when it
 * changes (a tab opened from elsewhere, a preview replaced), without animating on arrival.
 */
function DocumentRail<T extends DocumentTabItem>(props: Readonly<{
    strip: DocumentTabStripProps<T>;
    actionSize: number;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>, currentIndex: number) => void;
    focusTargets: Map<string, { focus?: () => void }>;
}>) {
    const styles = stylesheet;
    const { strip } = props;
    const { scrollRef, frames, viewport, reveal } = useRevealedActiveTab(strip.activeTabKey);
    return (
        <ScrollView
            ref={scrollRef}
            horizontal
            contentContainerStyle={styles.railContent}
            showsHorizontalScrollIndicator={false}
            onLayout={(event) => {
                viewport.current = { ...viewport.current, width: event.nativeEvent.layout.width };
                reveal(strip.activeTabKey, false);
                void strip.entityDragDrop?.runtime.refreshMeasurements();
            }}
            onScroll={(event) => {
                viewport.current = { ...viewport.current, x: event.nativeEvent.contentOffset.x };
                void strip.entityDragDrop?.runtime.refreshMeasurements();
            }}
            scrollEventThrottle={32}
            accessibilityRole="tablist"
            accessibilityLabel={strip.accessibilityLabel}
        >
            {strip.tabs.map((tab, tabIndex) => (
                <View key={tab.key} onLayout={(event) => {
                    const { x, width } = event.nativeEvent.layout;
                    frames.current.set(tab.key, { x, width });
                    if (tab.key === strip.activeTabKey) reveal(tab.key, false);
                }}>
                    <DocumentBarTab
                        rail
                        tab={tab}
                        index={tabIndex}
                        active={strip.activeTabKey ? tab.key === strip.activeTabKey : false}
                        emphasis="quiet"
                        unsaved={strip.unsavedTabKeys?.has(tab.key) === true}
                        heightPx={B.tabHeightPx}
                        actionSize={props.actionSize}
                        strip={strip}
                        onKeyDown={props.onKeyDown}
                        registerFocusTarget={(target) => {
                            if (target) props.focusTargets.set(tab.key, target);
                            else props.focusTargets.delete(tab.key);
                        }}
                    />
                </View>
            ))}
            {strip.railTrailing ?? null}
        </ScrollView>
    );
}

function stopPropagation(event: unknown) {
    if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
        (event as ScrollPropagationEvent).stopPropagation?.();
    }
}

function closeTabOnMiddleClick(event: React.MouseEvent<HTMLElement>, tabKey: string, onClose: (key: string) => void) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    onClose(tabKey);
}

function documentTabSourceId(bindingId: string, tabKey: string): string {
    return JSON.stringify(['document-tab', bindingId, tabKey, 'source']);
}

/**
 * One tab of the bar variant. Its own hover state reveals close in the reserved trailing slot, so the
 * tab never changes width under the pointer (workspace lab: "hover never changes width").
 */
function DocumentBarTab<T extends DocumentTabItem>(props: Readonly<{
    tab: T;
    index: number;
    active: boolean;
    emphasis: 'raised' | 'quiet';
    unsaved: boolean;
    heightPx: number;
    actionSize: number;
    strip: DocumentTabStripProps<T>;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>, currentIndex: number) => void;
    registerFocusTarget: (target: { focus?: () => void } | null) => void;
    rail?: boolean;
    onLayout?: (event: LayoutChangeEvent) => void;
}>) {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const selectedPaint = { backgroundColor: materialColor(theme.colors.surface.selected) };
    const styles = {
        ...stylesheet,
        barTabHovered: [stylesheet.barTabHovered, selectedPaint],
        barTabQuiet: [stylesheet.barTabQuiet, selectedPaint],
        barTabRaised: [stylesheet.barTabRaised, { backgroundColor: materialColor(theme.colors.surface.pressed) }],
        railTabOpen: [stylesheet.railTabOpen, selectedPaint],
    };
    const [hovered, setHovered] = React.useState(false);
    // The ring is for keyboard focus and belongs on the drawn tab, at its radius, not on the hit box.
    const [focusVisible, setFocusVisible] = React.useState(false);
    const { tab, strip } = props;
    const draggedDuringPress = React.useRef(false);
    const dismissMenu = React.useRef(strip.onDismissTabMenu);
    dismissMenu.current = strip.onDismissTabMenu;
    const entitySource = strip.entityDragDrop ?? strip.entityDragSource;
    const runtime = entitySource?.runtime;
    const sourceId = entitySource ? documentTabSourceId(entitySource.id, tab.key) : null;
    React.useEffect(() => {
        if (!runtime || !sourceId) return;
        return runtime.subscribe(() => {
            const snapshot = runtime.getSnapshot();
            if (snapshot.sourceId === sourceId && snapshot.phase === 'carrying' && !draggedDuringPress.current) {
                // Latch until the next press: RN Web's pending long-press can fire
                // after dragend has already settled the canonical carry.
                draggedDuringPress.current = true;
                dismissMenu.current?.(tab.key);
            }
        });
    }, [runtime, sourceId, tab.key]);
    const safeTabKey = toTestIdSafeValue(tab.key);
    const presentation = strip.resolveTabPresentation?.(tab) ?? null;
    const pinned = tab.isPinned;
    const status = presentation?.status ?? null;
    const showClose = !pinned && ((hovered && !props.rail) || props.active || (!status && props.unsaved));
    const openMenu = strip.onTabMenu
        ? (event: unknown) => {
            (event as { preventDefault?: () => void } | null)?.preventDefault?.();
            strip.onTabMenu?.(tab.key, event);
        }
        : undefined;
    const closeLabel = `${props.unsaved
        ? t('detailsSurface.chrome.closeUnsavedTabA11y')
        : t('session.detailsPanel.closeTabA11y')}: ${tab.title}`;
    const content = (
        <View
            onLayout={props.onLayout}
            style={[
                styles.barTab,
                { height: props.heightPx },
                pinned ? [styles.barTabPinned, { width: props.heightPx }] : null,
                props.active ? styles.barTabOpen : null,
                hovered && !props.active ? styles.barTabHovered : null,
                props.active && !props.rail ? (props.emphasis === 'raised' ? styles.barTabRaised : styles.barTabQuiet) : null,
                props.rail ? [styles.railTab, props.active ? styles.railTabOpen : null] : null,
                happierFocusRingStyle({ visible: focusVisible, color: theme.colors.border.focus }),
            ]}
            {...(Platform.OS === 'web' ? {
                onPointerEnter: () => setHovered(true),
                onPointerLeave: () => setHovered(false),
            } : null)}
        >
            <DocumentTabWebPressable
                ref={(target) => props.registerFocusTarget(target as { focus?: () => void } | null)}
                onPress={() => strip.onActivate(tab.key)}
                onAuxClick={Platform.OS === 'web' ? (event) => closeTabOnMiddleClick(event, tab.key, strip.onClose) : undefined}
                onPressIn={() => { draggedDuringPress.current = false; }}
                onFocus={(event) => setFocusVisible(isHappierFocusVisible(event?.target))}
                onBlur={() => setFocusVisible(false)}
                onLongPress={openMenu ? (event) => { if (!draggedDuringPress.current) openMenu(event); } : undefined}
                hitSlop={props.rail ? RAIL_HIT_SLOP : undefined}
                {...(Platform.OS === 'web' && openMenu ? { onContextMenu: openMenu } : null)}
                onKeyDown={Platform.OS === 'web'
                    ? (event) => props.onKeyDown(event, props.index)
                    : undefined}
                testID={strip.testIds?.tab?.(safeTabKey) ?? undefined}
                style={[styles.barTabPress, pinned ? styles.barTabPressPinned : null, { height: props.heightPx }, HAPPIER_FOCUS_RING_DELEGATED_STYLE]}
                accessibilityRole="tab"
                accessibilityLabel={status
                    ? `${t('session.detailsPanel.openTabA11y', { title: tab.title })}, ${status.label}`
                    : t('session.detailsPanel.openTabA11y', { title: tab.title })}
                accessibilityState={{ selected: props.active }}
                aria-selected={props.active}
                nativeID={strip.tabNativeId(tab.key)}
                aria-controls={strip.panelNativeId(tab.key)}
                tabIndex={props.active ? 0 : -1}
            >
                <View style={styles.barGlyph}>
                    {presentation?.isLoading ? (
                        <ActivitySpinner
                            size={M.tabGlyphPx - 3}
                            color={theme.colors.text.secondary}
                            testID={strip.testIds?.tabSpinner?.(safeTabKey) ?? undefined}
                        />
                    ) : presentation?.faviconUrl ? (
                        <Image
                            source={{ uri: presentation.faviconUrl }}
                            style={styles.favicon}
                            testID={strip.testIds?.tabFavicon?.(safeTabKey) ?? undefined}
                        />
                    ) : strip.renderLeadingIcon(tab, props.active || hovered)}
                    {pinned && status ? (
                        <View style={styles.pinnedStatus}>
                            <DocumentTabStatusMark status={status} compact testID={strip.testIds?.tabStatus?.(safeTabKey) ?? undefined} />
                        </View>
                    ) : null}
                </View>
                {pinned ? null : (
                    <Text
                        style={[
                            styles.tabLabel,
                            props.active || hovered ? { color: theme.colors.text.primary } : null,
                            props.active ? styles.tabLabelActive : null,
                            tab.isPreview ? styles.tabLabelPreview : null,
                            tab.isUnavailable ? styles.tabLabelUnavailable : null,
                            { flexShrink: 1 },
                        ]}
                        numberOfLines={1}
                    >
                        {tab.title}
                    </Text>
                )}
                {props.rail && !pinned && typeof tab.subtitle === 'string' && tab.subtitle.length > 0 ? (
                    <Text style={styles.railCount}>{tab.subtitle}</Text>
                ) : null}
            </DocumentTabWebPressable>
            {pinned || (props.rail && !showClose && !status) ? null : (
                <View style={styles.barTrailing}>
                    <View style={styles.barTrailingSlot}>
                        {!showClose && status ? (
                            <DocumentTabStatusMark
                                status={status}
                                testID={strip.testIds?.tabStatus?.(safeTabKey) ?? undefined}
                                spinnerTestID={strip.testIds?.tabSpinner?.(safeTabKey) ?? undefined}
                            />
                        ) : showClose ? (
                            <IconButton
                                onPress={(event: unknown) => {
                                    stopPropagation(event);
                                    strip.onClose(tab.key);
                                }}
                                testID={strip.testIds?.tabClose?.(safeTabKey) ?? undefined}
                                accessibilityLabel={closeLabel}
                                tooltip={closeLabel}
                                tooltipPlacement="bottom"
                                variant="plain"
                                size={B.trailingSlotPx}
                                minimumInteractiveTargetSize={props.actionSize}
                                iconSize={M.tabCloseGlyphPx}
                                icon={props.unsaved && !hovered ? (
                                    <View
                                        testID={strip.testIds?.tabUnsaved?.(safeTabKey) ?? undefined}
                                        style={styles.unsavedDot}
                                    />
                                ) : (
                                    <Icon name="x" size={M.tabCloseGlyphPx} color={theme.colors.text.tertiary} />
                                )}
                            />
                        ) : null}
                    </View>
                </View>
            )}
            {strip.dropRingTabKey === tab.key ? <DocumentTabGoToRing /> : null}
        </View>
    );
    return entitySource
        ? <DocumentEntityTab tab={tab} binding={entitySource} dropBinding={strip.entityDragDrop} gapPx={B.stripGapPx} first={props.index === 0}
            fixed={pinned && !props.rail}
            endMark={strip.dropSlot === true && props.index === strip.tabs.length - 1}>{content}</DocumentEntityTab>
        : content;
}

function DocumentTabStatusMark(props: Readonly<{
    status: DocumentTabStatus;
    compact?: boolean;
    testID?: string;
    spinnerTestID?: string;
}>) {
    const { theme } = useUnistyles();
    if (props.status.tone === 'working' && !props.compact) {
        return <ActivitySpinner size={10} color={theme.colors.text.tertiary} testID={props.spinnerTestID} />;
    }
    const dot = resolveDocumentTabStatusDot(theme, props.status.tone);
    return <StatusDot testID={props.testID} color={dot.color} halo={dot.halo} size={props.compact ? 4 : 6} />;
}

/** Each mounted tab supplies its current semantic anchor to the shared owner. */
function DocumentEntityTab(props: Readonly<{
    tab: DocumentTabItem;
    binding: DocumentTabEntityDragSource;
    dropBinding?: DocumentTabEntityDragDrop;
    /** The strip's gap: the insertion mark sits in the gap before this tab. */
    gapPx: number;
    first: boolean;
    /** The tab keeps its own width (a pinned mark) instead of shrinking with the strip. */
    fixed?: boolean;
    /**
     * A kept tab lands after this, the strip's last tab (DnD lab C2 tab slot). The same mark as a
     * gap insertion, drawn past the tab's end, so the strip never reflows while the pointer crosses
     * between the pane centre and its edges.
     */
    endMark?: boolean;
    children: React.ReactNode;
}>) {
    const { tab, binding } = props;
    const sourceId = documentTabSourceId(binding.id, tab.key);
    const host = React.useRef<unknown>(null);
    const nativeBounds = React.useRef<WindowBounds | null>(null);
    const measure = React.useCallback(async () => {
        const node = host.current;
        const next = await measureWindowBounds(node);
        if (host.current === node) nativeBounds.current = next;
    }, []);
    const bounds = React.useCallback(() => readWindowBounds(host.current) ?? nativeBounds.current, []);
    useEntityDragSource(binding.runtime, {
        id: sourceId, scope: binding.scope,
        getItem: () => binding.getItem(tab.key),
        isCurrent: () => binding.isCurrent?.() !== false && binding.getItem(tab.key) !== null,
        describe: () => ({ title: tab.title }),
        getBounds: bounds,
    });
    const enabled = binding.isCurrent?.() !== false && binding.getItem(tab.key) !== null;
    const sourceRef = useEntityDragDomBinding({ runtime: binding.runtime, sourceId,
        enabled,
        describe: () => tab.title,
        canStart: (event, element) => !isSecondaryEntityRowControl(event, element),
    });
    const dropRef = useEntityDropDomBinding(props.dropBinding ? binding.runtime : undefined);
    const attach = React.useCallback((node: unknown) => {
        host.current = node;
        sourceRef(node);
        dropRef(node);
        // Styling wrappers can detach/reattach the same host during a feedback
        // commit. Registration and measured layout own refresh, not transient refs.
    }, [sourceRef, dropRef]);
    const adapter = React.useRef<ReturnType<typeof createEntityDragGestureAdapter> | null>(null);
    const gesture = React.useMemo(() => Gesture.Pan().runOnJS(true)
        .enabled(Platform.OS !== 'web' && enabled && binding.nativeDragAxis === 'vertical')
        .activeOffsetY([-ENTITY_DRAG_ACTIVATION_DISTANCE_PX, ENTITY_DRAG_ACTIVATION_DISTANCE_PX])
        .failOffsetX([-ENTITY_DRAG_ACTIVATION_DISTANCE_PX, ENTITY_DRAG_ACTIVATION_DISTANCE_PX])
        .onStart(event => {
            const carry = binding.runtime.begin(sourceId, 'pointer');
            adapter.current = carry ? createEntityDragGestureAdapter(carry) : null;
            adapter.current?.update({ x: event.absoluteX, y: event.absoluteY });
            void binding.runtime.refreshMeasurements();
        })
        .onUpdate(event => { adapter.current?.update({ x: event.absoluteX, y: event.absoluteY }); binding.runtime.autoscroll(); })
        .onEnd((event, success) => { void adapter.current?.end(success, { x: event.absoluteX, y: event.absoluteY }); })
        .onFinalize(() => adapter.current?.finalize()), [binding.runtime, sourceId, enabled, binding.nativeDragAxis]);
    React.useEffect(() => () => adapter.current?.cancel(), []);
    const content = <View ref={attach} collapsable={false} onLayout={() => {
        void measure().then(() => binding.runtime.refresh());
    }} testID={`document-tab-entity-${toTestIdSafeValue(tab.key)}`}
        style={props.fixed ? [stylesheet.entityTab, stylesheet.entityTabFixed] : stylesheet.entityTab}>
        {props.children}
        {props.dropBinding ? <DocumentEntityTabTarget tab={tab} binding={props.dropBinding} bounds={bounds} measure={measure}
            gapPx={props.gapPx} first={props.first} endMark={props.endMark} /> : null}
    </View>;
    return Platform.OS !== 'web' && binding.nativeDragAxis === 'vertical'
        ? <GestureDetector gesture={gesture}>{content}</GestureDetector> : content;
}

/** Only strips that declare a destination register its admission and subscribe to feedback. */
function DocumentEntityTabTarget(props: Readonly<{
    tab: DocumentTabItem;
    binding: DocumentTabEntityDragDrop;
    bounds: () => WindowBounds | null;
    measure: () => Promise<void>;
    gapPx: number;
    first: boolean;
    endMark?: boolean;
}>) {
    const { tab, binding } = props;
    const targetId = JSON.stringify(['document-tab', binding.id, tab.key, 'target']);
    const scroll = React.useContext(DocumentBarScrollContext);
    useEntityDropTarget(binding.runtime, {
        id: targetId, scope: binding.scope, acceptedKinds: binding.acceptedKinds,
        isCurrent: () => binding.isCurrent?.() !== false,
        getBounds: props.bounds,
        measureBounds: scroll ? async () => { await Promise.all([props.measure(), scroll.measure()]); } : props.measure,
        ...(scroll ? { autoscroll: scroll.autoscroll, containsPointer: scroll.containsPointer } : {}),
        listDestinations: () => [{ destination: { beforeTabId: tab.key }, label: tab.title }],
        resolve: ({ item, input }) => binding.resolve({ item, beforeTabId: tab.key, input }),
        execute: binding.execute,
    });
    const state = useEntityDropTargetState(binding.runtime, targetId);
    const allowed = state?.phase === 'carrying' && state.admission?.status === 'allowed';
    return <>
        {allowed ? <View pointerEvents="none" testID={`document-tab-drop-before-${toTestIdSafeValue(tab.key)}`}
            style={[stylesheet.entityTabInsertion, { left: props.first ? 0 : -(props.gapPx / 2) - 1 }]}>
            <TreeDropIndicatorLine orientation="vertical" indentPx={0}
                visual={{ kind: 'line', targetId: tab.key, edge: 'top', depth: 0 }} />
        </View> : null}
        {props.endMark ? <View pointerEvents="none" testID="document-tab-drop-slot"
            style={[stylesheet.entityTabInsertion, { right: -(props.gapPx / 2) - 1 }]}>
            <TreeDropIndicatorLine orientation="vertical" indentPx={0}
                visual={{ kind: 'line', targetId: tab.key, edge: 'bottom', depth: 0 }} />
        </View> : null}
    </>;
}

/** Rings the tab the carried item would go to. It pulses once on arrival; under reduced motion it simply appears. */
function DocumentTabGoToRing() {
    const reducedMotion = useReducedMotionPreference();
    const opacity = useSharedValue(reducedMotion ? 1 : 0);
    React.useEffect(() => {
        if (reducedMotion) { opacity.value = 1; return; }
        const { durationMs, easing } = reanimatedMotionTokens;
        opacity.value = withSequence(
            withTiming(1, { duration: durationMs.fast, easing: easing.standard }),
            withTiming(0.45, { duration: durationMs.base, easing: easing.standard }),
            withTiming(1, { duration: durationMs.base, easing: easing.standard }),
        );
    }, [opacity, reducedMotion]);
    const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
    return <Animated.View pointerEvents="none" testID="document-tab-go-to-ring" style={[stylesheet.barTabGoToRing, animated]} />;
}
