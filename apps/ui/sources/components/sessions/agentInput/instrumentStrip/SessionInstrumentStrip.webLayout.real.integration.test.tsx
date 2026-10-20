// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
  type WebLayoutMeasurement,
} from '@/dev/testkit/render/measureWebLayout';

/** The composer's status row as a browser lays it out: a phone recomposes it rather than overflowing. */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-reanimated', async () => {
  // The animation SDK is a boundary, but the strip's entrance wrappers must keep real RNW layout
  // rather than the renderer testkit's symbolic element names (which a browser lays out inline).
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const { View, ScrollView, Text } =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  const mock = createReanimatedModuleMock();
  const animated = { ...mock.default, View, ScrollView, Text };
  return { ...mock, ...animated, default: animated };
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const REASON = 'Connected services · Unavailable';

/** The New Session strip: a blocked-launch badge plus the draft's own actions ("Start another", "Delete draft"). */
async function measureStrip(
  width: number,
  badge: { label: string; labelNumberOfLines?: number } = { label: REASON, labelNumberOfLines: 0 },
  withActions = true,
): Promise<WebLayoutMeasurement> {
  const { SessionInstrumentStrip } = await import('./SessionInstrumentStrip');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <View testID="frame" style={{ width }}>
        <SessionInstrumentStrip
          statusBadges={[
            {
              key: 'blocked',
              ...badge,
              tone: 'warning',
              testID: 'badge',
            },
          ]}
          statusTrailingActions={
            withActions ? (
              <View testID="actions" style={{ width: 190, height: 20 }} />
            ) : undefined
          }
        />
      </View>,
    );
  });
  return measureWebLayout(host, {
    viewport: { width: Math.max(width, 400), height: 300 },
    texts: [badge.label],
    settle: (replay) => act(replay),
  });
}

describe('the composer status row, as a browser lays it out', () => {
  it('keeps the badge and the draft actions on one line where they fit', async () => {
    const layout = await measureStrip(900);
    const badge = layout.rect('badge');
    const actions = layout.rect('actions');
    expect(
      Math.abs(
        (badge.top + badge.bottom) / 2 - (actions.top + actions.bottom) / 2,
      ),
    ).toBeLessThanOrEqual(3);
    expect(actions.right).toBeLessThanOrEqual(layout.rect('frame').right + 0.5);
  });

  it('on a phone gives the badge its own row and moves the actions beneath, all inside the strip', async () => {
    const layout = await measureStrip(358);
    const frame = layout.rect('frame');
    const badge = layout.rect('badge');
    const actions = layout.rect('actions');
    // Nothing runs past the strip's edge (before: the actions overflowed a 390 phone by ~90 px).
    expect(badge.right).toBeLessThanOrEqual(frame.right + 0.5);
    expect(actions.right).toBeLessThanOrEqual(frame.right + 0.5);
    // The badge stays one line at its natural width rather than squeezing into a multi-line capsule.
    expect(badge.height).toBeLessThanOrEqual(30);
    expect(actions.top).toBeGreaterThanOrEqual(badge.bottom);
    // Both stay right-aligned with the strip's content edge (its 20 px inset).
    expect(frame.right - badge.right).toBeLessThanOrEqual(20.5);
    expect(frame.right - actions.right).toBeLessThanOrEqual(20.5);
  });

  it('keeps a long sentence badge inside the strip on a phone, wrapping its words instead of running past the edge', async () => {
    // The managed wake failure line: a sentence, passed with no explicit line count.
    const layout = await measureStrip(
      358,
      { label: 'Codex couldn\u2019t start. Your message is still queued. Ask someone who manages this machine to start it.' },
      false,
    );
    expect(layout.rect('badge').right).toBeLessThanOrEqual(layout.rect('frame').right + 0.5);
  });
});
