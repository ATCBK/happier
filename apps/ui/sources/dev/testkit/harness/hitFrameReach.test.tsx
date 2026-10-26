import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { hitAreaOverlap, readHitArea, readHitFrameReach } from './hitFrameReach';

async function mount(element: React.ReactElement) {
    const screen = await renderScreen(element);
    return screen.root.findByProps({ testID: 'target' });
}

describe('hit area readers', () => {
    afterEach(() => standardCleanup());

    it('reads native hitSlop and the web frame to the same effective rect, excluding the border', async () => {
        const native = await mount(React.createElement('view', { testID: 'target', style: { width: 28, height: 28 }, hitSlop: { top: 8, bottom: 8, left: 2, right: 2 } }));
        const web = await mount(React.createElement('view', { testID: 'target', style: { width: 28, height: 28, borderWidth: 1 } },
            React.createElement('view', { dataSet: { happierHitArea: 'true' }, style: { top: -9, bottom: -9, left: -3, right: -3 } })));

        for (const node of [native, web]) {
            expect(readHitArea(node)).toMatchObject({ drawn: { width: 28, height: 28 }, insets: { top: 8, bottom: 8, left: 2, right: 2 }, width: 32, height: 44 });
        }
        expect(readHitFrameReach(web)).toEqual({ top: 9, bottom: 9, left: 3, right: 3 });
    });

    it('reports how far neighbouring reaches overrun the gap between their drawn boxes', async () => {
        const left = readHitArea(await mount(React.createElement('view', { testID: 'target', style: { width: 24, height: 24 }, hitSlop: { top: 0, bottom: 0, left: 0, right: 3 } })));
        const right = readHitArea(await mount(React.createElement('view', { testID: 'target', style: { width: 24, height: 24 }, hitSlop: { top: 0, bottom: 0, left: 3, right: 0 } })));

        expect(hitAreaOverlap(left, right, { axis: 'horizontal', gap: 6 })).toBe(0);
        expect(hitAreaOverlap(left, right, { axis: 'horizontal', gap: 4 })).toBe(2);
        expect(hitAreaOverlap(left, right, { axis: 'vertical' })).toBe(0);
    });
});
