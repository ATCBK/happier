import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    });
});

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { GitPullRequestBodyDraftAction } = await import('./GitPullRequestBodyDraftAction');

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function action(props: Partial<React.ComponentProps<typeof GitPullRequestBodyDraftAction>> = {}) {
    return (
        <GitPullRequestBodyDraftAction
            drafting={false}
            canDraft
            prerequisite={null}
            uncertain={false}
            message={null}
            onDraft={vi.fn()}
            onCheckAdmission={vi.fn()}
            {...props}
        />
    );
}

const texts = (screen: Screen) => screen.findAll((node) => typeof node.type === 'string')
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'));

describe('a pending description request the Machine may not have received', () => {
    it('says it may not have started and offers neither Write nor Cancel', async () => {
        const healthy = await renderScreen(action({ drafting: true, canDraft: false, onCancel: vi.fn() }));
        // The healthy pending request is the control: a busy Write beside a Cancel, and no notice.
        expect(texts(healthy)).toContain('sessionGitPullRequest.form.writingBody');
        expect(healthy.findByTestId('git-pull-request-form-draft-body-cancel')).toBeTruthy();
        expect(healthy.findByTestId('git-pull-request-form-draft-body-unknown')).toBeNull();

        const screen = await renderScreen(action({ drafting: true, canDraft: false, uncertain: true, onCancel: vi.fn() }));
        expect(screen.findByTestId('git-pull-request-form-draft-body-unknown')).toBeTruthy();
        expect(texts(screen)).toContain('sessionGitPullRequest.form.bodyUnknown');
        expect(texts(screen)).not.toContain('sessionGitPullRequest.form.writingBody');
        expect(screen.findByTestId('git-pull-request-form-draft-body')).toBeNull();
        expect(screen.findByTestId('git-pull-request-form-draft-body-cancel')).toBeNull();
    });

    it('checks again only through the supplied callback, one check at a time', async () => {
        let settle = () => {};
        const onCheckAdmission = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
        const onDraft = vi.fn();
        const screen = await renderScreen(action({ drafting: true, canDraft: false, uncertain: true, onCheckAdmission, onDraft }));
        await screen.pressByTestIdAsync('git-pull-request-form-draft-body-check');
        await screen.pressByTestIdAsync('git-pull-request-form-draft-body-check');
        expect(onCheckAdmission).toHaveBeenCalledTimes(1);
        await act(async () => settle());
        await screen.pressByTestIdAsync('git-pull-request-form-draft-body-check');
        expect(onCheckAdmission).toHaveBeenCalledTimes(2);
        expect(onDraft).not.toHaveBeenCalled();
    });

    it('puts a failed check in the notice instead of a second message', async () => {
        const screen = await renderScreen(action({ drafting: true, canDraft: false, uncertain: true, message: 'Machine unreachable' }));
        expect(texts(screen).join(' ')).toContain('Machine unreachable');
        expect(texts(screen)).not.toContain('sessionGitPullRequest.form.bodyUnknownReason');
    });
});

describe('Cancel while the description is being written', () => {
    it('is shown only with a stoppable Run, and calls it once while stopping', async () => {
        const idle = await renderScreen(action());
        expect(idle.findByTestId('git-pull-request-form-draft-body-cancel')).toBeNull();
        const withoutRun = await renderScreen(action({ drafting: true, canDraft: false }));
        expect(withoutRun.findByTestId('git-pull-request-form-draft-body-cancel')).toBeNull();

        let settle = () => {};
        const onCancel = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
        const screen = await renderScreen(action({ drafting: true, canDraft: false, onCancel }));
        await screen.pressByTestIdAsync('git-pull-request-form-draft-body-cancel');
        await screen.pressByTestIdAsync('git-pull-request-form-draft-body-cancel');
        expect(onCancel).toHaveBeenCalledTimes(1);
        // A refused stop settles without confirming: the control is usable again and the pending state stays.
        await act(async () => settle());
        expect(texts(screen)).toContain('sessionGitPullRequest.form.writingBody');
        await screen.pressByTestIdAsync('git-pull-request-form-draft-body-cancel');
        expect(onCancel).toHaveBeenCalledTimes(2);
    });
});
