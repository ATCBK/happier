import type { SessionMcpSelectionV1 } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';

import type { Metadata } from '@happier-dev/session-core/state';

export function computeNextSessionMcpSelectionMetadata(
    metadata: Metadata,
    selection: SessionMcpSelectionV1,
    options: Readonly<{ sessionActive: boolean }> = { sessionActive: false },
): Metadata {
    const {
        mcpSelection: _legacyMcpSelection,
        ...canonicalMetadata
    } = metadata as Metadata & {
        mcpSelection?: unknown;
    };
    return writeSessionCapabilitySelectionToMetadataV1(canonicalMetadata, { mcp: selection }, options);
}
