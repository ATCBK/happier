import * as React from 'react';
import type { TranscriptFindRowStore } from './transcriptFindRowStore';

const TranscriptFindContext = React.createContext<TranscriptFindRowStore | null>(null);
const TranscriptFindMessageContext = React.createContext<Readonly<{ messageId: string; routeMessageId: string | undefined }> | null>(null);
/** Height the floating inline Find capsule (and its note) covers at the top of the transcript; 0 when closed. */
const TranscriptFindClearanceContext = React.createContext(0);
const subscribeInactive = () => () => {};
const readInactive = () => null;

export function useTranscriptFindActive() {
    return React.useContext(TranscriptFindContext) !== null;
}

export function TranscriptFindProvider(props: Readonly<{ store: TranscriptFindRowStore; enabled?: boolean; clearancePx?: number; children: React.ReactNode }>) {
    return <TranscriptFindContext.Provider value={props.enabled === false ? null : props.store}>
        <TranscriptFindClearanceContext.Provider value={props.enabled === false ? 0 : props.clearancePx ?? 0}>{props.children}</TranscriptFindClearanceContext.Provider>
    </TranscriptFindContext.Provider>;
}

/** The transcript's top inset owner reads this so nothing at scroll-top sits under the open Find capsule. */
export function useTranscriptFindClearance() {
    return React.useContext(TranscriptFindClearanceContext);
}

/** Tool navigation uses a stable route ID; Find ranges belong to the original message row. */
export function TranscriptFindMessageProvider(props: Readonly<{ messageId: string; routeMessageId: string | undefined; children: React.ReactNode }>) {
    const value = React.useMemo(() => ({ messageId: props.messageId, routeMessageId: props.routeMessageId }), [props.messageId, props.routeMessageId]);
    return <TranscriptFindMessageContext.Provider value={value}>{props.children}</TranscriptFindMessageContext.Provider>;
}

export function useTranscriptFindRow(messageId: string | undefined) {
    const store = React.useContext(TranscriptFindContext);
    const message = React.useContext(TranscriptFindMessageContext);
    const rowId = message && messageId === message.routeMessageId ? message.messageId : messageId;
    const subscribe = React.useCallback((listener: () => void) => (
        store && rowId ? store.subscribe(rowId, listener) : subscribeInactive()
    ), [store, rowId]);
    const read = React.useCallback(() => store && rowId ? store.getSnapshot(rowId) : null, [store, rowId]);
    return React.useSyncExternalStore(store && rowId ? subscribe : subscribeInactive,
        store && rowId ? read : readInactive, readInactive);
}
