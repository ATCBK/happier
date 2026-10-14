import type { RegistryKindV1 } from '@happier-dev/protocol/registries';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { useRegistryActionRead } from './useRegistryActionRead';
import { useRegistrySourceRevision } from './useRegistrySourceRevision';

const parse = (value: unknown) => REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(value);
export function useRegistryItem(input: { kind: RegistryKindV1; sourceId: string; itemId: string; version?: string }) {
    const revision = useRegistrySourceRevision();
    const read = useRegistryActionRead('registries.items.read', input, parse, revision, Boolean(input.sourceId));
    return { item: read.value?.item ?? null, loading: read.loading, error: read.error, status: read.status, refresh: read.refresh };
}
