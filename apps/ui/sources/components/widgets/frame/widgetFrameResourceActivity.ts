import * as React from 'react';
import type { PluginUiResourceEntry, PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';

/**
 * How long a refresh runs before the header says so in words. A refresh with last-known content is
 * healthy work: until it has lasted this long the header shows the quiet glyph alone, so a read that
 * returns at once never puts a sentence in the header.
 */
export const WIDGET_FRAME_REFRESH_WORD_DELAY_MS = 1000;

/** True once `active` has held for `delayMs` without a break; drops the moment it ends. */
export function useHeldFor(active: boolean, delayMs: number): boolean {
    const [held, setHeld] = React.useState(false);
    React.useEffect(() => {
        if (!active) { setHeld(false); return; }
        const timer = setTimeout(() => setHeld(true), delayMs);
        return () => clearTimeout(timer);
    }, [active, delayMs]);
    return held;
}

// Header projection only: Resource stores remain the owners of pending work and cancellation.
export const WidgetFrameResourceActivityContext = React.createContext<((key: symbol, refreshing: boolean) => void) | null>(null);

/** Lend the actual body's Resource pending fact to its nearest shared frame, without another read. */
export function useWidgetFrameResourceActivity(refreshing: boolean): void {
    const report = React.useContext(WidgetFrameResourceActivityContext);
    const [key] = React.useState(() => Symbol('resource'));
    React.useEffect(() => {
        report?.(key, refreshing);
        return () => report?.(key, false);
    }, [key, refreshing, report]);
}

/** Native hooks lend their existing consumer subscription's fact; this facade adds no observer or demand. */
export function useWidgetFrameResourceStoreActivity(store: PluginUiResourceStore | undefined): PluginUiResourceStore | undefined {
    const report = React.useContext(WidgetFrameResourceActivityContext);
    return React.useMemo(() => {
        if (!store || !report) return store;
        const observed: PluginUiResourceStore = {
            getEntry(resource) {
                const entry = store.getEntry(resource);
                const reported: PluginUiResourceEntry = {
                    ...entry,
                    subscribe(listener, live) {
                        const key = Symbol('native-resource');
                        let subscribed = true;
                        const publish = () => {
                            if (!subscribed) return;
                            report(key, entry.getSnapshot().pending === 'refresh');
                            listener();
                        };
                        const release = entry.subscribe(publish, live);
                        report(key, entry.getSnapshot().pending === 'refresh');
                        return () => {
                            subscribed = false;
                            release();
                            report(key, false);
                        };
                    },
                };
                return Object.freeze(reported);
            },
            dispose: () => store.dispose(),
        };
        return Object.freeze(observed);
    }, [report, store]);
}
