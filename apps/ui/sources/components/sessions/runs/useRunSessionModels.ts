import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionSelector } from '@/sync/store/hooks';

import type { RunSessionModels } from './resolveExecutionRunSelectionLabel';

/**
 * The Session's own Agent and model list, for naming a Run model before any Machine catalog arrives.
 * Selects only those two stored references, so Session activity does not rerender the caller.
 */
export function useRunSessionModels(sessionId: string | undefined, serverId: string | null | undefined): RunSessionModels | undefined {
    const source = useSessionSelector(sessionId ?? '', serverId, useShallow(session => (session ? {
        agentId: readSessionPresentationAgentId(session),
        metadata: session.composerOptionsInput === undefined ? readSessionOwnerMetadataView(session) : session.composerOptionsInput,
    } : { agentId: null, metadata: null })));
    const { agentId, metadata } = source;
    return React.useMemo(() => (agentId ? { agentId, metadata } : undefined), [agentId, metadata]);
}
