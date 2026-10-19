import { describe, expect, it } from 'vitest';

import { buildBrowserStreamSidebandControl } from './browserStreamSidebandControl';

const ids = { sourceId: 'browser-view:s:v', streamId: 'browser-live:m:s:v:tab', eventId: 'event_1' } as const;
// A 1000×500 viewer showing a 500×500 page `contain`-fitted: the page is drawn at x 250..750.
const geometry = { orientation: 'portrait', viewport: { width: 1000, height: 500 }, content: { x: 250, y: 0, width: 500, height: 500 } } as const;

describe('buildBrowserStreamSidebandControl', () => {
    it('sends a tap at the page point under the pointer, not the viewer point (letterboxed frame)', () => {
        // Viewer-normalized (0.5, 0.5) is the middle of the drawn page.
        expect(buildBrowserStreamSidebandControl({ ...ids, gesture: { kind: 'tap', point: { x: 0.5, y: 0.5 }, ...geometry } }))
            .toEqual({ v: 1, ...ids, kind: 'tap', x: 0.5, y: 0.5 });
        // The left edge of the drawn page.
        expect(buildBrowserStreamSidebandControl({ ...ids, gesture: { kind: 'tap', point: { x: 0.25, y: 0.2 }, ...geometry } }))
            .toMatchObject({ kind: 'tap', x: 0, y: 0.2 });
    });

    it('drops input that lands in the letterbox, outside the page', () => {
        expect(buildBrowserStreamSidebandControl({ ...ids, gesture: { kind: 'tap', point: { x: 0.1, y: 0.5 }, ...geometry } }))
            .toBeNull();
    });

    it('maps a swipe to the scroll control and passes typed text and keys through', () => {
        expect(buildBrowserStreamSidebandControl({
            ...ids,
            gesture: { kind: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, ...geometry },
        })).toMatchObject({ kind: 'swipe', fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2 });
        expect(buildBrowserStreamSidebandControl({ ...ids, gesture: { kind: 'keyboard_text', text: 'a' } }))
            .toEqual({ v: 1, ...ids, kind: 'keyboard_text', text: 'a' });
        expect(buildBrowserStreamSidebandControl({ ...ids, gesture: { kind: 'keyboard_key', key: 'Enter' } }))
            .toMatchObject({ kind: 'keyboard_key', key: 'Enter' });
    });

    it('sends nothing for gestures a browser page has no meaning for', () => {
        expect(buildBrowserStreamSidebandControl({
            ...ids,
            gesture: { kind: 'pinch', center: { x: 0.5, y: 0.5 }, startDistance: 10, endDistance: 40, ...geometry },
        })).toBeNull();
    });
});
