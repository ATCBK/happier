import type { ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveQualifiedConnectedServiceRegistryEntry } from './resolveConnectedServiceDisplayName';

/** Exact qualified identity to the existing mark owner's alias; unknown services keep its neutral glyph. */
export function resolveQualifiedConnectedServiceMarkId(
    registry: Pick<ConnectedServiceRegistrySnapshot, 'entries'>,
    service: Readonly<{ pluginId: string; localId: string }>,
): string | null {
    return resolveQualifiedConnectedServiceRegistryEntry(registry, service)?.legacyServiceId ?? null;
}
