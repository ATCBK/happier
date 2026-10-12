import * as React from 'react';
import { readPendingCapabilityApplyV1, readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';

/** The metadata read half; U5 adds machine-derived items/timing and the canonical Actions write path. */
export function useSessionCapabilities(sessionId: string, sessionMetadata: unknown) {
    return React.useMemo(() => ({ sessionId,
        selection: readSessionCapabilitySelectionFromMetadataV1(sessionMetadata),
        pendingApply: readPendingCapabilityApplyV1(sessionMetadata),
    }), [sessionId, sessionMetadata]);
}
