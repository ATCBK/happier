import * as React from 'react';
import type { LayoutChangeEvent } from 'react-native';

import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';

/**
 * How far the phone's floating tab bar covers the bottom of the current page, in px (0 when none
 * overlays it, or when the page is inside a modal that covers the bar). The one reading of that
 * reservation: `PagePinnedBar` applies it to a pinned bar, a host that embeds a scrolling view applies
 * it to the view's body.
 */
export function useFloatingChromeClearance(): number {
    const chromeHeight = useSessionCockpitBottomChromeHeight();
    return useIsInsideModalBoundary() ? 0 : chromeHeight;
}

type PageBottomBarSeat = Readonly<{ top: number; report: (id: string, top: number | null) => void }>;
const PageBottomBarSeatContext = React.createContext<PageBottomBarSeat | null>(null);

/**
 * The bottom bars a page keeps while something floats over it (the phone working capsule after an Ask):
 * the Edit key row, the Changes review bar, a selection's bar. Each publishes how far its top edge sits
 * above the page's bottom, so the floating companion takes the seat above the highest one instead of
 * covering it. Mounted by the host that holds both the page and the companion.
 */
export function PageBottomBarSeatProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [tops, setTops] = React.useState<Readonly<Record<string, number>>>({});
    const report = React.useCallback((id: string, top: number | null) => {
        setTops((current) => {
            if (top === null) {
                if (!(id in current)) return current;
                const next = { ...current };
                delete next[id];
                return next;
            }
            const rounded = Number.isFinite(top) ? Math.max(0, Math.round(top)) : 0;
            return current[id] === rounded ? current : { ...current, [id]: rounded };
        });
    }, []);
    const top = React.useMemo(() => Math.max(0, ...Object.values(tops)), [tops]);
    const value = React.useMemo(() => ({ top, report }), [report, top]);
    return React.createElement(PageBottomBarSeatContext.Provider, { value }, props.children);
}

/** Where the highest kept bottom bar ends, in px up from the page's bottom (0 when none shows). */
export function usePageBottomBarTop(): number {
    return React.useContext(PageBottomBarSeatContext)?.top ?? 0;
}

/**
 * A kept bottom bar's report: pass the distance from the page's bottom to the bar's own bottom edge
 * (0 for a bar in flow at the bottom, the tab-bar clearance for one floating above it) and attach the
 * returned `onLayout` to the bar. Leaves the seat when the bar unmounts or `enabled` turns false.
 */
export function useReportPageBottomBar(enabled: boolean, bottomOffset: number): ((event: LayoutChangeEvent) => void) | undefined {
    const seat = React.useContext(PageBottomBarSeatContext);
    const id = React.useId();
    const report = seat?.report;
    const [height, setHeight] = React.useState<number | null>(null);
    React.useEffect(() => {
        if (!report) return;
        report(id, enabled && height !== null ? bottomOffset + height : null);
    }, [bottomOffset, enabled, height, id, report]);
    React.useEffect(() => () => report?.(id, null), [id, report]);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height), []);
    return report ? onLayout : undefined;
}
