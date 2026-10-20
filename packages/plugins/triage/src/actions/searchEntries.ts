import {
    computeCanonicalDomainSeparatedDigest,
    PluginError,
} from '@happier-dev/plugin-sdk';
import type {
    PluginClientActionHandler,
} from '@happier-dev/plugin-sdk/actions';
import type {
    PluginClientApi,
    PluginSearchItemV1,
    PluginSearchQueryV1,
    PluginSearchResultV1,
} from '@happier-dev/plugin-sdk';

import { entryReferenceComponents } from '../corpus/identity/components.js';
import { TRIAGE_SEARCH_ENTRIES_ACTION_LOCAL_ID_V1 } from './searchEntriesProtocol.js';
import { buildTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import { TRIAGE_APP_PAGE_LOCAL_ID_V1 } from '../composer/openEntryDetails.js';
import {
    MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
    TRIAGE_LIST_DEFAULT_LENS_V1,
    type TriageListRowV1,
    type TriageListWindowV1,
} from '../projection/listWindow.js';
import { projectTriageEntryDisplay, readTriageEntryGlyphV1 } from '../ui/window/entryDisplay.js';
import { resolveTriageSourceWorkflowSubjectV1 } from '../ui/detail/sourceSurface.js';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import {
    acquireTriageListWindow,
    projectTriageListWindow,
    readTriageListWindowSnapshot,
    refreshTriageListWindow,
} from '../ui/window/mountedWindow.js';

/**
 * The Universal Search query Action.
 *
 * It is deliberately a SECOND Action over the SAME retained acquisition, not a
 * second search. The heavyweight list contract carries lenses, facets, lane
 * health, coverage, per-connection observations and paging frontiers; none of
 * that is the bounded `{ query, limit } → { items, truncated }` DTO the
 * universal surface speaks. This client Action therefore acquires the existing
 * Account/plugin/generation window, cold-refreshes it only when absent, and
 * projects its retained observations through the same matcher, fold, `smart`
 * order and display owner used by the list and Composer picker.
 *
 * Activation is the incumbent open owner: every row carries an `openSurface`
 * command for the one Triage app-page destination, holding the exact strict
 * launch input `openTriageEntryDetails` would have built. There is no second
 * navigation path, and the host never learns a Triage route.
 */

const TRIAGE_SEARCH_RESULT_ID_DOMAIN_V1 = 'happier:triage:search-result-id:v1';

function deriveTriageSearchResultId(row: TriageListRowV1): string {
    return computeCanonicalDomainSeparatedDigest(
        TRIAGE_SEARCH_RESULT_ID_DOMAIN_V1,
        entryReferenceComponents(row.entryRef),
    );
}

/**
 * A row with no selectable connection is omitted rather than shown.
 *
 * Its entry is real, but nothing can be opened under it: the detail page
 * addresses one exact connection, and choosing one for the reader would open a
 * different provider's answer than the row describes. An unopenable row in a
 * search result is worse than an absent one.
 */
function toSearchItem(
    row: TriageListRowV1,
    targetedContributions: SurfaceContext['targetedContributions'],
): readonly PluginSearchItemV1[] {
    if (row.selected.kind !== 'selected') return [];
    const display = projectTriageEntryDisplay(row);
    return [{
        id: deriveTriageSearchResultId(row),
        title: display.title,
        subtitle: [display.scopeLabel, ...(display.designation ? [display.designation] : [])].join(' · '),
        icon: readTriageEntryGlyphV1(display.lifecyclePresentation, resolveTriageSourceWorkflowSubjectV1(targetedContributions, row.entryRef)),
        command: {
            kind: 'openSurface',
            destination: TRIAGE_APP_PAGE_LOCAL_ID_V1,
            input: buildTriageEntryDetailLaunchInput({
                entryRef: row.entryRef,
                sourceInstance: {
                    source: row.entryRef.source,
                    sourceInstanceId: row.selected.sourceInstanceId,
                },
            }),
            // The destination's host-owned page root. The opened page's own
            // location writer replaces it with the canonical entry encoding.
            subPath: '',
        },
    }];
}

async function waitForRefreshOrAbort(
    refresh: Promise<void>,
    signal: AbortSignal,
): Promise<void> {
    if (signal.aborted) throw new PluginError({ code: 'plugin_action_aborted' });
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (settle: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            settle();
        };
        const onAbort = () => finish(() => reject(new PluginError({ code: 'plugin_action_aborted' })));
        signal.addEventListener('abort', onAbort, { once: true });
        refresh.then(
            () => finish(resolve),
            (error) => finish(() => reject(error)),
        );
    });
}

export function searchTriageEntries(
    input: PluginSearchQueryV1,
    window: TriageListWindowV1,
    targetedContributions: SurfaceContext['targetedContributions'],
): PluginSearchResultV1 {
    const limit = Math.max(1, Math.min(input.limit, MAX_TRIAGE_LIST_WINDOW_ROWS_V1));
    const openableItems = window.rows.flatMap(row => toSearchItem(row, targetedContributions));
    const items = openableItems.slice(0, limit);
    return {
        items,
        // Honest bounding: a window whose lanes have not all exhausted has more
        // to give, and an openable row cut by the bound is one the reader has
        // not seen.
        truncated: window.coverage !== 'complete'
            || openableItems.length > items.length,
    };
}

/**
 * The registered handler. It binds the owner above to the invocation context
 * exactly as the list Action does, and adds no dispatch, cache or registry.
 */
export function createTriageSearchEntriesActionHandler(): PluginClientActionHandler<
    PluginSearchQueryV1,
    PluginSearchResultV1
> {
    return async (input, context) => {
        const scope = context.ephemeralSharedScope;
        if (scope === null) {
            throw new PluginError({ code: 'plugin_ephemeral_shared_scope_unavailable' });
        }
        const host = context.ui;
        const lease = acquireTriageListWindow(host, scope);
        try {
            if (context.signal.aborted) {
                throw new PluginError({ code: 'plugin_action_aborted' });
            }
            if (readTriageListWindowSnapshot(host, scope).window === undefined) {
                await waitForRefreshOrAbort(
                    refreshTriageListWindow('view', host, scope),
                    context.signal,
                );
            }
            if (context.signal.aborted) {
                throw new PluginError({ code: 'plugin_action_aborted' });
            }
            const limit = Math.max(1, Math.min(input.limit, MAX_TRIAGE_LIST_WINDOW_ROWS_V1));
            const window = projectTriageListWindow({
                ...TRIAGE_LIST_DEFAULT_LENS_V1,
                query: input.query,
                order: 'smart',
                limit,
            }, host, scope);
            if (window === undefined) {
                // The shared acquisition owns the failure. Never infer a missing
                // folder from Search's selected Session: this window is Account-scoped.
                const code = readTriageListWindowSnapshot(host, scope).error?.code;
                return {
                    items: [],
                    truncated: false,
                    failure: { code: code === 'root_not_found' || code === 'ROOT_NOT_FOUND'
                        ? 'root_not_found'
                        : code === 'auth_required' ? 'auth_required' : 'unavailable' },
                };
            }
            const { targetedContributions } = await context.ui.context({ signal: context.signal });
            if (context.signal.aborted) throw new PluginError({ code: 'plugin_action_aborted' });
            return searchTriageEntries(input, window, targetedContributions ?? undefined);
        } finally {
            lease.release();
        }
    };
}

export function activate(api: PluginClientApi): void {
    api.actions.register(TRIAGE_SEARCH_ENTRIES_ACTION_LOCAL_ID_V1, createTriageSearchEntriesActionHandler());
}
