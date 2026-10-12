import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createInvocationSavedSecretOperationContextV1, refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliMcpServerStoreForOperation } from '@/settings/mcp/mcpServerStore';

export function createExecutionRunAccountSettingsSnapshotResolver(input: Readonly<{
    machineId: string;
    serverHttpBaseUrl: string;
    readCredentials: () => Promise<StoredCredentials | null>;
    isOwnerCurrent: () => boolean;
    onSettings: (settings: Awaited<ReturnType<typeof bootstrapAccountSettingsContext>>['settings'] | null) => void;
}>) {
    return async (demand?: Readonly<{ mcpServerCatalog?: boolean; savedSecretReferences?: readonly import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationReferenceV1[]; signal?: AbortSignal }>) => runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => {
        demand?.signal?.throwIfAborted();
        const unavailable = () => {
            input.onSettings(null);
            return createProviderErrorV1('provider_authorization_changed', { machineId: input.machineId });
        };
        const credentials = await input.readCredentials();
        if (!credentials) throw unavailable();
        const isCurrent = async () => input.isOwnerCurrent()
            && sameStoredCredentials(credentials, await input.readCredentials())
            && input.isOwnerCurrent();
        const snapshot = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', publication: 'invocation',
            honorAccountSettingsModeEnv: false, shouldCommit: input.isOwnerCurrent });
        if (!await isCurrent()) throw unavailable();
        const operation = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
            serverHttpBaseUrl: input.serverHttpBaseUrl, isCurrent });
        if (!await operation.isCurrent()) throw unavailable();
        const catalog = demand?.mcpServerCatalog
            ? await createCliMcpServerStoreForOperation({ operationContext: operation, signal: demand.signal }).readCatalogForOperation()
            : undefined;
        if (demand?.savedSecretReferences?.length && snapshot.scopeKey) {
            await refreshSavedSecretCatalogForOperation({ expectedScopeKey: snapshot.scopeKey,
                references: demand.savedSecretReferences, operationContext: operation, signal: demand.signal });
        }
        demand?.signal?.throwIfAborted();
        if (!await operation.isCurrent()) throw unavailable();
        const admitted = operation.readSnapshot();
        if (!admitted) throw unavailable();
        input.onSettings(admitted.settings);
        return catalog ? { ...admitted, mcpServerCatalog: catalog } : admitted;
    });
}
