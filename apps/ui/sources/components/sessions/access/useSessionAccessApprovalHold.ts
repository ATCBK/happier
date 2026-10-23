import * as React from 'react';
import type { SessionAccessActionResultById } from '@happier-dev/plugin-sdk/actions';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';

import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { SessionAccessApprovalPendingError } from '@/sync/api/session/sessionAccessApi';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { presentSessionAccessApprovalSettlement } from './presentSessionAccessFailure';
import type { SessionAccessUiError } from './sessionAccessEditorTypes';

export type SessionAccessApprovalActionId =
    | 'session.access.grant.set'
    | 'session.access.grant.remove'
    | 'session.access.context.set'
    | 'session.access.encryption.prepare'
    | 'session.access.encryption.reprepare'
    | 'session.access.layout.update'
    | 'session.public_link.create'
    | 'session.public_link.remove';

const NO_APPROVAL_REFRESH = () => {};

/**
 * One mounted Session-access surface's hold on the change the canonical Action
 * policy routed to an approval Artifact.
 *
 * `sessionAccessApi` reports that routing as the family's typed
 * `SessionAccessApprovalPendingError`; this binds it to the shared continuation
 * owner (the Board's and the responsibility picker's) so the exact intent is
 * settled once from its Artifact. Nothing has committed while it is held, so the
 * surface renders it and accepts no further change, exactly like the Board.
 */
export function useSessionAccessApprovalHold(input: Readonly<{
    scopeKey: string;
    scope: ServerAccountScope;
}>) {
    const router = useDestinationRouter();
    const { scopeKey } = input;
    const { serverId, accountId } = input.scope;
    const approval = useActionApprovalContinuation({ scopeKey, serverId, onExecuted: NO_APPROVAL_REFRESH });
    const [pending, setPending] = React.useState<Readonly<{
        scopeKey: string; artifactId: string; serverId: string;
    }> | null>(null);
    const current = pending?.scopeKey === scopeKey ? pending : null;
    const heldRef = React.useRef(false);
    heldRef.current = current !== null || approval.approvalPending;
    const currentRef = React.useRef(current);
    currentRef.current = current;
    const requestApproval = approval.requestApproval;

    const hold = React.useCallback(<TActionId extends SessionAccessApprovalActionId>(
        routed: SessionAccessApprovalPendingError,
        actionId: TActionId,
        expectedInput: unknown,
        settle: Readonly<{
            isCurrent: () => boolean;
            onSucceeded: (value: SessionAccessActionResultById[TActionId]) => Promise<void>;
            /** `null` is the person's own decline or cancel: nothing changed. */
            onFailed: (issue: SessionAccessUiError | null) => void;
        }>,
    ) => {
        heldRef.current = true;
        setPending({ scopeKey, artifactId: routed.artifactId, serverId });
        requestApproval(createActionApprovalContinuation<SessionAccessActionResultById[TActionId], TActionId>({
            artifactId: routed.artifactId,
            actionId,
            scope: { serverId, accountId },
            expectedInput,
            onSucceeded: async (value) => {
                if (!settle.isCurrent()) return;
                setPending(null);
                await settle.onSucceeded(value);
            },
            onFailed: (code) => {
                if (!settle.isCurrent()) return;
                setPending(null);
                settle.onFailed(presentSessionAccessApprovalSettlement(code));
            },
        }));
    }, [accountId, requestApproval, scopeKey, serverId]);

    /** Opens the held approval where it is decided, like the responsibility row. */
    const openPendingApproval = React.useCallback(() => {
        const held = currentRef.current;
        if (!held) return;
        router.push(`/inbox/approvals/${encodeURIComponent(held.artifactId)}?serverId=${encodeURIComponent(held.serverId)}`);
    }, [router]);

    return {
        pendingApproval: current ? { artifactId: current.artifactId, serverId: current.serverId } : null,
        /** True from the moment an approval is routed until its continuation settles. */
        heldRef,
        hold,
        openPendingApproval,
    };
}
