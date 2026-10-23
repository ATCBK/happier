import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { WorkStatusGlyph } from './WorkStatusGlyph';

describe('WorkStatusGlyph', () => {
    afterEach(standardCleanup);

    it('keeps the canonical state identity visible to row selectors', async () => {
        const status = { state: 'finished_unseen', bucket: 'finished', tone: 'neutral', word: 'Finished', attentionType: 'update', glyph: 'check' } as const;
        const screen = await renderScreen(<WorkStatusGlyph status={status} testIDSuffix="ready" animationEnabled={false} />);
        expect(screen.findByTestId('session-list-attention-indicator-ready-finished_unseen')).toBeTruthy();
        expect(screen.findByTestId('session-row-attention-indicator-ready')?.props.accessible).toBe(false);
    });

    it('keeps working and unread independent without changing the shared status', async () => {
        const status = { state: 'background_active', bucket: 'working', tone: 'neutral', word: 'Working in background', attentionType: 'update', glyph: 'refresh' } as const;
        const element = (unread: boolean) => <WorkStatusGlyph status={status} testIDSuffix="background" hasUnreadMessages={unread} animationEnabled={false} />;
        const screen = await renderScreen(element(true));
        expect(screen.findByTestId('session-row-attention-indicator-spinner-background')).toBeTruthy();
        expect(screen.findByTestId('session-row-unread-center-background')).toBeTruthy();
        await screen.update(element(false));
        expect(screen.findByTestId('session-row-attention-indicator-spinner-background')).toBeTruthy();
        expect(screen.findByTestId('session-row-unread-center-background')).toBeNull();
    });

    it('never pulses requests, failures or viewer news', async () => {
        for (const state of ['permission_required', 'action_required', 'failed', 'mentioned', 'unread']) {
            const status = { state, bucket: 'idle', tone: 'neutral', word: state, attentionType: null, glyph: 'new' } as const;
            const screen = await renderScreen(<WorkStatusGlyph status={status} testIDSuffix={state} />);
            const marks = screen.tree.root.findAll(node => node.props.testID === `session-row-attention-indicator-dot-${state}`);
            expect(marks.length).toBeGreaterThan(0);
            expect(marks.some(node => node.props.isPulsing === true)).toBe(false);
        }
    });
});
