import * as React from 'react';

import { ScmStashDetailsCore } from '@/components/workspaces/scm/stash/ScmStashDetailsCore';
import type { ScmStashDetailsAdapter } from '@/components/workspaces/scm/stash/scmStashAdapter';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import {
    sessionScmRepositoryRemoveIndexLock,
    sessionScmStashApply,
    sessionScmStashDrop,
    sessionScmStashList,
    sessionScmStashPop,
    sessionScmStashShow,
} from '@/sync/ops';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

export type SessionScmStashDetailsViewProps = Readonly<{
    sessionId: string;
    serverId?: string;
    scopeId: string;
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
}>;

export const SessionScmStashDetailsView = React.memo((props: SessionScmStashDetailsViewProps) => {
    const machineTarget = readMachineTargetForSession(props.serverId
        ? { sessionId: props.sessionId, serverId: props.serverId }
        : props.sessionId);
    const repoPath = machineTarget?.basePath ?? null;
    const folderLabel = repoPath ? repoPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? null : null;
    const runStashMutation = React.useCallback(async <
        TResponse extends { success: boolean; error?: string; stderr?: string; errorCode?: string },
    >(operation: () => Promise<TResponse>): Promise<TResponse> => {
        const response = await operation();
        if (response.success || !repoPath) return response;
        return await runScmOperationWithGitIndexLockRecovery<TResponse, TResponse>({
            cwd: repoPath,
            failedResponse: response,
            removeIndexLock: (request) => sessionScmRepositoryRemoveIndexLock(props.sessionId, request, props.serverId),
            retryOriginalOperation: operation,
        });
    }, [props.serverId, props.sessionId, repoPath]);

    const adapter = React.useMemo<ScmStashDetailsAdapter>(() => ({
        list: () => sessionScmStashList(props.sessionId, {}, props.serverId),
        show: (stashRef) => sessionScmStashShow(props.sessionId, { stashRef }, props.serverId),
        pop: (stashRef, call) => runStashMutation(() => sessionScmStashPop(props.sessionId, { stashRef }, props.serverId, call)),
        drop: (stashRef, call) => runStashMutation(() => sessionScmStashDrop(props.sessionId, { stashRef }, props.serverId, call)),
        apply: (stashRef, call) => runStashMutation(() => sessionScmStashApply(props.sessionId, { stashRef }, props.serverId, call)),
    }), [props.serverId, props.sessionId, runStashMutation]);

    const handleAfterMutation = React.useCallback(async () => {
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId, props.serverId);
    }, [props.serverId, props.sessionId]);

    return (
        <ScmStashDetailsCore
            adapter={adapter}
            scopeResetKey={`session:${props.serverId ?? ''}:${props.sessionId}`}
            onAfterMutation={handleAfterMutation}
            restoreButtonTestId="scm-stash-restore-button"
            discardButtonTestId="scm-stash-discard-button"
            applyButtonTestId="scm-stash-apply-button"
            folderLabel={folderLabel}
            rootTestId="scm-stash-details-root"
            onOpenFile={props.onOpenFile}
            onOpenFilePinned={props.onOpenFilePinned}
        />
    );
});
