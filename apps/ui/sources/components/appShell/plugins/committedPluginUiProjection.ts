import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

// The app shell's committed plugin UI projection, readable outside React (Actions, settings normalization).
// AppShellPluginUiProjectionValueProvider publishes it. This module imports nothing at runtime, so declaration
// and Action modules can read the projection without importing the app shell.
let readCommitted: (() => PluginUiProjectionModel | null) | null = null;

export function readCurrentAppShellPluginUiProjection(): PluginUiProjectionModel | null {
    return readCommitted?.() ?? null;
}

/** Publishes the committed reader; the returned cleanup clears it only if it is still the current one. */
export function publishCommittedAppShellPluginUiProjection(read: () => PluginUiProjectionModel | null): () => void {
    readCommitted = read;
    return () => { if (readCommitted === read) readCommitted = null; };
}
