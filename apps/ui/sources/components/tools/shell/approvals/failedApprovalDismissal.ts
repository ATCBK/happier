import * as React from 'react';

import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { ResolvedPermissionPromptSurface } from '@/utils/sessions/permissions/permissionPromptPolicy';

/**
 * A failed approval stays in the composer until this device dismisses it. Dismissal is presentation only:
 * the approval is unchanged and nothing is sent anywhere, so it needs no confirmation.
 */
export function useFailedApprovalDismissal() {
    const dismissed = useLocalSetting('dismissedFailedApprovalsV1');
    const dismiss = React.useCallback((artifactId: string) => {
        getStorage().getState().applyLocalSettings({ dismissedFailedApprovalsV1: { ...dismissed, [artifactId]: Date.now() } }, { source: 'ui' });
    }, [dismissed]);
    return { dismissed, dismiss };
}

/** The composer's attention requests: every open approval, and each settled failure not yet dismissed here. */
export function useComposerApprovalRequests(
    requests: readonly OpenApprovalArtifactForSession[],
): readonly OpenApprovalArtifactForSession[] {
    const { dismissed } = useFailedApprovalDismissal();
    return React.useMemo(
        () => requests.filter(({ artifact, approval }) => approval.status === 'open' || dismissed[artifact.id] === undefined),
        [dismissed, requests],
    );
}

/** Surface preference moves only open approvals; settled failures remain composer attention. */
export function selectComposerApprovalRequestsForSurface(
    requests: readonly OpenApprovalArtifactForSession[],
    surface: ResolvedPermissionPromptSurface,
): readonly OpenApprovalArtifactForSession[] {
    return surface === 'composer'
        ? requests
        : requests.filter(({ approval }) => approval.status !== 'open');
}
