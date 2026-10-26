import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { ApprovalDetailScreen } from '@/components/approvals/ApprovalDetailScreen';
import { WorkflowRunPane } from '@/components/workflows/run/WorkflowRunPane';
import { createWorkflowInvocationRoute, readWorkflowRunRouteTarget } from '@/sync/domains/workflows/workflowRunRoute';
import { CollectionRequestPeekScope } from './CollectionRequestPeekScope';
import { CollectionSessionRequestPeekBody } from './CollectionSessionRequestPeekBody';
import type { CollectionSessionRequestPeekState } from './CollectionSessionRequestPeekData';
import { collectionRequestRefKey, type CollectionRequestRef } from './collectionRequestRef';

export type CollectionRequestPeekBodyProps = Readonly<{
    request: CollectionRequestRef;
    open: boolean;
    onDismiss: () => void;
    onRetire?: () => void;
    renderState(state: Exclude<CollectionSessionRequestPeekState, { kind: 'current' }>): React.ReactNode;
}>;

/** Controlled content only. Popover/sheet, intent and focus remain with the collection's overlay owner. */
export function CollectionRequestPeekBody(props: CollectionRequestPeekBodyProps): React.ReactNode {
    const request = props.request;
    if (request.kind === 'permission' || request.kind === 'question') {
        return <CollectionSessionRequestPeekBody {...props} request={request} />;
    }
    return <CollectionRequestPeekScope request={request} open={props.open} onRetire={props.onRetire}>
        {state => state.kind !== 'current' ? props.renderState(state) : request.kind === 'approval'
            ? <ApprovalDetailScreen artifactId={request.artifactId} serverId={request.serverId} onBack={props.onDismiss} />
            : <WorkflowRequestBody request={request} onDismiss={props.onDismiss} />}
    </CollectionRequestPeekScope>;
}

function WorkflowRequestBody(props: Readonly<{
    request: Extract<CollectionRequestRef, { kind: 'workflow_hold' }>;
    onDismiss: () => void;
}>): React.ReactElement {
    const router = useRouter();
    const navigation = React.useMemo<DestinationNavigation>(() => ({
        push: href => router.push(href as Parameters<typeof router.push>[0]),
        replace: href => {
            const target = readWorkflowRunRouteTarget(href);
            if (target?.runId === props.request.runId && target.invocationId === null) props.onDismiss();
            else router.push(href as Parameters<typeof router.push>[0]);
        },
        back: props.onDismiss,
    }), [props.onDismiss, props.request.runId, router]);
    const request = props.request;
    return <WorkflowRunPane tabId={`collection-request:${collectionRequestRefKey(request)}`}
        runId={request.runId} serverId={request.serverId} invocationId={request.invocationRecordId}
        pathname={createWorkflowInvocationRoute(request.runId, request.invocationRecordId, request.serverId)}
        visible acknowledgeFailure={false} navigation={navigation} />;
}
