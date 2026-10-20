import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});

const { ScmDiffSummaryFailureNotice } = await import('./ScmDiffSummaryFailureNotice');
const { SCM_DIFF_SUMMARY_GENERIC_FAILURE } = await import('@/sync/domains/scm/diffSummary/state');

const MODEL_UNAVAILABLE = { reason: 'modelUnavailable', messageKey: 'walkthrough.generationFailure.modelUnavailable',
    nextAction: 'chooseModel', nextActionKey: 'walkthrough.notice.chooseModel' } as const;
const RECONNECT = { reason: 'machineUnavailable', messageKey: 'walkthrough.generationFailure.machineUnavailable',
    nextAction: 'reconnectMachine', nextActionKey: 'walkthrough.generationFailure.reconnectMachine' } as const;

describe('ScmDiffSummaryFailureNotice', () => {
    it('offers an unavailable model\'s next action as the action that opens the picker', async () => {
        const onChooseModel = vi.fn();
        const screen = await renderScreen(<ScmDiffSummaryFailureNotice testID="proposal" failure={MODEL_UNAVAILABLE} onChooseModel={onChooseModel} />);
        screen.findByTestId('proposal-choose-model')?.props.onPress();
        expect(onChooseModel).toHaveBeenCalledTimes(1);
        // The action is the button, not also a clause of the sentence.
        expect(screen.getTextContent().split('walkthrough.notice.chooseModel')).toHaveLength(2);
    });

    it('never leaves an action the person cannot press as an unfinished clause', async () => {
        const unpressable = await renderScreen(<ScmDiffSummaryFailureNotice testID="proposal" failure={MODEL_UNAVAILABLE} />);
        expect(unpressable.findByTestId('proposal-choose-model')).toBeNull();
        expect(unpressable.getTextContent()).toBe('walkthrough.generationFailure.modelUnavailable');
        // A step with nothing to press stays part of the sentence.
        const sentence = await renderScreen(<ScmDiffSummaryFailureNotice testID="proposal" failure={RECONNECT} />);
        expect(sentence.getTextContent()).toContain('walkthrough.generationFailure.reconnectMachine');
    });

    it('uses only the typed failure and recovery instead of raw diagnostics or a model action', async () => {
        const failure = { ...SCM_DIFF_SUMMARY_GENERIC_FAILURE, message: 'MODEL_UNAVAILABLE: no model could start' };
        const screen = await renderScreen(<ScmDiffSummaryFailureNotice testID="proposal" failure={failure}
            onChooseModel={() => {}} onRetry={() => {}} />);
        expect(screen.getTextContent()).toContain('walkthrough.notice.failedGeneric');
        expect(screen.getTextContent()).not.toContain(failure.message);
        expect(screen.findByTestId('proposal-notice-failed-reason')).toBeNull();
        expect(screen.findByTestId('proposal-choose-model')).toBeNull();
        expect(screen.findByTestId('proposal-retry')).not.toBeNull();
    });

});
