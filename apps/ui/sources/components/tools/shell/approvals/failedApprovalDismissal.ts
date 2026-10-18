import * as React from 'react';

import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';

/**
 * A failed approval stays in the composer until this device dismisses it. Dismissal is presentation only:
 * the approval is unchanged and nothing is sent anywhere, so it needs no confirmation.
 */
export function useFailedApprovalDismissal() {
    const [dismissed, setDismissed] = useLocalSettingMutable('dismissedFailedApprovalsV1');
    const dismiss = React.useCallback((artifactId: string) => {
        setDismissed({ ...dismissed, [artifactId]: Date.now() });
    }, [dismissed, setDismissed]);
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
