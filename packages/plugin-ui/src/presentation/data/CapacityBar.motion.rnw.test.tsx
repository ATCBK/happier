import { act } from 'react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { CapacityBar } from './CapacityBar.js';

// RNW selects its instant AnimatedMock in NODE_ENV=test. Exercise its actual JS animation driver.
vi.hoisted(() => {
  process.env.NODE_ENV = 'development';
});
afterAll(() => {
  process.env.NODE_ENV = 'test';
});

const fill = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('[data-testid="meter-meter-fill"]')!;
const widthOf = (root: HTMLElement) =>
  Number.parseFloat(fill(root).style.width);
const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe('an animated capacity meter (lab rv: 600 ms value ease, 320 ms tone cross-fade)', () => {
  const bar = (value: number, color: string, reducedMotion = false) => (
    <CapacityBar
      theme={theme}
      label="Memory in use"
      value={value}
      capacity={100}
      color={color}
      size="inline"
      showCaption={false}
      animated
      reducedMotion={reducedMotion}
      testID="meter"
    />
  );

  it('eases from where it is to each new value and settles there, retargeting mid-way', async () => {
    const mount = mountThroughReactNativeWeb(bar(20, theme.colors.text));
    try {
      expect(widthOf(mount.container)).toBeCloseTo(20, 0);
      await mount.render(bar(60, theme.colors.text));
      // The new value does not jump: the fill starts from the drawn width.
      expect(widthOf(mount.container)).toBeLessThan(55);
      await wait(150);
      const midway = widthOf(mount.container);
      expect(midway).toBeGreaterThan(20);
      // A new sample retargets from the current width, not from the old target.
      await mount.render(bar(30, theme.colors.text));
      await wait(800);
      expect(widthOf(mount.container)).toBeCloseTo(30, 0);
    } finally {
      mount.unmount();
    }
  });

  it('cross-fades its colour when the tone changes, and jumps both under reduced motion', async () => {
    // An awaited React commit can cross the first real frame, changing a rounded
    // RGB channel before the starting-colour assertion. Control only the clock;
    // RNW's actual timing driver and colour interpolation still run.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    const errors = vi.spyOn(console, 'error');
    const normalize = (color: string) => { const probe = document.createElement('div'); probe.style.backgroundColor = color; return probe.style.backgroundColor; };
    const mount = mountThroughReactNativeWeb(bar(40, theme.colors.text));
    try {
      const calm = normalize(fill(mount.container).style.backgroundColor);
      await mount.render(bar(40, theme.colors.warning));
      // The tone starts from the colour on screen…
      expect(normalize(fill(mount.container).style.backgroundColor)).toBe(calm);
      await act(async () => { await vi.advanceTimersByTimeAsync(160); });
      const midway = normalize(fill(mount.container).style.backgroundColor);
      expect(midway).not.toBe(calm);
      expect(midway).not.toBe(normalize(theme.colors.warning));
      await act(async () => { await vi.advanceTimersByTimeAsync(290); });
      // …and has settled on the new one once the cross-fade is over.
      expect(normalize(fill(mount.container).style.backgroundColor)).toBe(normalize(theme.colors.warning));
      await mount.render(bar(90, theme.colors.danger, true));
      expect(widthOf(mount.container)).toBeCloseTo(90, 0);
      expect(normalize(fill(mount.container).style.backgroundColor)).toBe(normalize(theme.colors.danger));
      expect(errors.mock.calls.filter((args) => String(args[0]).includes('Cannot update a component'))).toEqual([]);
    } finally { mount.unmount(); errors.mockRestore(); vi.useRealTimers(); }
  });
});
