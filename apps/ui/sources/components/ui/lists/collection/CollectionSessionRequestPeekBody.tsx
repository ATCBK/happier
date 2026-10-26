import * as React from 'react';
import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import { CollectionSessionRequestPeekData, type CollectionSessionRequestPeekState } from './CollectionSessionRequestPeekData';
import type { CollectionSessionRequestRef } from './collectionRequestRef';

/** The overlay supplies its state anatomy; requests keep the same complete forms and answer owners as Inbox. */
export function CollectionSessionRequestPeekBody(props: Readonly<{
    request: CollectionSessionRequestRef;
    open: boolean;
    onRetire?: () => void;
    renderState(state: Exclude<CollectionSessionRequestPeekState, { kind: 'current' }>): React.ReactNode;
}>): React.ReactNode {
    return <CollectionSessionRequestPeekData request={props.request} open={props.open} onRetire={props.onRetire}>
        {state => state.kind !== 'current' ? props.renderState(state) : props.request.kind === 'permission'
            ? <PermissionPromptCard request={state.request} location={null} sessionId={props.request.sessionId}
                serverId={props.request.serverId} metadata={state.metadata} canApprovePermissions={state.interaction.canApprovePermissions}
                disabledReason={state.interaction.permissionDisabledReason} chrome="inline" />
            : <UserActionPromptCard request={state.request} location={null} sessionId={props.request.sessionId}
                serverId={props.request.serverId} session={state.session} metadata={state.metadata}
                canApprovePermissions={state.interaction.canApprovePermissions}
                disabledReason={state.interaction.permissionDisabledReason} chrome="inline" />}
    </CollectionSessionRequestPeekData>;
}
