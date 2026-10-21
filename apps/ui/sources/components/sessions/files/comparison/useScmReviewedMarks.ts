import * as React from 'react';
import type { ScmComparison, ScmReviewedMarksRecord, ScmReviewedMarksSelection, ScmReviewedMarksSource } from '@happier-dev/protocol';
import { buildScmReviewScopeId } from '@happier-dev/protocol/scm/comparisonOccurrences';

import { useOptionalAuth } from '@/auth/context/AuthContext';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureAccountEncryptionObservationForHome } from '@/sync/http/accountEncryptionObservationBinding';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { createScmReviewedMarksOperations } from '@/sync/ops/scmDiffSummary/reviewedMarks';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';

export type ScmReviewedMarks = Readonly<{
    record: ScmReviewedMarksRecord | null;
    /** Null while marks can be written; otherwise why not (no account, another Home, unreadable record). */
    unavailableReason: string | null;
    setReviewed: (refs: readonly string[], reviewed: boolean) => void;
    setReviewedKeys: (keys: readonly string[], reviewed: boolean) => void;
    clear: () => void;
}>;

const UNAVAILABLE: ScmReviewedMarks = { record: null, unavailableReason: 'reviewed_marks_unavailable', setReviewed: () => {}, setReviewedKeys: () => {}, clear: () => {} };

/**
 * The person's explicit marks for one content scope, bound to the mounted view and the signed-in
 * Account on the active Home (account KV through its existing per-key CAS and prefix push). The
 * operations retire with the view, the Account or the Home; nothing is marked except on intent.
 */
export function useScmReviewedMarks(params: Readonly<{
    comparison: ScmComparison | null; source?: ScmReviewedMarksSource; serverId: string | null;
    host: ScmDiffSummaryHost | null;
}>): ScmReviewedMarks {
    const credentials = useOptionalAuth()?.credentials ?? null;
    const server = useActiveServerSnapshot(credentials !== null);
    const selection: ScmReviewedMarksSelection | null = params.comparison ? { comparison: params.comparison }
        : params.source ? { source: params.source } : null;
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    const scopeId = selection ? buildScmReviewScopeId(selection.comparison
        ? { repositoryRootPath: selection.comparison.repository.rootPath, source: selection.comparison.source } : selection.source) : null;
    const sameHome = params.serverId === null || params.serverId === server.serverId;
    const [published, setPublished] = React.useState<Readonly<{
        scopeId: string; credentials: typeof credentials; serverId: typeof server.serverId;
        serverUrl: typeof server.serverUrl; generation: number; current: () => boolean; marks: ScmReviewedMarks;
    }> | null>(null);

    React.useEffect(() => {
        const selected = selectionRef.current;
        if (!selected || !scopeId || !credentials || !sameHome || !server.serverUrl || !server.serverId) {
            setPublished(null);
            return;
        }
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || lifetime.scope.serverId !== server.serverId) {
            setPublished(null);
            return;
        }
        const carrier = getActiveServerHomeCarrier();
        let stopped = false;
        const shouldContinue = () => {
            const current = getActiveServerSnapshot();
            return !stopped && lifetime.isCurrent() && current.serverId === server.serverId
                && current.serverUrl === server.serverUrl && current.generation === server.generation
                && getActiveServerHomeCarrier() === carrier;
        };
        const accountEncryptionObservation = captureAccountEncryptionObservationForHome({
            serverId: server.serverId,
            endpointUrl: server.serverUrl,
            credentials,
            isCurrent: shouldContinue,
        });
        const request = createServerFetchAtEndpoint({
            endpointUrl: server.serverUrl,
            serverId: server.serverId,
            ...(server.runtimeOrigin ? { runtimeOrigin: server.runtimeOrigin } : {}),
            ...(carrier ? { homeCarrier: carrier } : {}),
            credentials,
            isCurrent: shouldContinue,
            ...(accountEncryptionObservation ? { accountEncryptionObservation } : {}),
        });
        const operations = createScmReviewedMarksOperations({ ...selected, credentials, request, shouldContinue,
            getSelection: () => {
                const current = selectionRef.current;
                if (!current) throw new Error('The displayed review scope is unavailable');
                return current;
            },
        });
        const setReviewed = (refs: readonly string[], reviewed: boolean) => { void operations.setReviewed(refs, reviewed); };
        const setReviewedKeys = (keys: readonly string[], reviewed: boolean) => { void operations.setReviewedKeys(keys, reviewed); };
        const clear = () => { void operations.clear(); };
        const publish = () => {
            const snapshot = operations.getSnapshot();
            setPublished({ scopeId, credentials, serverId: server.serverId, serverUrl: server.serverUrl, generation: server.generation,
                current: shouldContinue, marks: {
                record: snapshot.status === 'ready' ? snapshot.record : null,
                unavailableReason: snapshot.status === 'ready' || snapshot.status === 'idle' ? null : snapshot.errorCode ?? 'reviewed_marks_unavailable',
                setReviewed,
                setReviewedKeys,
                clear,
            } });
        };
        const unsubscribe = operations.subscribe(publish);
        publish();
        void operations.read().catch(() => { /* the snapshot carries the typed failure */ });
        return () => {
            stopped = true;
            unsubscribe();
            operations.retire();
        };
        // Evidence changes update the intent ref; only scope or Account/Home changes retire observation.
    }, [scopeId, credentials, sameHome, server.generation, server.runtimeOrigin, server.serverId, server.serverUrl]);

    return published && sameHome && published.scopeId === scopeId && published.credentials === credentials
        && published.serverId === server.serverId && published.serverUrl === server.serverUrl
        && published.generation === server.generation && published.current() ? published.marks : UNAVAILABLE;
}
