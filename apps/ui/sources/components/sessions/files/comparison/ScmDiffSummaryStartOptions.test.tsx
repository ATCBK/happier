import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, renderScreen } from '@/dev/testkit';

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

const { ScmDiffSummaryStartOptions, useSummaryModelChoice } = await import('./ScmDiffSummaryStartOptions');
const { SPECIMEN_START_FAILURES } = await import('@/components/dev/changes/walkthroughSpecimenFixture');

describe('ScmDiffSummaryStartOptions', () => {
    it('says one localized sentence and the next step for a refusal, never its code', async () => {
        const screen = await renderScreen(<ScmDiffSummaryStartOptions testID="start-options" failure={SPECIMEN_START_FAILURES.outdated} message="invalid_action_output" />);
        const text = screen.getTextContent();
        expect(text).toContain('walkthrough.generationFailure.invalidRequest');
        expect(text).toContain('walkthrough.generationFailure.reviewRequest');
        // A typed refusal replaces any incidental message, so no raw code can sit beside it.
        expect(text).not.toContain('invalid_action_output');
    });

    it('offers choosing another model when the model is the refusal', async () => {
        const onChooseModel = vi.fn();
        const screen = await renderScreen(<ScmDiffSummaryStartOptions testID="start-options" failure={SPECIMEN_START_FAILURES.model} message={null} onChooseModel={onChooseModel} />);
        await screen.pressByTestIdAsync('start-options-choose-model');
        expect(onChooseModel).toHaveBeenCalledTimes(1);
    });

    it('leaves an action nobody can press out of the refusal, instead of a dangling clause', async () => {
        const screen = await renderScreen(<ScmDiffSummaryStartOptions testID="start-options" failure={SPECIMEN_START_FAILURES.model} message={null} />);
        expect(screen.getTextContent()).toBe('walkthrough.generationFailure.modelUnavailable');
    });

    it('sends the person to the model choice and opens its choices, from every surface that shows a result', async () => {
        const setOpen = vi.fn();
        const hook = await renderHook(() => useSummaryModelChoice({ setOpen }));
        expect(hook.getCurrent().choosing).toBe(false);
        await act(async () => { hook.getCurrent().choose(); });
        expect(hook.getCurrent().choosing).toBe(true);
        expect(setOpen).toHaveBeenCalledWith(true);
        await hook.unmount();
    });


    it('keeps the refusal room when nothing was refused, so a refusal never moves the state', async () => {
        const screen = await renderScreen(<ScmDiffSummaryStartOptions testID="start-options" failure={null} message={null} />);
        expect(screen.findByTestId('start-options-refusal')).toBeTruthy();
        expect(screen.getTextContent()).toBe('');
    });
});
