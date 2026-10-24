import * as React from 'react';
import { Animated, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { LinearGradient } from 'expo-linear-gradient';

import { parseThemeColor } from '@/theme/parseThemeColor';

/** The distance over which the shade under a pane header reaches full strength (calm-shell `cshead.H1`). */
export const PANE_HEADER_SHADE_RAMP_PX = 12;
/** The shade's own height beneath the header. */
const PANE_HEADER_SHADE_HEIGHT_PX = 14;

/**
 * The pane-local visual channel between a pane's primary scroller and the shade under its header. The
 * scroller reports how far its content has moved from the top; the shade leaf turns that into opacity.
 * One ephemeral animated scalar per header/body pair: no React state, store, timer or listener, so a
 * scroll never rerenders the screen, the header or a row.
 */
export type PaneHeaderScrollSink = Readonly<{
    reportTopDistance: (distancePx: number) => void;
}>;

type PaneHeaderScrollChannel = PaneHeaderScrollSink & Readonly<{ opacity: Animated.Value }>;

const PaneHeaderScrollContext = React.createContext<PaneHeaderScrollChannel | null>(null);

/** Opacity of the shade for a physical distance from the top: 0 at the origin, full by the ramp. */
export function resolvePaneHeaderShadeOpacity(distancePx: number): number {
    if (!Number.isFinite(distancePx) || distancePx <= 0) return 0;
    return Math.min(1, distancePx / PANE_HEADER_SHADE_RAMP_PX);
}

/**
 * Pairs one header with its primary body. Without a scope a header draws no shade, and a scroller has
 * nothing to report to. A nested or secondary scroller inside a scoped body sits in
 * `PaneHeaderScrollIsolation` (or simply does not report), so it never claims the pane's shade.
 */
export function PaneHeaderScrollScope(props: Readonly<{
    children: React.ReactNode;
    /**
     * The pair has no header of its own here (an embedded Session inside a peek, a phone in landscape): its
     * scroller reports to the scope around it, whose header it is the body of. Toggling it keeps the tree.
     */
    passThrough?: boolean;
}>) {
    const outer = React.useContext(PaneHeaderScrollContext);
    const [channel] = React.useState(createPaneHeaderScrollChannel);
    return <PaneHeaderScrollContext.Provider value={props.passThrough ? outer : channel}>{props.children}</PaneHeaderScrollContext.Provider>;
}

function createPaneHeaderScrollChannel(): PaneHeaderScrollChannel {
    const opacity = new Animated.Value(0);
    let last = 0;
    return {
        opacity,
        reportTopDistance: (distancePx: number) => {
            const next = resolvePaneHeaderShadeOpacity(distancePx);
            if (next === last) return;
            last = next;
            opacity.setValue(next);
        },
    };
}

type PaneHeaderScrollChannels = Readonly<{ channelFor(key: string): PaneHeaderScrollChannel }>;

const PaneHeaderScrollChannelsContext = React.createContext<PaneHeaderScrollChannels | null>(null);

/**
 * For a pane whose one header serves several retained tab bodies (the right sidebar, a phone cockpit
 * surface): each tab keeps its own channel, keyed like its header slot, so a hidden tab's scroller never
 * moves the shown tab's shade, and returning to a tab shows the shade its retained offset left.
 */
export function PaneHeaderScrollChannelsProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [channels] = React.useState<PaneHeaderScrollChannels>(() => {
        const byKey = new Map<string, PaneHeaderScrollChannel>();
        return {
            channelFor(key) {
                let channel = byKey.get(key);
                if (!channel) {
                    channel = createPaneHeaderScrollChannel();
                    byKey.set(key, channel);
                }
                return channel;
            },
        };
    });
    return <PaneHeaderScrollChannelsContext.Provider value={channels}>{props.children}</PaneHeaderScrollChannelsContext.Provider>;
}

/**
 * Binds a subtree to one tab's channel: the tab's body (its scroller reports there) or the header while
 * that tab is the one shown (its shade reads there). Outside a channels provider it isolates.
 */
export function PaneHeaderScrollKey(props: Readonly<{ scrollKey: string | null; children: React.ReactNode }>) {
    const channels = React.useContext(PaneHeaderScrollChannelsContext);
    const channel = channels && props.scrollKey !== null ? channels.channelFor(props.scrollKey) : null;
    return <PaneHeaderScrollContext.Provider value={channel}>{props.children}</PaneHeaderScrollContext.Provider>;
}

/** Ends the pane's scope for a subtree whose scrollers are not the pane's primary body (menus, popovers, nested lists). */
export function PaneHeaderScrollIsolation(props: Readonly<{ children: React.ReactNode }>) {
    return <PaneHeaderScrollContext.Provider value={null}>{props.children}</PaneHeaderScrollContext.Provider>;
}

/** The primary scroller's reporter, or null when it stands outside a header scope. Stable for the scope's life. */
export function usePaneHeaderScrollSink(): PaneHeaderScrollSink | null {
    return React.useContext(PaneHeaderScrollContext);
}

/**
 * The shade under a header: a short ink fade beneath the header's full stack, at the opacity the
 * scope's scroller set. Inert and unseen by assistive technology. Draws nothing outside a scope.
 */
export const PaneHeaderShade = React.memo(function PaneHeaderShade() {
    const channel = React.useContext(PaneHeaderScrollContext);
    const { theme } = useUnistyles();
    const start = theme.colors.shadowPaneHeaderShade;
    const end = React.useMemo(() => parseThemeColor(start)?.alpha(0).rgb().string() ?? 'transparent', [start]);
    if (!channel) return null;
    return (
        <Animated.View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            testID="pane-header-shade"
            style={{ position: 'absolute', left: 0, right: 0, top: '100%', height: PANE_HEADER_SHADE_HEIGHT_PX, opacity: channel.opacity }}>
            <View style={{ flex: 1 }} pointerEvents="none">
                <LinearGradient colors={[start, end]} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={{ flex: 1 }} />
            </View>
        </Animated.View>
    );
});
