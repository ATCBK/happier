import * as React from 'react';

import type { TrackPauseReason, TrackRegion } from './trackAgentEditsController';

export type TrackPauseSignal = (reason: TrackPauseReason, programmaticToken?: symbol) => void;
const TrackPauseSignalContext = React.createContext<TrackPauseSignal | null>(null);

/**
 * Where this Session's agent is writing while Track is on (P5 §3.10): the File page showing `path` draws the
 * agent caret and wash there. The region comes from the tool call; without one, the File page places
 * `anchorText` (the text the edit replaces) in the content it holds.
 */
export type TrackPresence = Readonly<{
    path: string;
    region?: TrackRegion;
    anchorText?: string;
    agentId: string | null;
    agentName: string;
    /** Track asks the page to scroll to the region (a new `seq` per request); absent while you have taken over. */
    reveal?: Readonly<{ seq: number; behavior?: 'smooth' | 'instant' }>;
}>;
export type TrackReveal = Readonly<{ seq: number; path: string; behavior: 'smooth' | 'instant' }>;
const TrackPresenceContext = React.createContext<TrackPresence | null>(null);

/** File views and the tab strip report user intent; passive scroll/activation echoes are not input. */
export function TrackPauseSignalProvider(props: Readonly<{ signal: TrackPauseSignal; presence?: TrackPresence | null; children: React.ReactNode }>) {
    return <TrackPauseSignalContext.Provider value={props.signal}>
        <TrackPresenceContext.Provider value={props.presence ?? null}>{props.children}</TrackPresenceContext.Provider>
    </TrackPauseSignalContext.Provider>;
}

export function useTrackPauseSignal() {
    return React.useContext(TrackPauseSignalContext);
}

/** The agent's presence in the file `path`, or null when Track is not drawing it there. */
export function useTrackPresenceForPath(path: string): TrackPresence | null {
    const presence = React.useContext(TrackPresenceContext);
    return presence && presence.path === path ? presence : null;
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

/**
 * The presence's lines in the content the File page holds: the tool call's region, else where the text the edit
 * replaces sits now (its first occurrence). Null when neither places it; the tab dot and header still say so.
 */
export function resolveTrackPresenceLines(
    presence: TrackPresence,
    content: string | null | undefined,
): Readonly<{ startLine: number; endLine: number }> | null {
    if (presence.region) return { startLine: presence.region.startLine, endLine: presence.region.endLine };
    const anchor = presence.anchorText?.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    if (!anchor || typeof content !== 'string') return null;
    const text = content.replace(/\r\n/g, '\n');
    const at = text.indexOf(anchor);
    if (at < 0) return null;
    let startLine = 1;
    for (let index = text.indexOf('\n'); index !== -1 && index < at; index = text.indexOf('\n', index + 1)) startLine += 1;
    return { startLine, endLine: startLine + anchor.split('\n').length - 1 };
}
