import * as React from 'react';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    getExistingSessionDraftProjection,
    subscribeSessionDraft,
    type ExistingSessionDraftProjection,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

function subscribeToNothing(): () => void {
    return () => undefined;
}

function readNoDraft(): ExistingSessionDraftProjection | null {
    return null;
}

function readListedDraft(scope: ServerAccountScope, sessionId: string): ExistingSessionDraftProjection | null {
    const projection = getExistingSessionDraftProjection(scope, sessionId);
    return projection?.listed ? projection : null;
}

/**
 * The listed draft of one session-list row, observed through that row's own draft address.
 *
 * Typing in a session changes only its row: the list never rebuilds for draft text. While the
 * surface is inactive the row keeps its last observed draft; a row whose first render is inactive
 * reads the current draft once without subscribing.
 */
export function useSessionListRowExistingDraft(input: Readonly<{
    activeScope: ServerAccountScope | null;
    serverId: string | null | undefined;
    sessionId: string;
    dataActive: boolean;
}>): ExistingSessionDraftProjection | null {
    const { activeScope, dataActive, serverId, sessionId } = input;
    // Drafts are kept for the active Account; rows of another Home have none here.
    const scope = activeScope && (!serverId || serverId === activeScope.serverId) ? activeScope : null;
    const subscribe = React.useMemo(() => {
        if (!dataActive || !scope) return subscribeToNothing;
        const address = { kind: 'session' as const, sessionId };
        return (listener: () => void) => subscribeSessionDraft(scope, address, listener);
    }, [dataActive, scope, sessionId]);
    const getSnapshot = React.useMemo(() => {
        if (!dataActive || !scope) return readNoDraft;
        return () => readListedDraft(scope, sessionId);
    }, [dataActive, scope, sessionId]);
    const liveDraft = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    // `undefined` means "never observed", which differs from "observed no draft".
    const frozenDraftRef = React.useRef<ExistingSessionDraftProjection | null | undefined>(undefined);
    if (dataActive) {
        frozenDraftRef.current = liveDraft;
    } else if (frozenDraftRef.current === undefined) {
        frozenDraftRef.current = scope ? readListedDraft(scope, sessionId) : null;
    }
    return dataActive ? liveDraft : frozenDraftRef.current ?? null;
}
