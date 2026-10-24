import { useEffect, useMemo } from 'react';
import { usePluginHostApi, usePluginUiEphemeralSharedScope, useSurfaceContext } from '@happier-dev/plugin-ui';

import { TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { projectTriageListWindow } from '../../ui/window/mountedWindow.js';
import { useTriageListWindow } from '../../ui/window/useTriageListWindow.js';
import { useTriageListWindowViewDemand } from '../../ui/window/useTriageListWindowViewDemand.js';
import { resolveTriageSourceWorkflowSubjectV1 } from '../../ui/detail/sourceSurface.js';
import { useTriageSessionLinkedEntries } from './useSessionLinkedEntries.js';
import {
    projectTriageSessionLinkedEntryCandidates,
    type TriageSessionLinkedEntryCandidateV1,
} from './linkedEntrySearch.js';

export { linkTriageSessionEntry } from './linkedEntrySearch.js';

export type TriageSessionLinkCandidatesV1 = Readonly<{
    candidates: readonly TriageSessionLinkedEntryCandidateV1[];
    status: 'loading' | 'ready' | 'unavailable';
}>;

const NO_CANDIDATES: readonly TriageSessionLinkedEntryCandidateV1[] = Object.freeze([]);

/**
 * Mount this only while the link picker is open. Search projects the incumbent
 * retained acquisition through its default lens without changing the page's
 * lens. An open picker is a view of that one list window, so it sends the
 * window's own paced view demand: a Session opened before PRs & Issues still
 * gets entries to pick, and a recently read window is not read again (the
 * window owns pacing). Session links are read through their existing Account
 * pager; finish that relation before claiming an entry is not linked,
 * including links beyond page one.
 */
export function useTriageSessionLinkCandidates(
    sessionId: string,
    query: string,
): TriageSessionLinkCandidatesV1 {
    const host = usePluginHostApi();
    const scope = usePluginUiEphemeralSharedScope();
    const window = useTriageListWindow();
    const { targetedContributions } = useSurfaceContext();
    const links = useTriageSessionLinkedEntries(sessionId);
    const view = links.view;
    useTriageListWindowViewDemand(true, window.refresh, window.readiness, window.readOwner);

    useEffect(() => {
        if (view.kind === 'linked' && view.more && view.notice === null) {
            void links.loadMore();
        }
    }, [links.loadMore, view]);

    return useMemo(() => {
        const entries = projectTriageListWindow(TRIAGE_LIST_DEFAULT_LENS_V1, host, scope);
        const readingLinks = view.kind === 'loading'
            || (view.kind === 'linked' && (view.more || view.rows.some((row) => row.presentation.kind === 'reading')));
        if (readingLinks || (entries === undefined && window.snapshot.pending === 'initial')) {
            return Object.freeze({ candidates: NO_CANDIDATES, status: 'loading' });
        }
        if ((entries === undefined && window.snapshot.error !== undefined)
            || view.kind === 'unavailable'
            || (view.kind === 'linked' && (view.notice !== null || view.rows.some((row) => row.presentation.kind === 'unreadable')))) {
            return Object.freeze({ candidates: NO_CANDIDATES, status: 'unavailable' });
        }
        // PRs & Issues has read nothing on this mount yet: that is no candidates, not an unreadable link set.
        if (entries === undefined) return Object.freeze({ candidates: NO_CANDIDATES, status: 'ready' });
        const linked = view.kind === 'linked' ? view.rows.flatMap((row) => (
            row.presentation.kind === 'linked' ? [row.presentation.entryRef] : []
        )) : [];
        return Object.freeze({
            candidates: projectTriageSessionLinkedEntryCandidates(entries.rows, query, linked,
                (entryRef) => resolveTriageSourceWorkflowSubjectV1(targetedContributions, entryRef)),
            status: 'ready',
        });
    }, [host, query, scope, targetedContributions, view, window.snapshot]);
}
