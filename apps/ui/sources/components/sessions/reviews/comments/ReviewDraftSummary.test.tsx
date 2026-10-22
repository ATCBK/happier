import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { ReviewDraftSummary } from './ReviewDraftSummary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('@/components/ui/text/Text', async () => (await import('@/dev/testkit/mocks/uiText')).createUiTextModuleMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key, params) => params ? JSON.stringify(params) : key }));

const drafts: readonly ReviewCommentDraft[] = [true, false].map((includeInPrompt, index) => ({
    id: String(index), filePath: 'file.ts', source: 'file', anchor: { kind: 'fileLine', startLine: 1 },
    snapshot: { selectedLines: [], beforeContext: [], afterContext: [] }, body: 'Review this', createdAt: 1, includeInPrompt,
}));

describe('ReviewDraftSummary', () => {
    it('shows prompt inclusion and hands off without changing saved drafts', async () => {
        let destination = 'review';
        const before = JSON.stringify(drafts);
        const screen = await renderScreen(<ReviewDraftSummary enabled drafts={drafts} onGoToComposer={() => { destination = 'composer'; }} />);
        // Only the comment that rides along is counted; the detached one stays saved but out.
        expect(screen.getTextContent()).toContain('{"count":1}');
        await act(async () => { screen.pressByTestId('review-drafts-go-to-composer'); });
        expect(destination).toBe('composer');
        expect(JSON.stringify(drafts)).toBe(before);
    });
    it('hides disabled or empty summaries', async () => {
        const screen = await renderScreen(<ReviewDraftSummary enabled={false} drafts={drafts} onGoToComposer={() => {}} />);
        expect(screen.findAllByTestId('review-drafts-go-to-composer')).toHaveLength(0);
        await act(async () => { screen.tree.update(<ReviewDraftSummary enabled drafts={[]} onGoToComposer={() => {}} />); });
        expect(screen.findAllByTestId('review-drafts-go-to-composer')).toHaveLength(0);
    });
    it('opens in place to show each comment that goes with the next message, and leaves one out on request', async () => {
        const detached: string[] = [];
        const screen = await renderScreen(
            <ReviewDraftSummary enabled drafts={drafts} onGoToComposer={() => {}} onDetachDraft={(draft) => { detached.push(draft.id); }} />,
        );
        expect(screen.findAllByTestId('review-drafts-chips')).toHaveLength(0);
        await act(async () => { screen.pressByTestId('review-drafts-expand'); });
        expect(screen.findAllByTestId('review-draft-chip-0').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('review-draft-chip-1')).toHaveLength(0);
        await act(async () => { screen.pressByTestId('review-draft-chip-detach-0'); });
        expect(detached).toEqual(['0']);
    });
    it('grows into the composer in place when Review can send, sharing the session draft', async () => {
        const typed: string[] = [];
        let sent = 0;
        let handedOff = 0;
        const screen = await renderScreen(
            <ReviewDraftSummary
                enabled
                drafts={drafts}
                onGoToComposer={() => { handedOff += 1; }}
                composer={{ text: 'Address these', onChangeText: (text) => { typed.push(text); }, onSend: () => { sent += 1; }, sending: false }}
            />,
        );
        expect(screen.findAllByTestId('review-ask-composer')).toHaveLength(0);
        await act(async () => { screen.pressByTestId('review-drafts-go-to-composer'); });
        expect(handedOff).toBe(0);
        expect(screen.findAllByTestId('review-ask-composer').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('review-draft-chip-0').length).toBeGreaterThan(0);
        const input = screen.findByTestId('review-ask-input');
        expect(input?.props.value).toBe('Address these');
        await act(async () => { input?.props.onChangeText('Address these, then rerun'); });
        expect(typed).toEqual(['Address these, then rerun']);
        await act(async () => { screen.pressByTestId('review-ask-send'); });
        expect(sent).toBe(1);
    });
    it('steps aside while Find is seated in its place and returns with its open comments intact', async () => {
        const hidden = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
            [screen.findByTestId('review-drafts-summary')?.props.style].flat(2).some((style) => style?.display === 'none');
        let setYielded: (yielded: boolean) => void = () => {};
        function Host() {
            const [yielded, set] = React.useState(false);
            setYielded = set;
            return <ReviewDraftSummary enabled yielded={yielded} drafts={drafts} onGoToComposer={() => {}} />;
        }
        const screen = await renderScreen(<Host />);
        await act(async () => { screen.pressByTestId('review-drafts-expand'); });
        expect(hidden(screen)).toBe(false);
        await act(async () => { setYielded(true); });
        expect(hidden(screen)).toBe(true);
        await act(async () => { setYielded(false); });
        expect(hidden(screen)).toBe(false);
        expect(screen.findAllByTestId('review-draft-chip-0').length).toBeGreaterThan(0);
    });
});
