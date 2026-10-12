import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { AtmosphereDissolve } from './AtmosphereDissolve.web';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

describe('the atmosphere fade', () => {
  it('arrives on the standard curve and leaves sooner than it arrives, on the exit curve', async () => {
    // The Web Animations API is the platform boundary: record what the layer asks of it.
    const timings: KeyframeAnimationOptions[] = [];
    const node = {
      style: {} as Record<string, string>,
      getAnimations: () => [],
      animate: (_frames: unknown, timing: KeyframeAnimationOptions) => {
        timings.push(timing);
        return {};
      },
    };
    const layer = (visible: boolean) => (
      <AtmosphereDissolve visible={visible} leave="fade" height={400} reducedMotion={false}>{null}</AtmosphereDissolve>
    );
    const screen = await renderScreen(layer(false), { createNodeMock: () => node });
    await screen.update(layer(true));
    await screen.update(layer(false));
    const [arrival, leaving] = timings;
    expect(arrival).toMatchObject({ duration: motionTokens.atmosphere.readyFadeMs, easing: motionTokens.easingCss.standard });
    expect(leaving).toMatchObject({ easing: motionTokens.easingCss.exit });
    expect(Number(leaving.duration)).toBeLessThan(Number(arrival.duration));
  });
});
