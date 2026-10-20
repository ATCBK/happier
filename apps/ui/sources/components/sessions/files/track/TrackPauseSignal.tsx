import * as React from 'react';

import type { TrackPauseReason } from './trackAgentEditsController';

export type TrackPauseSignal = (reason: TrackPauseReason, programmaticToken?: symbol) => void;
const TrackPauseSignalContext = React.createContext<TrackPauseSignal | null>(null);

/** File views and the tab strip report user intent; passive scroll/activation echoes are not input. */
export function TrackPauseSignalProvider(props: Readonly<{ signal: TrackPauseSignal; children: React.ReactNode }>) {
    return <TrackPauseSignalContext.Provider value={props.signal}>{props.children}</TrackPauseSignalContext.Provider>;
}

export function useTrackPauseSignal() {
    return React.useContext(TrackPauseSignalContext);
}

/** Bind these at user event boundaries, rather than observing programmatic viewport changes. */
export function useTrackInputHandlers() {
    const signal = useTrackPauseSignal();
    return React.useMemo(() => ({
        onWheel: () => signal?.('scroll'),
        onScrollBeginDrag: () => signal?.('scroll'),
        onTouchStart: () => signal?.('touch'),
        onSelectionChange: (programmaticToken?: symbol) => signal?.('selection', programmaticToken),
        onTyping: () => signal?.('typing'),
        onTabActivation: (programmaticToken?: symbol) => signal?.('tabActivation', programmaticToken),
    }), [signal]);
}
