import * as React from 'react';

import {
    WalkthroughNotice,
    WalkthroughNoticeButton,
    WalkthroughNoticeLink,
} from '@/components/sessions/files/walkthrough/WalkthroughLifecycle';
import type { ScmDiffSummaryFailurePresentation } from '@/sync/domains/scm/diffSummary/state';
import { t } from '@/text';

import { describeScmDiffSummaryFailure } from './ScmDiffSummaryStartOptions';

/**
 * A refused or failed generation beside a reading or proposal that is already on screen: the walkthrough notice
 * band, written from the same typed presentation the empty state uses ({@link describeScmDiffSummaryFailure}).
 * The native reason and code never reach this copy; they stay in the store entry's diagnostics.
 */
export function ScmDiffSummaryFailureNotice(props: Readonly<{
    failure: ScmDiffSummaryFailurePresentation;
    /** The surface's test id prefix: `<prefix>-notice-failed`, `<prefix>-choose-model`, `<prefix>-retry`. */
    testID: string;
    phone?: boolean;
    onChooseModel?: () => void;
    onEnableExplain?: () => void;
    onRetry?: () => void;
}>) {
    const described = describeScmDiffSummaryFailure(props.failure);
    const failed = props.failure.reason === 'generationFailed';
    const chooseModel = described.nextAction === 'chooseModel' ? props.onChooseModel : undefined;
    const enableExplain = described.nextAction === 'enableExplain' ? props.onEnableExplain : undefined;
    const link = chooseModel
        ? { testID: `${props.testID}-choose-model`, label: described.action!, onPress: chooseModel }
        : enableExplain ? { testID: `${props.testID}-enable-explain`, label: described.action!, onPress: enableExplain }
        : failed && props.onChooseModel ? { testID: `${props.testID}-choose-model`, label: t('walkthrough.notice.chooseModel'), onPress: props.onChooseModel }
        : null;
    // A step with nothing to press (update the machine, reconnect it) is part of the sentence.
    const text = described.nextStep ? `${described.message} ${described.nextStep}` : described.message;
    return (
        <WalkthroughNotice testID={`${props.testID}-notice-failed`} tone={failed ? 'danger' : 'warning'} icon={failed ? 'x-circle' : 'warning'}
            phone={props.phone} message={text}
            actions={link || props.onRetry ? (
                <>
                    {link ? <WalkthroughNoticeLink testID={link.testID} label={link.label} onPress={link.onPress} /> : null}
                    {props.onRetry ? <WalkthroughNoticeButton testID={`${props.testID}-retry`} icon="arrows-clockwise" label={t('walkthrough.notice.tryAgain')} onPress={props.onRetry} /> : null}
                </>
            ) : undefined} />
    );
}
