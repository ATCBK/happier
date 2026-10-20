import { TriageEntryRefV1Schema, type TriageEntryRefV1 } from './identity.js';

/** The selected-entry segment shared by Triage pages and retained deep links. */
export function buildTriageEntryRouteSegmentV1(entryRef: TriageEntryRefV1): string {
    const { source, kindId, collisionScope, entryId } = entryRef;
    return ['e', source.pluginId, source.localId, kindId, collisionScope, entryId]
        .map(encodeURIComponent).join(',');
}

export function readTriageEntryRouteSegmentV1(segment: string): TriageEntryRefV1 | null {
    const [key, ...components] = segment.split(',');
    if (key !== 'e' || components.length !== 5) return null;
    try {
        const [pluginId, localId, kindId, collisionScope, entryId] = components.map(decodeURIComponent);
        const parsed = TriageEntryRefV1Schema.safeParse({
            source: { pluginId, localId }, kindId, collisionScope, entryId,
        });
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}
