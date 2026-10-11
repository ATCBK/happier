import { describe, expect, it, vi } from 'vitest';
import { Animated } from 'react-native';

import { MotionFeedback, Text } from '@happier-dev/plugin-ui/components';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

describe('public motion feedback', () => {
  it('keeps mounted content and immediately settles a running acknowledgement when reduced motion changes', async () => {
    // Native animation scheduling is the platform boundary; the trigger and accessibility logic stay real.
    const stop = vi.fn();
    const timing = vi.spyOn(Animated, 'timing').mockReturnValue({ start: vi.fn(), stop, reset: vi.fn() });
    const context = createSurfaceContext();
    const host = createHostApiStub(context);
    const body = (trigger: number, reducedMotion: boolean) => (
      <PluginUiProvider hostApi={host} context={{ ...context, reducedMotion }}>
        <MotionFeedback trigger={trigger} testID="feedback">
          <Text testID="result" value="Published" />
        </MotionFeedback>
      </PluginUiProvider>
    );
    const mounted = mountThroughReactNativeWeb(body(0, false));
    try {
      const result = mounted.container.querySelector('[data-testid="result"]');
      expect(result?.textContent).toBe('Published');
      expect(timing).not.toHaveBeenCalled();
      await mounted.render(body(1, false));
      expect(timing).toHaveBeenCalledOnce();
      await mounted.render(body(1, true));
      expect(stop).toHaveBeenCalledOnce();
      expect(mounted.container.querySelector<HTMLElement>('[data-testid="feedback"]')?.style.opacity).toBe('1');
      expect(mounted.container.querySelector('[data-testid="result"]')).toBe(result);
      await mounted.render(body(2, true));
      expect(timing).toHaveBeenCalledOnce();
      await mounted.render(body(2, false));
      expect(timing).toHaveBeenCalledOnce();
    } finally {
      mounted.unmount();
      timing.mockRestore();
    }
  });
});
