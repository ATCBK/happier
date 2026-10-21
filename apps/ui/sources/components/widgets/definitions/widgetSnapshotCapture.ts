import * as React from 'react';
import type { PluginDeclarativeDataNodeV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDataV1';
import type { projectWidgetSnapshotPreviewV1 } from '@happier-dev/protocol/widgets';

/**
 * What a mounted declarative widget is showing right now, for Post a snapshot: its document and the
 * frozen node each live read is drawing, by document path. `current` is false while any read is
 * refreshing, stale or failed — a snapshot posts current numbers or nothing.
 */
export type WidgetSnapshotCapture = Readonly<{
    document: Parameters<typeof projectWidgetSnapshotPreviewV1>[0]['document'];
    frozenByPath: ReadonlyMap<string, PluginDeclarativeDataNodeV1>;
    /** The read identities shown, for the snapshot's provenance. */
    digests: readonly string[];
    /** Exact admitted read, independent of its latest value/digest or freshness. */
    readIdentity: string | object;
    /** False when the read owner withdraws disclosure, even if a preview was already frozen. */
    readAuthorized: boolean;
    current: boolean;
    /** Reads every shown read again (the card's own Retry), so a not-current card can become current. */
    refresh: () => Promise<unknown>;
}>;

/** What a mounted document registers: how to read what it shows, and when that changes. */
export type WidgetSnapshotCaptureSource = Readonly<{
    read: () => WidgetSnapshotCapture | null;
    subscribe: (listener: () => void) => () => void;
}>;

/**
 * The card's one capture slot: the mounted document registers how to read what it shows; the card's
 * ⋯ asks only when the person opens Post a snapshot. Nothing is copied or re-read before that.
 */
export type WidgetSnapshotCaptureSlot = Readonly<{
    register: (source: WidgetSnapshotCaptureSource) => () => void;
    capture: () => WidgetSnapshotCapture | null;
    /** What the mounted card shows changed (a read finished refreshing); the open confirm re-reads it. */
    watch: (listener: () => void) => () => void;
    /** Whether a live declarative body is mounted in this card at all. */
    subscribe: (listener: () => void) => () => void;
    isAvailable: () => boolean;
}>;

export function createWidgetSnapshotCaptureSlot(): WidgetSnapshotCaptureSlot {
    let source: WidgetSnapshotCaptureSource | null = null;
    const listeners = new Set<() => void>();
    const watchers = new Set<() => void>();
    const emit = () => { for (const listener of listeners) listener(); };
    const changed = () => { for (const watcher of watchers) watcher(); };
    return {
        register(next) {
            source = next;
            const unsubscribe = next.subscribe(changed);
            emit();
            changed();
            return () => {
                unsubscribe();
                if (source === next) { source = null; emit(); changed(); }
            };
        },
        capture: () => source?.read() ?? null,
        watch(watcher) { watchers.add(watcher); return () => { watchers.delete(watcher); }; },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        isAvailable: () => source !== null,
    };
}

export const WidgetSnapshotCaptureContext = React.createContext<WidgetSnapshotCaptureSlot | null>(null);

/** One registration owner for authored and installed declarative render trees. */
export function useDeclarativeWidgetSnapshotCapture(
    read: WidgetSnapshotCaptureSource['read'] | null,
    subscribe?: WidgetSnapshotCaptureSource['subscribe'],
): void {
    const slot = React.useContext(WidgetSnapshotCaptureContext);
    const reader = React.useRef(read);
    const changed = React.useRef<(() => void) | null>(null);
    const available = read !== null;
    // A new shown value updates the same mounted source. Unregistering it on
    // every render would briefly remove Post snapshot from its parent menu.
    React.useLayoutEffect(() => {
        reader.current = read;
        changed.current?.();
    }, [read]);
    React.useEffect(() => {
        if (!slot || !available) return;
        return slot.register({
            read: () => reader.current?.() ?? null,
            subscribe: listener => {
                changed.current = listener;
                const stop = subscribe?.(listener);
                return () => { stop?.(); changed.current = null; };
            },
        });
    }, [slot, available, subscribe]);
}

export function useWidgetSnapshotCaptureAvailable(slot: WidgetSnapshotCaptureSlot): boolean {
    return React.useSyncExternalStore(slot.subscribe, slot.isAvailable, slot.isAvailable);
}
