import * as React from 'react';
import { projectAccountProviderCatalogCountsV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';

import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { useProviderCatalogForServer } from '@/sync/store/useProviderCatalog';

/** Counts follow the Account catalog; selecting a machine cannot change their meaning. */
export function useProviderCatalogCounts(serverId: string | null) {
    const catalog = useProviderCatalogForServer(serverId);
    return React.useMemo(() => catalog?.data
        ? projectAccountProviderCatalogCountsV1({ catalog: catalog.data, definitions: readAccountProviderDeclarations() })
        : null, [catalog?.data]);
}
