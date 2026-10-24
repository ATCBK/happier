import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ConnectedAccountCatalogKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { observeConnectedAccountCatalog } from '@/sync/engine/settings/connectedAccountCatalogEngine';
import { getConnectedAccountCatalogValue, subscribeConnectedAccountCatalogSnapshots } from './connectedAccountCatalogSnapshot';

const noSubscription = () => () => {};

export function useConnectedAccountCatalog<K extends ConnectedAccountCatalogKeyV1>(key: K, requestedScope?: ServerAccountScope | null,
    options?: Readonly<{ sourceMachineId?: string | null; enabled?: boolean }>) {
    const activeScope = useActiveServerAccountScope();
    const scope = requestedScope === undefined ? activeScope : requestedScope;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const sourceMachineId = key === 'purposes' ? options?.sourceMachineId?.trim() || undefined : undefined;
    const enabled = options?.enabled !== false;
    useEffect(() => enabled && serverId && accountId ? observeConnectedAccountCatalog({ serverId, accountId }, key, { sourceMachineId }) : undefined,
        [serverId, accountId, key, sourceMachineId, enabled]);
    const read = useCallback(() => getConnectedAccountCatalogValue(
        serverId && accountId ? { serverId, accountId } : null, key), [serverId, accountId, key]);
    return useSyncExternalStore(enabled ? subscribeConnectedAccountCatalogSnapshots : noSubscription, read, read);
}
