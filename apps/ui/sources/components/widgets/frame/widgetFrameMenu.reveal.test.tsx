import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const viewport = vi.hoisted(() => ({ width: 1440, height: 900 }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
}));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(() => { standardCleanup(); });

describe('widget and group ⋯ reveal', () => {
    it('keeps the ⋯ on every card and group on a phone, whatever the pointer; hover reveals it on a wider window (F4 D-15)', async () => {
        const { useWidgetMenuAlwaysShown } = await import('./widgetFrameMenu');
        let shown: boolean | undefined;
        function Probe() { shown = useWidgetMenuAlwaysShown(); return null; }
        viewport.width = 390; viewport.height = 844;
        await renderScreen(<Probe />);
        expect(shown).toBe(true);
        viewport.width = 1440; viewport.height = 900;
        await renderScreen(<Probe />);
        expect(shown).toBe(false);
    });
});
