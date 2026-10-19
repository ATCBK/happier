import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Text: (props: any) => React.createElement('RNText', props, props.children),
    });
});

function flatten(style: unknown): Record<string, unknown> {
    return Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : typeof style === 'object' && style !== null ? style as Record<string, unknown> : {};
}

describe('FindHighlightedText on the web', () => {
    it('rings a match on its sides only, so a hit on a clamped hidden line cannot paint into the last visible one', async () => {
        const { FindHighlightedText } = await import('./FindHighlightedText');
        const screen = await renderScreen(<FindHighlightedText text="harbor note" ranges={[{ start: 0, end: 6, current: false }]} />);

        const shadow = String(flatten(screen.findByTestId('find-match-all')?.props.style).boxShadow);
        const rings = shadow.split(/,\s*(?![^(]*\))/);
        expect(rings.length).toBeGreaterThan(0);
        for (const ring of rings) {
            // `<x> <y> <blur> <spread> <colour>`: no vertical offset, blur or spread.
            expect(ring.trim()).toMatch(/^-?[\d.]+px 0 0 0 /);
        }
    });
});
