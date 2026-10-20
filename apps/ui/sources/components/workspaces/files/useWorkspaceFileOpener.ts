import * as React from 'react';
import type { z } from 'zod/mini';
import type { WorkspaceFileOpenInput, WorkspaceFileTarget, WorkspaceFindSeedSchema } from '@happier-dev/protocol/actions/workspaceActionFamily';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { executeWorkspaceUiAction, openWorkspaceHrefOrElse } from '@/components/appShell/workspace/workspaceActionRuntime';
import { useWorkspaceFileNavigationCapabilities } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { useRouter, type Href } from 'expo-router';
import { resolveHref } from 'expo-router/build/link/href';
import type { FocusReturnRef } from '@/keyboard/focusReturn';
import { setTranscriptJumpHighlight, type TranscriptJumpHighlightRowIdentity } from '@/components/sessions/transcript/navigation/transcriptJumpHighlightStore';
import { useOptionalPaneFocusReturnOwner } from '@/components/appShell/panes/AppPaneProvider';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { areSessionAddressesEqual, normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type WorkspaceFileOpenTarget = WorkspaceFileTarget & Readonly<{ path: string }>;
export type WorkspaceFileOpenOrigin = Readonly<{
    focusReturnRef?: FocusReturnRef;
    transcript?: TranscriptJumpHighlightRowIdentity;
}>;
export type WorkspaceFileOpenOptions = Readonly<Pick<WorkspaceFileOpenInput, 'anchor' | 'anchorSource' | 'view' | 'blame' | 'changesScope'> & {
    intent?: 'preview' | 'pinned' | 'beside';
    find?: z.infer<typeof WorkspaceFindSeedSchema>;
    signal?: AbortSignal;
    origin?: WorkspaceFileOpenOrigin;
}>;
export type WorkspaceFileOpen = (target: WorkspaceFileOpenTarget, options?: WorkspaceFileOpenOptions) => Promise<boolean>;

/** Every file entry point enters the same Action policy and mounted navigation owner. */
export function useWorkspaceFileOpener() {
    const { canOpen, phone } = useWorkspaceFileNavigationCapabilities();
    const router = useRouter();
    const focusReturnOwner = useOptionalPaneFocusReturnOwner();
    const instance = React.useContext(DestinationInstanceContext);
    const instanceKey = instance?.tabId ?? null;
    const destinationNavigation = instance?.navigation;
    const openApproval = React.useCallback((href: Href) => {
        if (destinationNavigation) destinationNavigation.push(href);
        else fireAndForget(openWorkspaceHrefOrElse(resolveHref(href), () => router.push(href)), { tag: 'useWorkspaceFileOpener.openApproval' });
    }, [destinationNavigation, router]);
    const open = React.useCallback(async (target: WorkspaceFileOpenTarget, options?: WorkspaceFileOpenOptions): Promise<boolean> => {
        if (!canOpen || options?.signal?.aborted) return false;
        const { path, ...address } = target;
        const result = await executeWorkspaceUiAction({ actionId: 'workspace.tabs.open', input: {
            file: { target: address, path,
                ...(options?.anchor ? { anchor: options.anchor } : {}),
                ...(options?.anchorSource ? { anchorSource: options.anchorSource } : {}),
                ...(options?.view ? { view: options.view } : {}),
                ...(options?.blame === undefined ? {} : { blame: options.blame }),
                ...(options?.changesScope ? { changesScope: options.changesScope } : {}),
            },
            mode: options?.intent === 'beside' ? 'splitRight' : options?.intent === 'pinned' ? 'newTab' : 'preview',
            ...(options?.find ? { find: options.find } : {}),
        }, ...(options?.signal ? { signal: options.signal } : {}) }, openApproval);
        const opened = result.ok && !ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success;
        const origin = options?.origin;
        const transcript = origin?.transcript;
        // A transcript knows its exact retained instance. Cross-session/project callers
        // do not invent an instance or attach their focus to an unrelated destination.
        if (opened && origin && target.kind === 'session' && transcript?.sessionAddress
            && areSessionAddressesEqual(transcript.sessionAddress, normalizeSessionAddress(target.serverId, target.sessionId))) {
            const scopeId = createSessionPaneScopeId(target.sessionId, target.serverId, instanceKey);
            focusReturnOwner?.recordDetailsTabOrigin(scopeId, `file:${path}`, {
                focusReturnRef: origin.focusReturnRef,
                onReturn: kind => { if (kind === 'route') setTranscriptJumpHighlight(transcript); },
            }, phone ? 'route' : 'pane');
        }
        return opened;
    }, [canOpen, focusReturnOwner, instanceKey, openApproval, phone]);
    return React.useMemo(() => ({ open, canOpen }), [open, canOpen]);
}
