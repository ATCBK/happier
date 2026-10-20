import * as React from 'react';

export type MarkdownLiveValueStore = Readonly<{
    get(): string;
    subscribe(listener: () => void): () => void;
}>;

const subscribeToNothing = () => () => {};

/** The Markdown leaf reads ref-backed file text without rerendering its page. */
export function useMarkdownLiveValue(value: string, liveValue?: MarkdownLiveValueStore, active = true): string {
    const getSnapshot = React.useCallback(() => liveValue ? liveValue.get() : value, [liveValue, value]);
    return React.useSyncExternalStore(active && liveValue ? liveValue.subscribe : subscribeToNothing, getSnapshot, getSnapshot);
}
