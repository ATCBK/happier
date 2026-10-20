import * as React from 'react';
import {
    usePluginCollectionQuery,
    usePluginUiDataClientOrNull,
    useSurfaceContext,
    usePluginHostApi,
    usePluginHostReadiness,
    usePluginUiEphemeralSharedScope,
    type PluginUiEphemeralSharedScope,
    type PluginUiCollectionQueryResult,
} from '@happier-dev/plugin-ui';

import { CORPUS_SESSION_LINKS_COLLECTION } from '../../corpus/collections/definitions.js';
import { fromCorpusStoredRow } from '../../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../../corpus/collections/rows.js';
import { useTriageListWindow } from '../../ui/window/useTriageListWindow.js';
import { resolveTriageSourceWorkflowSubjectV1, hasTriageSourceSessionRelationsV1 } from '../../ui/detail/sourceSurface.js';
import { TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, TriageReadSourceSessionLinksResultV1Schema, type TriageSourceSessionLinksLaneV1 } from '../../actions/sessionLinksProtocol.js';
import type { TriageSourceSessionLinkV1 } from '../sourceSessionRelations.js';
import { renderSourceQualifiedId } from '../../corpus/identity/components.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';
import {
    TRIAGE_SESSION_LINKED_ENTRIES_COLLECTION_ID_V1,
    TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1,
    triageSessionLinkedEntriesParameters,
} from './linkedEntriesQuery.js';
import {
    projectTriageSessionLinkedEntries,
    triageSessionLinkHydrationTargets,
    type TriageSessionLinkedEntriesFailureCodeV1,
    type TriageSessionLinkHydrationMapV1,
    type TriageSessionLinkHydrationV1,
    type TriageSessionLinkQueryRowV1,
    type TriageSessionLinkedEntriesQueryStateV1,
    type TriageSessionLinkedEntriesViewV1,
} from './linkedEntryRows.js';

/**
 * The cockpit's one data consumer.
 *
 * Two tiers, both incumbent, and nothing else. The declared static UI query is
 * opened through the Data-owned pager, which keeps query validation, cursor
 * continuation, AccountChange wakeups, last-known-good rows and Account
 * currentness; the private half of each link row — the display path a linked row
 * is actually rendered from — is read through the same mount's Data client by
 * the host-stamped `rowId` the pager already returned.
 *
 * This is the one paged read transport into the Account Collection. The
 * neighboring Unlink control uses the same mount's direct Collection handle,
 * so both read and write remain available when the Account is reachable but a
 * daemon is not; neither path recreates provider execution in UI.
 *
 * It owns no poll, timer, watch cursor, provider request, source refresh,
 * Message scan, second entry store or alternate freshness decision.
 */

const EMPTY_HYDRATION: TriageSessionLinkHydrationMapV1 = Object.freeze(new Map());

const TYPED_QUERY_FAILURE_CODES: ReadonlySet<string> = new Set<TriageSessionLinkedEntriesFailureCodeV1>([
    'collection_query_invalid',
    'collection_cursor_invalid',
    'collection_unavailable',
    'collection_index_not_ready',
    'collection_content_mode_mismatch',
    'collection_contract_inconsistent',
]);

/**
 * The pager's failure surfaces as either the Data-owned typed error or a thrown
 * `Error` from opening it. Only the typed code carries a distinguishable
 * meaning; anything else is reported as the honest generic failure.
 */
function readFailureCode(
    error: PluginUiCollectionQueryResult['error'],
): TriageSessionLinkedEntriesFailureCodeV1 | null {
    if (error === undefined || error instanceof Error) return null;
    return TYPED_QUERY_FAILURE_CODES.has(error.error) ? error.error : null;
}

function toQueryRows(
    rows: PluginUiCollectionQueryResult['rows'],
): readonly TriageSessionLinkQueryRowV1[] {
    return rows.map((row) => Object.freeze({
        rowId: row.context.rowId,
        revision: row.context.revision,
        fields: row.fields,
    }));
}

/**
 * Same-plugin private hydration for the exact bounded page.
 *
 * One read per rendered row per revision, and never one per render: a settled
 * read is retained until the pager reports that row at a different revision, and
 * rows that leave the page leave the map with them. A refused read becomes a
 * stated row state rather than a retry loop. Explicit refresh invalidates only
 * failed reads, including when the query revision has not changed.
 */
function useLinkHydration(
    rows: readonly TriageSessionLinkQueryRowV1[],
): Readonly<{ hydration: TriageSessionLinkHydrationMapV1; retryUnreadable: () => void }> {
    const client = usePluginUiDataClientOrNull();
    const [hydration, setHydration] = React.useState<TriageSessionLinkHydrationMapV1>(EMPTY_HYDRATION);

    React.useEffect(() => {
        const wanted = new Map(rows.map((row) => [row.rowId, row.revision]));

        // The one invalidation owner. A row that left the page, and a row the
        // pager now reports at a different revision, both leave the map here —
        // so the map is bounded by the page rather than by how long this Session
        // stayed open, and "what is still known" is not decided twice.
        setHydration((previous) => {
            let changed = false;
            const next = new Map<string, TriageSessionLinkHydrationV1>();
            for (const [rowId, known] of previous) {
                if (wanted.get(rowId) === known.revision) next.set(rowId, known);
                else changed = true;
            }
            return changed ? Object.freeze(next) : previous;
        });

        const missing = rows.filter((row) => !hydration.has(row.rowId));
        if (missing.length === 0 || client === null) return;

        const links = client.collection(CORPUS_SESSION_LINKS_COLLECTION);
        const controller = new AbortController();
        let retired = false;

        void (async () => {
            const settled = await Promise.all(missing.map(
                async (row): Promise<readonly [string, TriageSessionLinkHydrationV1]> => {
                    try {
                        const stored = await links.get(row.rowId, { signal: controller.signal });
                        if (stored === null) return [row.rowId, { kind: 'unlinked', revision: row.revision }];
                        const value = fromCorpusStoredRow<CorpusSessionLinkRowV1>(stored).value;
                        return [row.rowId, {
                            kind: 'ready',
                            revision: row.revision,
                            displayPath: value.displayPathAtLink,
                            // The reference the link was written from, passed on
                            // untouched: Unlink addresses the row derived from
                            // exactly this value and the mounted Session.
                            entryRef: value.entryRef,
                        }];
                    } catch {
                        return [row.rowId, { kind: 'unreadable', revision: row.revision }];
                    }
                },
            ));
            if (retired) return;
            setHydration((previous) => {
                const next = new Map(previous);
                for (const [rowId, known] of settled) {
                    // A row the page has since dropped is not adopted back in.
                    if (wanted.get(rowId) === known.revision) next.set(rowId, known);
                }
                return Object.freeze(next);
            });
        })();

        return () => {
            retired = true;
            controller.abort();
        };
    }, [client, hydration, rows]);

    const retryUnreadable = React.useCallback(() => {
        setHydration((previous) => {
            if (![...previous.values()].some((known) => known.kind === 'unreadable')) return previous;
            return new Map([...previous].filter(([, known]) => known.kind !== 'unreadable'));
        });
    }, []);

    return { hydration, retryUnreadable };
}

export type TriageSessionLinkedEntriesV1 = Readonly<{
    view: TriageSessionLinkedEntriesViewV1;
    /** Re-reads the current page through the Data pager; reaches no provider. */
    refresh: () => Promise<void>;
    /** Appends the Data pager's next retained page; owns no cursor here. */
    loadMore: () => Promise<void>;
}>;

/**
 * Read one exact Session's linked entries.
 *
 * `sessionId` is the host-stamped mounted target and nothing else. It is never a
 * launch input, a route value, a title lookup, the active or focused Session, or
 * a value read out of a Message.
 */
export function useTriageSessionLinkedEntries(sessionId: string): TriageSessionLinkedEntriesV1 {
    // Reading the existing retained window does not demand a source pass.
    const window = useTriageListWindow();
    const { targetedContributions } = useSurfaceContext();
    const host = usePluginHostApi();
    const owner = usePluginUiEphemeralSharedScope();
    const sourceReadAvailable = hasTriageSourceSessionRelationsV1(targetedContributions);
    // The relation aggregate is Account-owned; nested source roles admit their
    // own placement and retain per-source unavailable coverage.
    const readiness = usePluginHostReadiness(false);
    const [sourceRead, setSourceRead] = React.useState<Readonly<{
        owner: PluginUiEphemeralSharedScope | null; sessionId: string;
        status: 'absent' | 'loading' | 'ready' | 'partial' | 'failed'; links: readonly TriageSourceSessionLinkV1[];
        lanes?: readonly TriageSourceSessionLinksLaneV1[];
    }>>({ owner, sessionId, status: sourceReadAvailable ? 'loading' : 'absent', links: [] });
    const [sourceRefresh, setSourceRefresh] = React.useState(0);
    React.useEffect(() => {
        const controller = new AbortController();
        if (!sourceReadAvailable) {
            setSourceRead((previous) => previous.owner === owner && previous.sessionId === sessionId && previous.status !== 'absent'
                ? { ...previous, status: 'failed' } : { owner, sessionId, status: 'absent', links: [] });
            return () => controller.abort();
        }
        setSourceRead((previous) => previous.owner === owner && previous.sessionId === sessionId
            ? { ...previous, status: 'loading' } : { owner, sessionId, status: 'loading', links: [] });
        if (readiness.pending) return () => controller.abort();
        void (async () => {
            try {
                const result = TriageReadSourceSessionLinksResultV1Schema.parse(await host.executeAction(
                    TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, { v: 1, sessionId }, { signal: controller.signal },
                ));
                if (controller.signal.aborted) return;
                setSourceRead((previous) => {
                    const unavailable = result.lanes === undefined ? null : new Set(result.lanes
                        .filter((lane) => lane.health.kind !== 'complete').map((lane) => renderSourceQualifiedId(lane.source)));
                    const retained = previous.owner === owner && previous.sessionId === sessionId
                        ? previous.links.filter((link) => unavailable === null || unavailable.has(renderSourceQualifiedId(link.entryRef.source))) : [];
                    return { owner, sessionId, status: result.kind === 'complete' ? 'ready' : result.kind, lanes: result.lanes,
                        links: result.kind === 'complete' ? result.links : [...new Map([
                            ...retained, ...result.links,
                        ].map((link) => [triageEntryRowKey(link.entryRef), link])).values()] };
                });
            } catch {
                if (!controller.signal.aborted) setSourceRead((previous) => ({ owner, sessionId, status: 'failed',
                    links: previous.owner === owner && previous.sessionId === sessionId ? previous.links : [] }));
            }
        })();
        return () => controller.abort();
    }, [host, owner, readiness.pending, readiness.revision, sessionId, sourceReadAvailable, sourceRefresh]);
    const parameters = React.useMemo(
        () => triageSessionLinkedEntriesParameters(sessionId),
        [sessionId],
    );
    const query = usePluginCollectionQuery(
        TRIAGE_SESSION_LINKED_ENTRIES_COLLECTION_ID_V1,
        TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1,
        parameters,
    );

    const queryState = React.useMemo<TriageSessionLinkedEntriesQueryStateV1>(() => Object.freeze({
        status: query.status,
        rows: toQueryRows(query.rows),
        hasMore: query.hasMore,
        failure: readFailureCode(query.error),
    }), [query.error, query.hasMore, query.rows, query.status]);

    const targets = React.useMemo(
        () => triageSessionLinkHydrationTargets(queryState),
        [queryState],
    );
    const { hydration, retryUnreadable } = useLinkHydration(targets);
    const refresh = React.useCallback(async () => {
        retryUnreadable();
        setSourceRefresh((value) => value + 1);
        await query.refresh();
    }, [query.refresh, retryUnreadable]);

    const view = React.useMemo(
        () => projectTriageSessionLinkedEntries({ query: queryState, hydration, entries: window.snapshot.window?.rows,
            sourceLinks: sourceRead.owner === owner && sourceRead.sessionId === sessionId ? sourceRead.links : [],
            sourceLinksStatus: sourceRead.owner === owner && sourceRead.sessionId === sessionId
                ? sourceRead.status === 'absent' ? 'ready' : sourceRead.status : 'loading',
            sourceLanes: sourceRead.owner === owner && sourceRead.sessionId === sessionId ? sourceRead.lanes : undefined,
            workflowSubject: (entryRef) => resolveTriageSourceWorkflowSubjectV1(targetedContributions, entryRef) }),
        [hydration, queryState, targetedContributions, window.snapshot.window?.rows, sourceRead, sessionId, owner],
    );

    return React.useMemo(
        () => Object.freeze({ view, refresh, loadMore: query.loadMore }),
        [query.loadMore, refresh, view],
    );
}
