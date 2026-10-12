import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: 1440, height: 900 }) });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The Popover's measuring and portal are the platform boundary; the picker's own props are what is read.
vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => React.createElement('Popover', props),
}));
vi.mock('./WorkflowExamplesSection', () => ({ WorkflowExamplesSection: () => null }));

describe('WorkflowExamplesPopover', () => {
    it('lets a picker whose window-high cap fits on neither side open below a trigger near the top', async () => {
        const { WorkflowExamplesPopover } = await import('./WorkflowExamplesPopover');
        const screen = await renderScreen(<WorkflowExamplesPopover anchorRef={{ current: null }} onRequestClose={() => {}} />);
        const popover = screen.findByType('Popover' as any);
        // The cap is the whole window; the room a side must offer to be chosen is a menu's, not the window's.
        expect(popover?.props.maxHeightCap).toBe(900);
        expect(popover?.props.placementMinSpace).toBeLessThan(900);
        expect(popover?.props.placementMinSpace).toBeGreaterThan(0);
    });
});
