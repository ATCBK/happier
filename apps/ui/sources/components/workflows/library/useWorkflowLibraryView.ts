import * as React from 'react';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows';
import { isTerminalWorkflowRunState } from '@/components/work/status/resolveWorkStatusTone';
import { formatWorkflowDefinitionLibraryTitle } from '../presentation/workflowProblemPresentation';
import type { WorkflowLibraryDefinition } from './workflowLibraryReads';
import type { WorkflowLibraryRunSummary } from './useWorkflowLibrarySummaries';
import type { WorkflowLibraryView } from '@happier-dev/protocol/actions/scopeActionFamily';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { registerWorkflowLibraryScopeActionOwner } from '@/sync/ops/actions/scopeActionFamily';

export type { WorkflowLibraryView } from '@happier-dev/protocol/actions/scopeActionFamily';

export type WorkflowLibraryRow = Readonly<{
    key: string;
    group: 'library' | 'sharedWithYou';
    definition: WorkflowLibraryDefinition;
}> | Readonly<{ key: string; group: 'fromPlugins'; plugin: WorkflowPluginSourceV1 }>;
export const workflowLibraryRowTitle = (row: WorkflowLibraryRow) => row.group === 'fromPlugins'
    ? row.plugin.title : formatWorkflowDefinitionLibraryTitle(row.definition);

/** Attached triggers and the same summaries drawn by the run strips own membership. */
function resolveLibraryViews(rows: readonly WorkflowLibraryRow[], summaries: ReadonlyMap<string, WorkflowLibraryRunSummary> | null) {
    const triggered = new Set<string>();
    const running = new Set<string>();
    for (const row of rows) {
        if (row.group === 'fromPlugins') continue;
        if (row.definition.triggers.length > 0) triggered.add(row.key);
        if (summaries?.get(row.definition.definitionId)?.recent.some((run) => !isTerminalWorkflowRunState(run.state))) running.add(row.key);
    }
    const offered: WorkflowLibraryView[] = ['all', ...(triggered.size > 0 ? ['triggered' as const] : []), ...(running.size > 0 ? ['running' as const] : [])];
    return { offered, members: { triggered, running } };
}

export function useWorkflowLibraryView(rows: readonly WorkflowLibraryRow[], summaries: ReadonlyMap<string, WorkflowLibraryRunSummary> | null, focused: boolean) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const [state, setState] = React.useState(() => ({ lifetime, view: 'all' as WorkflowLibraryView, searchQuery: '' }));
    const { view, searchQuery } = state.lifetime === lifetime ? state : { view: 'all' as const, searchQuery: '' };
    const views = React.useMemo(() => resolveLibraryViews(rows, summaries), [rows, summaries]);
    const activeView = views.offered.includes(view) ? view : 'all';
    React.useEffect(() => {
        if (!views.offered.includes(view)) setState(current => current.lifetime === lifetime ? { ...current, view: 'all' } : current);
    }, [lifetime, view, views.offered]);
    const needle = searchQuery.trim().toLocaleLowerCase();
    const filter = React.useCallback((row: WorkflowLibraryRow) => (activeView === 'all' || views.members[activeView].has(row.key))
        && (needle.length === 0 || workflowLibraryRowTitle(row).toLocaleLowerCase().includes(needle)), [activeView, needle, views]);
    const visibleKeys = React.useMemo(() => rows.filter(filter).map(row => row.key), [rows, filter]);
    const update = React.useCallback((patch: Readonly<{ view?: WorkflowLibraryView; searchQuery?: string }>): boolean => {
        if (!lifetime?.isCurrent() || (patch.view !== undefined && !views.offered.includes(patch.view))) return false;
        setState(current => {
            const previous = current.lifetime === lifetime ? current : { lifetime, view: 'all' as const, searchQuery: '' };
            const next = { lifetime, view: patch.view ?? previous.view, searchQuery: patch.searchQuery ?? previous.searchQuery };
            return next.view === previous.view && next.searchQuery === previous.searchQuery ? previous : next;
        });
        return true;
    }, [lifetime, views.offered]);
    const setView = React.useCallback((view: WorkflowLibraryView) => { update({ view }); }, [update]);
    const setSearchQuery = React.useCallback((searchQuery: string) => { update({ searchQuery }); }, [update]);
    const controller = { lifetime, focused, view: activeView, searchQuery, offeredViews: views.offered, visibleKeys, filter, needle, update, setView, setSearchQuery };
    const latest = React.useRef(controller);
    React.useLayoutEffect(() => { latest.current = controller; });
    React.useEffect(() => focused && lifetime?.isCurrent()
        ? registerWorkflowLibraryScopeActionOwner(() => latest.current) : undefined, [focused, lifetime]);
    return controller;
}

export type WorkflowLibraryViewController = ReturnType<typeof useWorkflowLibraryView>;
