import {
    resolveAgentIdFromSessionMetadata,
    resolveAgentIdFromFlavor,
} from '@happier-dev/agents';
import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    StoredSessionSharedMetadataV1Schema,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readExternalSessionLink, type ExternalSessionLink } from '../external/readExternalSessionLink';

type SessionPresentationAgentIdInput = Readonly<{
    metadataLayoutVersion?: number;
    metadata?: unknown;
    ownerMetadataView?: unknown;
    accessLevel?: unknown;
}>;

export function readSessionPresentationAgentId(
    session: SessionPresentationAgentIdInput,
    admittedLinkedSession?: ExternalSessionLink | null,
): string | null {
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
    if (metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1) {
        const sharedMetadata = StoredSessionSharedMetadataV1Schema.safeParse(session.metadata);
        const sharedAgentId = sharedMetadata.success
            ? sharedMetadata.data.agentPresentation?.agentId
            : null;
        return sharedAgentId ?? null;
    }
    if (metadataLayoutVersion !== 0) {
        return null;
    }
    // Legacy Agent identity is Session-readable even when the producer withholds a full owner view.
    return resolveAgentIdFromSessionMetadata(session.metadata ?? null,
        admittedLinkedSession === undefined ? readExternalSessionLink(session.metadata) : admittedLinkedSession);
}

/** Full Sessions and compact rows share presentation without reinterpreting a projected identity. */
export function readSessionRowPresentationAgentId(
    session: SessionPresentationAgentIdInput,
): string | null {
    if ('agentState' in session) return readSessionPresentationAgentId(session);
    const layout = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
    if (layout !== 0 && layout !== SESSION_METADATA_LAYOUT_VERSION_V1) return null;
    const metadata = session.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const flavor = Reflect.get(metadata, 'flavor');
    const agentId = typeof flavor === 'string' ? flavor.trim() : '';
    // Compact flavor is the resolved identity, including contributed ids. Older cache rows
    // may retain bundled aliases; normalize those without guessing identity from raw metadata.
    return agentId ? resolveAgentIdFromFlavor(agentId) ?? agentId : null;
}
