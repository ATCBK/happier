import * as React from 'react';

import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    getSessionDraftSnapshot,
    readSessionScmDraftFromDraft,
    subscribeSessionDraft,
    writeExistingSessionDraft,
    type SessionScmDraft,
    type SessionScmPullRequestDraftV1,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

const EMPTY: SessionScmDraft = Object.freeze({ commitMessage: '', pullRequest: null });

/**
 * The Git pane's drafts (the commit message and the new pull request form), kept on the session's one draft
 * owner so every placement of a form — the sidebar, a Details pane, another device — reads and writes the same
 * value. `available` is false while the Home's account is not bound; writes are then dropped, never rerouted.
 */
export function useSessionScmDraft(input: Readonly<{ sessionId: string; serverId?: string | null }>): Readonly<{
    available: boolean;
    draft: SessionScmDraft;
    setCommitMessage: (value: string) => void;
    setPullRequest: (value: SessionScmPullRequestDraftV1 | null | ((current: SessionScmPullRequestDraftV1 | null) => SessionScmPullRequestDraftV1 | null)) => void;
}> {
    const binding = useServerCredentialAccountScopeBinding(input.serverId).binding;
    const scope = binding?.isCurrent() ? binding.scope : null;
    const address = React.useMemo(() => ({ kind: 'session' as const, sessionId: input.sessionId }), [input.sessionId]);
    const subscribe = React.useCallback(
        (listener: () => void) => (scope ? subscribeSessionDraft(scope, address, listener) : () => undefined),
        [address, scope],
    );
    const lastRef = React.useRef<{ document: unknown; draft: SessionScmDraft }>({ document: null, draft: EMPTY });
    const read = React.useCallback((): SessionScmDraft => {
        if (!scope) return EMPTY;
        const document = getSessionDraftSnapshot(scope, address)?.document ?? null;
        if (lastRef.current.document === document) return lastRef.current.draft;
        const next = readSessionScmDraftFromDraft(document);
        const previous = lastRef.current.draft;
        // Keep the reference while the values are equal, so unrelated composer edits do not re-render the form.
        const draft = previous.commitMessage === next.commitMessage && samePullRequest(previous.pullRequest, next.pullRequest)
            ? previous
            : next;
        lastRef.current = { document, draft };
        return draft;
    }, [address, scope]);
    const draft = React.useSyncExternalStore(subscribe, read, read);

    const setCommitMessage = React.useCallback((value: string) => {
        if (!scope) return;
        writeExistingSessionDraft({ scope, sessionId: address.sessionId, patch: { scmCommitMessageV1: value } });
    }, [address.sessionId, scope]);
    const setPullRequest = React.useCallback((value: SessionScmPullRequestDraftV1 | null | ((current: SessionScmPullRequestDraftV1 | null) => SessionScmPullRequestDraftV1 | null)) => {
        if (!scope) return;
        const current = readSessionScmDraftFromDraft(getSessionDraftSnapshot(scope, address)?.document).pullRequest;
        const next = typeof value === 'function' ? value(current) : value;
        if (current === next) return;
        writeExistingSessionDraft({ scope, sessionId: address.sessionId, patch: { scmPullRequestV1: next } });
    }, [address, scope]);

    return React.useMemo(
        () => ({ available: scope !== null, draft, setCommitMessage, setPullRequest }),
        [draft, scope, setCommitMessage, setPullRequest],
    );
}

function samePullRequest(left: SessionScmPullRequestDraftV1 | null, right: SessionScmPullRequestDraftV1 | null): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    const leftAttempt = left.bodyDraft?.attempt;
    const rightAttempt = right.bodyDraft?.attempt;
    return left.title === right.title && left.body === right.body && left.draft === right.draft && left.base === right.base
        && left.bodyDraft?.key === right.bodyDraft?.key && left.bodyDraft?.candidate === right.bodyDraft?.candidate
        && leftAttempt?.bodyAtRequest === rightAttempt?.bodyAtRequest && leftAttempt?.baselineResultId === rightAttempt?.baselineResultId
        && leftAttempt?.baselineRevision === rightAttempt?.baselineRevision && leftAttempt?.started === rightAttempt?.started
        && leftAttempt?.resultId === rightAttempt?.resultId;
}
