import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { AtmosphereRippleHandle } from './atmosphereRipple.types';
import { useSessionRipplePlayback } from './sessionRipple';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

async function frames(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    await act(async () => { vi.advanceTimersByTime(16); });
  }
}

describe('session ripple live motion inputs', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }); });
  afterEach(() => { vi.useRealTimers(); });

  async function mount() {
    let output: ReturnType<typeof useSessionRipplePlayback> = { gain: 1, ringShown: false };
    // The imperative ring painter is a platform drawing boundary.
    const ring: React.RefObject<AtmosphereRippleHandle | null> = { current: { paint: vi.fn() } };
    function Probe(props: Readonly<{ paused?: boolean; reducedMotion?: boolean }>) {
      output = useSessionRipplePlayback(1, { width: 280, theme: 'dark', cx: 200, cy: 80, R: 90,
        reducedMotion: props.reducedMotion ?? false, paused: props.paused ?? false }, ring);
      return null;
    }
    const screen = await renderScreen(<Probe />);
    return { output: () => output, set: (props: React.ComponentProps<typeof Probe>) => screen.update(<Probe {...props} />) };
  }

  it('holds a finite answer while focus or writing pauses it, then resumes', async () => {
    const home = await mount();
    await frames(64);
    await home.set({ paused: true });
    const held = home.output();
    await frames(2000);
    expect(home.output()).toEqual(held);
    await home.set({ paused: false });
    await frames(1800);
    expect(home.output()).toEqual({ gain: 1, ringShown: false });
  });

  it('settles an answer when reduced motion changes during playback', async () => {
    const home = await mount();
    await frames(64);
    await home.set({ reducedMotion: true });
    expect(home.output()).toEqual({ gain: 1, ringShown: false });
    await frames(160);
    expect(home.output()).toEqual({ gain: 1, ringShown: false });
  });
});
