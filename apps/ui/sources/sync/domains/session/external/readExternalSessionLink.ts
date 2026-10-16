import {
    readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
    type LinkedExternalSessionV1,
} from '@happier-dev/protocol/sessions/external/linked-metadata';

export type ExternalSessionLink = LinkedExternalSessionV1;

// UI store metadata is immutable. Activity, list and row readers share this
// non-authoritative projection; replacing metadata re-enters Protocol admission.
// Weak keys keep retention bound to the lifetime of the actual input.
const parsedLinks = new WeakMap<object, ExternalSessionLink | null>();

export function readExternalSessionLink(metadata: unknown): ExternalSessionLink | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const cached = parsedLinks.get(metadata);
    if (cached !== undefined) return cached;
    const link = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
    parsedLinks.set(metadata, link);
    return link;
}
