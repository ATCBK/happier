import * as React from 'react';

import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import {
    getExistingSessionDraftProjection,
    subscribeSessionDraft,
    writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { ReviewDraftSummaryProps } from './ReviewDraftSummary';
import { sendReviewForChanges } from './sendReviewForChanges';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

/**
 * Review's Ask-for-changes composer (SG, Q3): the session's own draft, read and written through the
 * draft repository (one draft owner, so the main composer shows the same text), sent through the one
 * session send path. `null` while the Home's account is not bound, so the tray hands off instead.
 */
export function useReviewAskComposer(input: Readonly<{
    sessionId: string;
    serverId?: string | null;
    drafts: readonly ReviewCommentDraft[];
    reviewScope: WorkspaceScopeBase | null;
    deleteDraft: (commentId: string) => void;
    handOffToComposer: () => void;
}>): ReviewDraftSummaryProps['composer'] {
    const binding = useServerCredentialAccountScopeBinding(input.serverId).binding;
    const scope = binding?.isCurrent() ? binding.scope : null;
    const address = React.useMemo(() => ({ kind: 'session' as const, sessionId: input.sessionId }), [input.sessionId]);
    const subscribe = React.useCallback(
        (listener: () => void) => (scope ? subscribeSessionDraft(scope, address, listener) : () => undefined),
        [address, scope],
    );
    const readText = React.useCallback(
        () => (scope ? getExistingSessionDraftProjection(scope, input.sessionId)?.text ?? '' : ''),
        [input.sessionId, scope],
    );
    const text = React.useSyncExternalStore(subscribe, readText, readText);
    const [sending, setSending] = React.useState(false);
    const presented = useLayoutPresentationActive();
    const requestRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        setSending(false);
        return () => {
            requestRef.current?.abort();
            requestRef.current = null;
        };
    }, [binding, input.sessionId, presented]);

    const latestRef = React.useRef(input);
    latestRef.current = input;
    const onChangeText = React.useCallback((next: string) => {
        if (!scope) return;
        writeExistingSessionDraft({ scope, sessionId: latestRef.current.sessionId, patch: { text: next } });
    }, [scope]);
    const onSend = React.useCallback(() => {
        if (!binding || sending || !presented) return;
        const current = latestRef.current;
        const request = new AbortController();
        requestRef.current = request;
        setSending(true);
        void sendReviewForChanges({
            sessionId: current.sessionId,
            serverId: current.serverId,
            accountLifetime: binding,
            drafts: current.drafts,
            reviewScope: current.reviewScope,
            signal: request.signal,
            clearSentDrafts: (sent) => { for (const draft of sent) current.deleteDraft(draft.id); },
        }).then((outcome) => {
            if (request.signal.aborted) return;
            if (outcome === 'handoff') current.handOffToComposer();
            if (outcome === 'failed') Modal.alert(t('common.error'), t('errors.failedToSendMessage'));
        }).finally(() => {
            if (requestRef.current !== request) return;
            requestRef.current = null;
            setSending(false);
        });
    }, [binding, presented, sending]);

    return React.useMemo(
        () => (scope ? { text, onChangeText, onSend, sending } : null),
        [onChangeText, onSend, scope, sending, text],
    );
}
