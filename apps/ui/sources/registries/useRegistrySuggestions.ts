import { Platform } from 'react-native';
import {
    HAPPIER_PICKS_SOURCE_ID, REGISTRY_FORMAT_ADAPTERS_V1, resolveRegistryFetchPlanV1,
    type RegistryFormatAdapterV1, type RegistryKindV1,
} from '@happier-dev/protocol/registries';
import { useRegistryItems } from './useRegistryItems';
import { useRegistrySources } from './useRegistrySources';
import * as React from 'react';

const EMPTY_ITEMS: ReturnType<typeof useRegistryItems>['items'] = [];

/** Homepage recommendations share registry Actions and their Account-scoped memo.
 * Only a direct built-in first page may replace an empty curated shelf. */
export function useRegistrySuggestions(kind: RegistryKindV1) {
    const sources = useRegistrySources(kind);
    const picksSource = sources.sources.find(source => source.id === HAPPIER_PICKS_SOURCE_ID && source.enabled);
    const picks = useRegistryItems({ kind, sourceIds: [HAPPIER_PICKS_SOURCE_ID] }, picksSource !== undefined);
    const fallbackSource = sources.sources.find(source => {
        if (!source.enabled || source.id === HAPPIER_PICKS_SOURCE_ID || source.origin.kind !== 'built_in') return false;
        const adapter = (REGISTRY_FORMAT_ADAPTERS_V1 as Partial<Record<typeof source.format, RegistryFormatAdapterV1>>)[source.format];
        return adapter && resolveRegistryFetchPlanV1({ host: Platform.OS === 'web' ? 'web' : 'native', source, adapter, op: 'list' })
            .every(placement => placement === 'direct');
    });
    const hasPicks = picksSource !== undefined && picks.items.length > 0;
    const fallback = useRegistryItems({ kind, sourceIds: fallbackSource ? [fallbackSource.id] : [] },
        sources.hasValue && !sources.loading && (!picksSource || !picks.loading && !hasPicks) && fallbackSource !== undefined);
    const refresh = React.useCallback(async () => { await Promise.all([sources.refresh(), picks.refresh(), fallback.refresh()]); },
        [sources.refresh, picks.refresh, fallback.refresh]);
    return {
        items: hasPicks ? picks.items : fallbackSource ? fallback.items : EMPTY_ITEMS,
        loading: sources.loading || picksSource !== undefined && picks.loading || fallbackSource !== undefined && fallback.loading,
        sourceId: hasPicks ? HAPPIER_PICKS_SOURCE_ID : fallbackSource?.id ?? null,
        refresh,
    };
}
