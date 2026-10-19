import * as React from 'react';
import { Animated } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { TranscriptFirstPaintPlaceholder } from './TranscriptFirstPaintPlaceholder';

installPanelCommonModuleMocks();
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

it('keeps the web loading skeleton mounted without starting a JavaScript animation clock', async () => {
    // React Native Animated is the platform boundary. Its web native-driver fallback
    // schedules React updates every frame; the loading skeleton must use the compositor.
    const loop = vi.spyOn(Animated, 'loop');
    const screen = await renderScreen(<TranscriptFirstPaintPlaceholder reducedMotion={false} />);
    expect(screen.findHostByTestId('transcript-first-paint-placeholder:rows')).not.toBeNull();
    expect(screen.findHostByTestId('transcript-first-paint-placeholder')?.props).toMatchObject({
        pointerEvents: 'none', 'aria-hidden': true, accessibilityElementsHidden: true,
    });
    expect(loop).not.toHaveBeenCalled();
    await screen.update(<TranscriptFirstPaintPlaceholder reducedMotion />);
    expect(screen.findHostByTestId('transcript-first-paint-placeholder:static')).not.toBeNull();
    expect(screen.findHostByTestId('transcript-first-paint-placeholder:rows')).not.toBeNull();
    expect(loop).not.toHaveBeenCalled();
});
