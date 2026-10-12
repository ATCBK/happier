import * as React from 'react';
import { Platform, ScrollView, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, View } from 'react-native';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { resolveHorizontalScrollEdgeMaskStyle } from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { attachActionBarMouseDragScroll } from './attachActionBarMouseDragScroll';

const ACTION_BAR_SCROLL_END_GUTTER_WIDTH = 24;

const ScrollViewWithWheel = ScrollView as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof ScrollView> & {
        onWheel?: any;
        onKeyDown?: (event: unknown) => void;
        tabIndex?: number;
    }
>;

function readKeyboardKey(event: unknown): string | null {
    if (!event || typeof event !== 'object') return null;
    const candidate = event as Readonly<{ key?: unknown; nativeEvent?: Readonly<{ key?: unknown }> }>;
    const key = candidate.nativeEvent?.key ?? candidate.key;
    return typeof key === 'string' ? key : null;
}

function composerRailControls(node: any): any[] {
    if (!node || typeof node.querySelectorAll !== 'function') return [];
    return Array.from(node.querySelectorAll('button,[role="button"],[role="switch"]'));
}

export type AgentInputScrollableChipRowProps = Readonly<{
    children: React.ReactNode;
    fadeColor: string;
    indicatorColor: string;
    containerStyle?: any;
    contentStyle?: any;
    fadeLeftStyle?: any;
    fadeRightStyle?: any;
}>;

export function AgentInputScrollableChipRow(props: AgentInputScrollableChipRowProps) {
    const reducedMotion = useReducedMotionPreference();
    const fades = useScrollEdgeFades({
        enabledEdges: { left: true, right: true },
        overflowThreshold: 8,
        edgeThreshold: 2,
    });
    const scrollRef = React.useRef<any>(null);

    const getScrollNode = React.useCallback(() => {
        const raw = scrollRef.current;
        if (!raw) return null;
        return raw.getScrollableNode?.() ?? raw;
    }, []);

    const seedScrollMeasurements = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        const node = getScrollNode() as any;
        if (!node) return;
        const clientWidth = typeof node.clientWidth === 'number' ? node.clientWidth : null;
        const clientHeight = typeof node.clientHeight === 'number' ? node.clientHeight : null;
        const scrollWidth = typeof node.scrollWidth === 'number' ? node.scrollWidth : null;
        if (clientWidth === null || scrollWidth === null) return;

        const layoutEvent = {
            nativeEvent: { layout: { x: 0, y: 0, width: clientWidth, height: clientHeight ?? 0 } },
        } as unknown as LayoutChangeEvent;
        fades.onViewportLayout(layoutEvent);
        fades.onContentSizeChange(
            Math.max(0, scrollWidth - ACTION_BAR_SCROLL_END_GUTTER_WIDTH),
            clientHeight ?? 0,
        );
    }, [fades, getScrollNode]);

    const reportWebScroll = React.useCallback((nodeOverride?: any) => {
        if (Platform.OS !== 'web') return;
        const node = (nodeOverride ?? getScrollNode()) as any;
        if (!node) return;

        const clientWidth = typeof node.clientWidth === 'number' ? node.clientWidth : null;
        const clientHeight = typeof node.clientHeight === 'number' ? node.clientHeight : 0;
        const scrollWidth = typeof node.scrollWidth === 'number' ? node.scrollWidth : null;
        const scrollLeft = typeof node.scrollLeft === 'number' ? node.scrollLeft : 0;
        if (clientWidth === null || scrollWidth === null) return;

        const scrollEvent = {
            nativeEvent: {
                contentInset: { top: 0, left: 0, bottom: 0, right: 0 },
                contentOffset: { x: scrollLeft, y: 0 },
                layoutMeasurement: { width: clientWidth, height: clientHeight },
                contentSize: {
                    width: Math.max(0, scrollWidth - ACTION_BAR_SCROLL_END_GUTTER_WIDTH),
                    height: clientHeight,
                },
                zoomScale: 1,
            },
        } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
        fades.onScroll(scrollEvent);
    }, [fades, getScrollNode]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;

        const requestAnimationFrameSafe: (cb: () => void) => any =
            (globalThis as any).requestAnimationFrame?.bind(globalThis) ??
            ((cb: () => void) => setTimeout(cb, 0));
        const cancelAnimationFrameSafe: (id: any) => void =
            (globalThis as any).cancelAnimationFrame?.bind(globalThis) ??
            ((id: any) => clearTimeout(id));

        const animationFrameId = requestAnimationFrameSafe(() => {
            seedScrollMeasurements();
            reportWebScroll();
        });

        const node = getScrollNode();
        if (!node) return () => cancelAnimationFrameSafe(animationFrameId);

        const ResizeObserverAny = (globalThis as any).ResizeObserver as (new (cb: () => void) => { observe: (value: any) => void; disconnect: () => void }) | undefined;
        if (typeof ResizeObserverAny === 'function') {
            const observer = new ResizeObserverAny(() => {
                seedScrollMeasurements();
                reportWebScroll();
            });
            observer.observe(node as any);
            return () => {
                cancelAnimationFrameSafe(animationFrameId);
                observer.disconnect();
            };
        }

        const onResize = () => {
            seedScrollMeasurements();
            reportWebScroll();
        };
        const windowObject = (globalThis as any).window as Window | undefined;
        windowObject?.addEventListener?.('resize', onResize);
        return () => {
            cancelAnimationFrameSafe(animationFrameId);
            windowObject?.removeEventListener?.('resize', onResize);
        };
    }, [getScrollNode, reportWebScroll, seedScrollMeasurements]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;

        const requestAnimationFrameSafe: (cb: () => void) => any =
            (globalThis as any).requestAnimationFrame?.bind(globalThis) ??
            ((cb: () => void) => setTimeout(cb, 0));
        const cancelAnimationFrameSafe: (id: any) => void =
            (globalThis as any).cancelAnimationFrame?.bind(globalThis) ??
            ((id: any) => clearTimeout(id));

        let cleanup: (() => void) | undefined;
        const animationFrameId = requestAnimationFrameSafe(() => {
            const node = getScrollNode() as any;
            if (!node || typeof node.addEventListener !== 'function') return;
            cleanup = attachActionBarMouseDragScroll({
                node,
                onScroll: () => reportWebScroll(node),
            });
        });

        return () => {
            cancelAnimationFrameSafe(animationFrameId);
            cleanup?.();
        };
    }, [getScrollNode, reportWebScroll]);

    const canScroll = fades.canScrollX;
    const showFadeLeft = canScroll && fades.visibility.left;
    const showFadeRight = canScroll && fades.visibility.right;
    const webEdgeMask = React.useMemo(
        () => resolveHorizontalScrollEdgeMaskStyle({ top: false, bottom: false, left: showFadeLeft, right: showFadeRight }, { fadeSize: 24 }),
        [showFadeLeft, showFadeRight],
    );

    const handleKeyDown = React.useCallback((event: unknown) => {
        if (Platform.OS !== 'web') return;
        const key = readKeyboardKey(event);
        if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
        const node = getScrollNode() as any;
        const controls = composerRailControls(node);
        if (controls.length === 0) return;
        const active = (globalThis as any).document?.activeElement;
        const currentIndex = controls.indexOf(active);
        const nextIndex = key === 'Home'
            ? 0
            : key === 'End'
                ? controls.length - 1
                : key === 'ArrowLeft'
                    ? Math.max(0, currentIndex < 0 ? controls.length - 1 : currentIndex - 1)
                    : Math.min(controls.length - 1, currentIndex < 0 ? 0 : currentIndex + 1);
        const next = controls[nextIndex];
        next?.focus?.();
        next?.scrollIntoView?.({
            behavior: reducedMotion ? 'auto' : 'smooth',
            block: 'nearest',
            inline: 'nearest',
        });
        (event as any)?.preventDefault?.();
        (event as any)?.stopPropagation?.();
    }, [getScrollNode, reducedMotion]);

    return (
        <View style={props.containerStyle}>
            <ScrollViewWithWheel
                ref={scrollRef}
                // Web: the chips fade out at a scrollable edge through a mask on the rail itself. The
                // composer's glass surface is translucent, so a painted fade (native below) has no
                // colour to paint and the last chip was simply cut off.
                style={Platform.OS === 'web' ? webEdgeMask : undefined}
                horizontal
                accessibilityRole="toolbar"
                accessibilityLabel={t('agentInput.chipRail.accessibilityLabel')}
                accessibilityHint={canScroll ? t('agentInput.chipRail.moreControlsHint') : undefined}
                tabIndex={0}
                onKeyDown={handleKeyDown}
                showsHorizontalScrollIndicator={false}
                scrollEnabled
                decelerationRate="fast"
                alwaysBounceHorizontal={false}
                directionalLockEnabled
                keyboardShouldPersistTaps="handled"
                onWheel={(event: any) => {
                    if (Platform.OS !== 'web') return;
                    const node = getScrollNode() as any;
                    if (!node) return;
                    const nativeEvent = event?.nativeEvent ?? event;
                    const deltaX = typeof nativeEvent?.deltaX === 'number' ? nativeEvent.deltaX : 0;
                    const deltaY = typeof nativeEvent?.deltaY === 'number' ? nativeEvent.deltaY : 0;
                    const delta = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
                    if (!delta) return;
                    const before = node.scrollLeft ?? 0;
                    node.scrollLeft = before + delta;
                    reportWebScroll(node);
                }}
                onLayout={fades.onViewportLayout}
                onContentSizeChange={(width: number, height: number) => {
                    fades.onContentSizeChange(
                        Math.max(0, width - ACTION_BAR_SCROLL_END_GUTTER_WIDTH),
                        height,
                    );
                }}
                onScroll={(event: any) => {
                    if (Platform.OS === 'web') {
                        reportWebScroll();
                        return;
                    }
                    const nativeEvent = event?.nativeEvent;
                    const contentSizeWidth = nativeEvent?.contentSize?.width;
                    if (typeof contentSizeWidth !== 'number') {
                        fades.onScroll(event);
                        return;
                    }
                    fades.onScroll({
                        ...event,
                        nativeEvent: {
                            ...nativeEvent,
                            contentSize: {
                                ...nativeEvent.contentSize,
                                width: Math.max(0, contentSizeWidth - ACTION_BAR_SCROLL_END_GUTTER_WIDTH),
                            },
                        },
                    });
                }}
                scrollEventThrottle={16}
            >
                <View style={props.contentStyle}>
                    {props.children}
                </View>
            </ScrollViewWithWheel>
            {Platform.OS === 'web' ? null : <ScrollEdgeFades
                color={props.fadeColor}
                size={24}
                edges={{ left: showFadeLeft, right: showFadeRight }}
                leftStyle={props.fadeLeftStyle}
                rightStyle={props.fadeRightStyle}
            />}
            <ScrollEdgeIndicators
                edges={{ left: showFadeLeft, right: showFadeRight }}
                color={props.indicatorColor}
                size={14}
                opacity={0.28}
                leftStyle={props.fadeLeftStyle}
                rightStyle={props.fadeRightStyle}
            />
        </View>
    );
}
