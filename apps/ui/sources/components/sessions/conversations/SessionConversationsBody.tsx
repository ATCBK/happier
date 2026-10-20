import * as React from 'react';

import { DiscussionsList, type DiscussionsEmptyInvite } from '@/components/discussions/DiscussionsList';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export type SessionConversationsEmptyInvite = DiscussionsEmptyInvite;

/** People shows the canonical Home Discussions that link to this Session. */
export function SessionConversationsBody(props: Readonly<{
    address: SessionAddress;
    scope: ServerAccountScope;
    emptyInvite?: SessionConversationsEmptyInvite;
    /** Drawn after the conversations in the same scroller (People: Followers, Following). */
    footer?: React.ReactElement | null;
}>): React.ReactElement {
    const address = React.useMemo(() => ({ serverId: props.address.serverId }), [props.address.serverId]);
    const anchor = React.useMemo(() => ({ kind: 'session' as const, sessionId: props.address.sessionId }), [props.address.sessionId]);
    return <DiscussionsList address={address} scope={props.scope} anchor={anchor} emptyInvite={props.emptyInvite} footer={props.footer} />;
}
