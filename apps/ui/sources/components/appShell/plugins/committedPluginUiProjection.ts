import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type AppShellPluginUiProjectionRead = Readonly<{ scope: ServerAccountScope; declarationsOnly: true }>;

// The app shell's committed plugin UI projection, readable outside React (Actions, settings normalization).
// AppShellPluginUiProjectionValueProvider publishes it. This module imports nothing at runtime, so declaration
// and Action modules can read the projection without importing the app shell.
let readCommitted: ((input?: AppShellPluginUiProjectionRead) => PluginUiProjectionModel | null) | null = null;

export function readCurrentAppShellPluginUiProjection(input?: AppShellPluginUiProjectionRead): PluginUiProjectionModel | null {
    return readCommitted?.(input) ?? null;
}

/** Publishes the committed reader; the returned cleanup clears it only if it is still the current one. */
export function publishCommittedAppShellPluginUiProjection(read: (input?: AppShellPluginUiProjectionRead) => PluginUiProjectionModel | null): () => void {
    readCommitted = read;
    return () => { if (readCommitted === read) readCommitted = null; };
}
