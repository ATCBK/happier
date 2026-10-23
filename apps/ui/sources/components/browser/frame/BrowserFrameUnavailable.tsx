import * as React from 'react';

import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

import type { BrowserEndedPreviewRecovery } from './types';

export function BrowserFrameUnavailable(props: Readonly<{
    testID: string;
    reasonCode?: string;
    /**
     * R-3: the system-browser escape. Whenever the caller still knows a URL the user asked for, an
     * unavailable in-app engine must offer to open it in their own browser rather than dead-end.
     * Fulfilled by the caller through the canonical `buildOpenExternalTabSelection` →
     * `openBrowserExternalTabSelection` path, so this card never learns how an OS tab is opened.
     */
    onOpenInSystemBrowser?: () => void;
    /**
     * An ended preview (lab ST, Ended): say what ended, name the last page, offer Open again while
     * its Service runs (or the way to Services once nothing runs it), and Close tab beside it. The
     * escape above wins when both exist.
     */
    endedPreview?: BrowserEndedPreviewRecovery;
}>): React.ReactElement {
    const copy = resolveReasonCopy({ reasonCode: props.reasonCode, kind: 'browserFrame' });
    const ended = props.reasonCode === 'preview_ended' ? props.endedPreview : undefined;
    const lastPage = ended?.lastPage?.trim() || null;
    const onOpenAgain = ended?.onOpenAgain;
    const onOpenServices = ended?.onOpenServices;
    const onClose = ended?.onClose;
    // A refused Open again says why in place of "its service is running"; Open again stays to retry.
    const openAgainFailure = onOpenAgain ? ended?.openAgainFailure?.trim() || null : null;
    const reason = !props.reasonCode ? undefined
        : !ended ? copy.body
            : openAgainFailure ? openAgainFailure
            : onOpenAgain
                ? lastPage ? t('browserShell.unavailable.previewEndedRunningLastPage', { page: lastPage }) : t('browserShell.unavailable.previewEndedRunning')
                : lastPage ? t('browserShell.unavailable.previewEndedLastPage', { page: lastPage }) : copy.body;
    const closeAction: SurfaceStateAction | undefined = onClose ? {
        label: t('browserShell.unavailable.closeTab'),
        onPress: onClose,
        testID: `${props.testID}-ended-close`,
    } : undefined;
    const action: SurfaceStateAction | undefined = props.onOpenInSystemBrowser ? {
        label: t('browserShell.nonFramable.openInSystemBrowser'),
        onPress: props.onOpenInSystemBrowser,
    } : onOpenAgain ? {
        label: t('browserShell.unavailable.openAgain'),
        onPress: onOpenAgain,
        testID: `${props.testID}-ended-open-again`,
    } : onOpenServices ? {
        label: t('browserShell.unavailable.openServices'),
        onPress: onOpenServices,
        testID: `${props.testID}-ended-services`,
    } : closeAction;
    return (
        <SurfaceStateCard
            testID={`${props.testID}-unavailable`}
            kind="unavailable"
            title={copy.title}
            reason={reason}
            diagnosticCode={copy.diagnosticCode}
            action={action}
            secondaryAction={action !== closeAction ? closeAction : undefined}
        />
    );
}
