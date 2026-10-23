import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

const flight = await import('./rectFlight');

type Probe = { current: ReturnType<typeof flight.useEnterFromRect> | null };

async function renderEnter(
  origin: { x: number; y: number; width: number; height: number } | null,
  reducedMotion: boolean,
) {
  const probe: Probe = { current: null };
  function Harness() {
    probe.current = flight.useEnterFromRect(origin, { reducedMotion });
    return null;
  }
  await renderScreen(<Harness />);
  return probe;
}

// A popover row's mark + name (window coordinates) and the page header's mark and title it enters as.
const ROW = { x: 10, y: 400, width: 120, height: 20 };
const MARK = { x: 300, y: 80, width: 40, height: 40 };
const TITLE = { x: 352, y: 84, width: 200, height: 32 };

describe('useEnterFromRect (MPG-32)', () => {
  it('moves the destination group from the origin rect, scaled uniformly by height', async () => {
    const probe = await renderEnter(ROW, false);
    // Before the members are measured nothing is armed, so no frame paints at the final position.
    expect(probe.current!.group.armed.value).toBe(false);
    await act(async () => probe.current!.onTargets([MARK, TITLE]));
    expect(probe.current!.group.armed.value).toBe(true);
    expect(probe.current!.group.target.value).toEqual({
      x: 300,
      y: 80,
      width: 252,
      height: 40,
    });
    expect(probe.current!.group.from.value).toEqual({
      x: 10,
      y: 400,
      width: 126,
      height: 20,
    });
    expect(probe.current!.group.offsets.value).toEqual([
      { x: 0, y: 0 },
      { x: 52, y: 4 },
    ]);
  });

  it('travels nowhere without an origin or under reduced motion', async () => {
    const none = await renderEnter(null, false);
    expect(none.current!.group.armed.value).toBe(true);
    expect(none.current!.group.mode).toBe('none');
    const reduced = await renderEnter(ROW, true);
    expect(reduced.current!.group.mode).toBe('fade');
    await act(async () => reduced.current!.onTargets([MARK, TITLE]));
    expect(reduced.current!.group.armed.value).toBe(true);
  });

  it('shows the destination where it is when a member cannot be measured', async () => {
    const probe = await renderEnter(ROW, false);
    await act(async () => probe.current!.onTargets([null, null]));
    expect(probe.current!.group.armed.value).toBe(true);
    expect(probe.current!.group.progress.value).toBe(1);
  });
});

describe('enter-from-rect frames', () => {
  const target = { x: 300, y: 80, width: 252, height: 40 };
  const from = { x: 10, y: 400, width: 126, height: 20 };

  it('holds every member unseen until armed', () => {
    expect(
      flight.enterFromRectMemberStyle({
        mode: 'travel',
        armed: false,
        progress: 0,
        from,
        target,
        offset: { x: 0, y: 0 },
      }).opacity,
    ).toBe(0);
  });

  it('paints the first armed frame at the origin, the group moving as one, and lands at identity', () => {
    const mark = flight.enterFromRectMemberStyle({
      mode: 'travel',
      armed: true,
      progress: 0,
      from,
      target,
      offset: { x: 0, y: 0 },
    });
    expect(mark.opacity).toBe(1);
    expect(mark.transform).toEqual([
      { translateX: -290 },
      { translateY: 320 },
      { scaleX: 0.5 },
      { scaleY: 0.5 },
    ]);
    // The title sits 52 px right of the mark at the destination, so 26 px at the origin's half scale.
    const title = flight.enterFromRectMemberStyle({
      mode: 'travel',
      armed: true,
      progress: 0,
      from,
      target,
      offset: { x: 52, y: 4 },
    });
    expect(title.transform).toEqual([
      { translateX: -316 },
      { translateY: 318 },
      { scaleX: 0.5 },
      { scaleY: 0.5 },
    ]);
    const landed = flight.enterFromRectMemberStyle({
      mode: 'travel',
      armed: true,
      progress: 1,
      from,
      target,
      offset: { x: 52, y: 4 },
    });
    expect(landed.transform).toEqual([
      { translateX: 0 },
      { translateY: 0 },
      { scaleX: 1 },
      { scaleY: 1 },
    ]);
  });

  it('cross-fades in place under reduced motion', () => {
    const half = flight.enterFromRectMemberStyle({
      mode: 'fade',
      armed: true,
      progress: 0.5,
      from,
      target,
      offset: { x: 52, y: 4 },
    });
    expect(half.opacity).toBe(0.5);
    expect(half.transform).toEqual([
      { translateX: 0 },
      { translateY: 0 },
      { scaleX: 1 },
      { scaleY: 1 },
    ]);
  });

  it('fades the supporting lines in over the travel’s last part only', () => {
    const fadeStart =
      1 - flight.ENTER_FROM_RECT_CONTENT_FADE_MS / flight.ENTER_FROM_RECT_MS;
    expect(flight.enterFromRectContentOpacity('travel', false, 1)).toBe(0);
    expect(
      flight.enterFromRectContentOpacity('travel', true, fadeStart - 0.05),
    ).toBe(0);
    expect(flight.enterFromRectContentOpacity('travel', true, 1)).toBe(1);
    expect(flight.enterFromRectContentOpacity('fade', true, 0.25)).toBe(0.25);
    expect(flight.enterFromRectContentOpacity('none', true, 0)).toBe(1);
  });
});

describe('enter-from-rect clock bounds', () => {
    it('never travels past the origin when a frame reads the clock before its start', () => {
        const target = { x: 300, y: 80, width: 252, height: 40 };
        const from = { x: 10, y: 400, width: 126, height: 20 };
        const early = flight.enterFromRectMemberStyle({ mode: 'travel', armed: true, progress: -3.6, from, target, offset: { x: 0, y: 0 } });
        expect(early.transform).toEqual([{ translateX: -290 }, { translateY: 320 }, { scaleX: 0.5 }, { scaleY: 0.5 }]);
        expect(flight.enterFromRectContentOpacity('fade', true, -1)).toBe(0);
    });
});
