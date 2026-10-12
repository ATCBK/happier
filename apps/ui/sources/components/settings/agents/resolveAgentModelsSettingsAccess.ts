import type { ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

export type AgentModelsSettingsAccess = Readonly<{
    readable: boolean;
    writable: boolean;
}>;

export function resolveAgentModelsSettingsAccess(snapshot: Readonly<{ status: 'loading' | 'ready' | 'partial' | 'unavailable'; data: ProviderConnectionsCatalogV1 | null; stale?: boolean }> | null): AgentModelsSettingsAccess {
    return {
        // The catalog owner retains admitted data through transient refresh failures,
        // and withdraws it for authorization, encryption and invalid-content failures.
        readable: snapshot?.data !== null && snapshot?.data !== undefined,
        writable: snapshot?.status === 'ready' && snapshot.data !== null && !snapshot.stale,
    };
}
