import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PluginUiExecutionOriginCandidateFacts } from '@/sync/domains/plugins/ui/projectionUnion';

export type AppShellPluginUiProjectionRead = Readonly<{ scope: ServerAccountScope; declarationsOnly: true }>;

// The app shell's committed plugin UI projection, readable outside React (Actions, settings normalization).
// AppShellPluginUiProjectionValueProvider publishes it. This module imports nothing at runtime, so declaration
// and Action modules can read the projection without importing the app shell.
let readCommitted: ((input?: AppShellPluginUiProjectionRead) => PluginUiProjectionModel | null) | null = null;
let readCommittedCandidates: ((pluginId: string, input?: AppShellPluginUiProjectionRead) => PluginUiExecutionOriginCandidateFacts | null) | null = null;
const listeners = new Set<() => void>();
const EMPTY_CANDIDATES: PluginUiExecutionOriginCandidateFacts = Object.freeze({
    establishingTargets: Object.freeze([]), sourceCandidates: Object.freeze([]),
    declaredDefaultOrigins: Object.freeze([]), machineRejections: Object.freeze([]), autoPick: true,
});

/** Descriptive facts only: the invocation owner still re-admits their exact origin on every access. */
export function readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId: string, input?: AppShellPluginUiProjectionRead): PluginUiExecutionOriginCandidateFacts {
    return readCommittedCandidates?.(pluginId, input) ?? EMPTY_CANDIDATES;
}

export function subscribeCommittedAppShellPluginUiProjection(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function readCurrentAppShellPluginUiProjection(input?: AppShellPluginUiProjectionRead): PluginUiProjectionModel | null {
    return readCommitted?.(input) ?? null;
}

/** Publishes the committed reader; the returned cleanup clears it only if it is still the current one. */
export function publishCommittedAppShellPluginUiProjection(
    read: (input?: AppShellPluginUiProjectionRead) => PluginUiProjectionModel | null,
    readCandidates?: (pluginId: string, input?: AppShellPluginUiProjectionRead) => PluginUiExecutionOriginCandidateFacts | null,
): () => void {
    readCommitted = read;
    readCommittedCandidates = readCandidates ?? null;
    for (const listener of listeners) listener();
    return () => {
        if (readCommitted !== read) return;
        readCommitted = null;
        readCommittedCandidates = null;
        for (const listener of listeners) listener();
    };
}
