import * as React from 'react';

import { ScmCommitsView, type ScmCommitsViewProps } from './ScmCommitsView';
import { useSessionCommitPlan } from './useSessionCommitPlan';
import type { ScmWalkthroughRestorationProps } from '../walkthrough/useSessionScmWalkthrough';

export type SessionCommitsViewProps = Omit<ScmCommitsViewProps, 'plan'> & Readonly<{
    sessionId: string;
    serverId?: string | null;
    /** Hands the person to the authorized Session composer. */
    onOpenComposer?: () => void;
}> & ScmWalkthroughRestorationProps;

/** Session authority and composer remain in the Session adapter; presentation is shared with Project. */
export const SessionCommitsView = React.memo(function SessionCommitsView(props: SessionCommitsViewProps) {
    const plan = useSessionCommitPlan({ sessionId: props.sessionId, serverId: props.serverId, enabled: props.active !== false,
        branch: props.branch, restoration: props.restoreState === undefined ? undefined : {
            restoreState: props.restoreState, retryRestore: props.retryRestore, machineReachability: props.machineReachability,
        },
        ...(props.onOpenComposer ? { onOpenComposer: props.onOpenComposer } : {}) });
    return <ScmCommitsView {...props} plan={plan} />;
});
