// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(() => { standardCleanup(); });
const { useSessionSurfaceEntityDrag } = await import('./SessionSurfaceEntityDrag');

const SCOPE = { serverId: 'home-1', accountId: 'account-1' };
const DRAWN = { x: 0, y: 100, width: 300, height: 40 };

/** A drop place drawn 40 px tall (the dashed slot) that asks for an aim at least 88 px tall. */
async function mount(aimMinHeightPx: number | undefined) {
  const target = {
    acceptedKinds: ['home-section' as const],
    resolve: () => ({ status: 'refused' as const, reason: { code: 'test', message: 'test' } }),
    execute: async () => ({ status: 'applied' as const }),
  };
  const common = {
    scope: SCOPE, isCurrent: () => true, title: 'Card', getNativeBounds: () => DRAWN, target,
  };
  const source = { ...common, getItem: () => ({ kind: 'home-section' as const, scope: SCOPE, sectionId: 'card' }), target: undefined };
  const place = { ...common, getItem: () => null, ...(aimMinHeightPx === undefined ? {} : { aimMinHeightPx }) };
  let sourceDrag: ReturnType<typeof useSessionSurfaceEntityDrag> | undefined;
  let placeDrag: ReturnType<typeof useSessionSurfaceEntityDrag> | undefined;
  function Source() { sourceDrag = useSessionSurfaceEntityDrag(source); return null; }
  function Place() { placeDrag = useSessionSurfaceEntityDrag(place); return null; }
  await renderScreen(<><Source /><Place /></>);
  return { source: sourceDrag!, place: placeDrag! };
}

const targetUnder = async (aim: number | undefined, y: number) => {
  const { source, place } = await mount(aim);
  const carry = source.runtime.begin(source.sourceId, 'pointer')!;
  await act(async () => { carry.move({ x: 50, y }); });
  const selected = source.runtime.getSnapshot().targetId;
  carry.cancel();
  return { selected, place };
};

it('keeps the aim at the drawn place when no aim is asked for', async () => {
  const { selected, place } = await targetUnder(undefined, 160);
  expect(selected).not.toBe(place.targetId);
});

it('grows the aim below the drawn place to the asked height while the feedback bounds stay drawn', async () => {
  const inside = await targetUnder(88, 160);
  expect(inside.selected).toBe(inside.place.targetId);
  expect(inside.place.getBounds()).toEqual(DRAWN);
  const past = await targetUnder(88, 200);
  expect(past.selected).not.toBe(past.place.targetId);
});
