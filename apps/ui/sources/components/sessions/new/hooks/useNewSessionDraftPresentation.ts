import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getSessionDraftSnapshot, subscribeSessionDraft, type SessionDraftSnapshot } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

type NewSessionDraftPresentation = Readonly<Pick<SessionDraftSnapshot, 'materialized' | 'status' | 'conflict'> & {
    launchUserAttemptId: string | null;
    authoringOrigin: NonNullable<SessionDraftSnapshot['localSupplement']['newSessionLocalState']>['authoringOrigin'];
}>;

/** Draft presentation above the editor is independent of the model's authoring inputs. */
export function useNewSessionDraftPresentation(scope: ServerAccountScope | null, draftId: string): NewSessionDraftPresentation | null {
    const address = React.useMemo(() => ({ kind: 'newSession' as const, draftId }), [draftId]);
    const subscribe = React.useCallback((listener: () => void) => (
        scope ? subscribeSessionDraft(scope, address, listener) : () => undefined
    ), [address, scope]);
    // The repository must publish real text edits to its editor. The surrounding
    // screen needs only chrome/custody facts, never that document or revision.
    const selectPresentation = useShallow((snapshot: SessionDraftSnapshot | null): NewSessionDraftPresentation | null => snapshot ? {
        materialized: snapshot.materialized,
        status: snapshot.status,
        conflict: snapshot.conflict,
        launchUserAttemptId: snapshot.localSupplement.launchUserAttemptId ?? null,
        authoringOrigin: snapshot.localSupplement.newSessionLocalState?.authoringOrigin,
    } : null);
    const getSnapshot = React.useCallback(() => selectPresentation(scope ? getSessionDraftSnapshot(scope, address) : null), [address, scope, selectPresentation]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
