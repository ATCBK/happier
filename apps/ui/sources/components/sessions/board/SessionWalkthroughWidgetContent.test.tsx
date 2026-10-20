import * as React from 'react';
import { applyScmReviewedMarkIntent } from '@happier-dev/protocol/scm';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH } from '@/components/dev/changes/walkthroughSpecimenFixture';
import { buildWalkthroughReadingProgress } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { WalkthroughWidgetContentView } from './SessionWalkthroughWidgetContent';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
});

const reading = (refs: string[] = []) => buildWalkthroughReadingProgress({
    comparison: SPECIMEN_COMPARISON, walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH },
    reviewed: applyScmReviewedMarkIntent(SPECIMEN_COMPARISON, null, refs, true),
});

describe('Walkthrough Board reading projection', () => {
    it('keeps the progress slot while marks load and updates the count and next stop with personal marks', async () => {
        const initial = reading();
        const screen = await renderScreen(<WalkthroughWidgetContentView reading={initial} marksLoaded={false} testID="walk" />);
        // The hero line exists before marks arrive, so nothing moves when they do; it claims no count yet.
        expect(screen.findByTestId('walk-progress')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('"count"');
        await act(async () => { screen.tree.update(<WalkthroughWidgetContentView reading={initial} marksLoaded testID="walk" />); });
        expect(screen.getTextContent()).toContain('walkthrough.boardReviewedCount:{"count":0');
        const marked = reading([...initial.stops[0]!.changeRefs]);
        await act(async () => { screen.tree.update(<WalkthroughWidgetContentView reading={marked} marksLoaded testID="walk" />); });
        expect(screen.getTextContent()).toContain('walkthrough.boardReviewedCount:{"count":1');
        expect(screen.getTextContent()).toContain(marked.stops[1]!.title);
    });
    it('says every stop is reviewed instead of borrowing the Contents sheet’s Done label', async () => {
        const initial = reading();
        const all = reading(initial.stops.flatMap((stop) => [...stop.changeRefs]));
        const screen = await renderScreen(<WalkthroughWidgetContentView reading={all} marksLoaded testID="walk" />);
        expect(screen.getTextContent()).toContain('walkthrough.boardAllReviewed');
        expect(screen.getTextContent()).not.toContain('walkthrough.done');
    });
    it('leads to the walkthrough through the frame footer only for an interactive placement', async () => {
        const onOpen = vi.fn();
        const initial = reading();
        const marked = reading([...initial.stops[0]!.changeRefs]);
        const screen = await renderScreen(<WalkthroughWidgetContentView reading={marked} marksLoaded onOpen={onOpen} testID="walk" />);
        expect(screen.getTextContent()).toContain('walkthrough.continueReading');
        await screen.pressByTestId('walk.open');
        expect(onOpen).toHaveBeenCalledOnce();
        await act(async () => { screen.tree.update(<WalkthroughWidgetContentView reading={marked} marksLoaded testID="walk" />); });
        expect(screen.findByTestId('walk.open')).toBeNull();
    });
});
