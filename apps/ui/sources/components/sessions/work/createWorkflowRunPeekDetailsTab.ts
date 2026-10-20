import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';

export const WORKFLOW_RUN_PEEK_DETAILS_TAB_KIND = 'workflowRunPeek';

export type WorkflowRunPeekDetailsResource = Readonly<{
    kind: typeof WORKFLOW_RUN_PEEK_DETAILS_TAB_KIND;
    runId: string;
    /** The lead's exact Home, kept so the peek and its "Open run" address the same Run. */
    serverId: string | null;
}>;

/** The peek of a workflow run the lead started (ORC §3.8): FIN's run page body beside the lead. */
export function createWorkflowRunPeekDetailsTab(params: Readonly<{
    runId: string;
    serverId: string | null;
    title: string;
}>): DetailsTab {
    return {
        key: `${WORKFLOW_RUN_PEEK_DETAILS_TAB_KIND}:${params.runId}`,
        kind: WORKFLOW_RUN_PEEK_DETAILS_TAB_KIND,
        title: params.title,
        subtitle: null,
        resource: {
            kind: WORKFLOW_RUN_PEEK_DETAILS_TAB_KIND,
            runId: params.runId,
            serverId: params.serverId,
        } satisfies WorkflowRunPeekDetailsResource,
    };
}

export function isWorkflowRunPeekDetailsResource(value: unknown): value is WorkflowRunPeekDetailsResource {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as { kind?: unknown; runId?: unknown; serverId?: unknown };
    return candidate.kind === WORKFLOW_RUN_PEEK_DETAILS_TAB_KIND
        && typeof candidate.runId === 'string'
        && candidate.runId.trim().length > 0
        && (candidate.serverId === null || typeof candidate.serverId === 'string');
}
