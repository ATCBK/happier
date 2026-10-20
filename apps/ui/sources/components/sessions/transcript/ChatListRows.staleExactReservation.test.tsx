/**
 * A row shell's reserved `minHeight` is applied to the very node the renderer positions, so a
 * measurement of the shell itself can only ever read the reservation back. The row's own natural
 * content height is the only evidence that can correct a cached height that was recorded at a
 * transient width (a window resize lays rows out before the width bucket in their signature moves),
 * and a cached height that natural content contradicts must stop being reserved: it paints as a
 * blank band under the row and pushes every row below it.
 */
import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { TranscriptRowShell } from './ChatListRows';
import { createTestTranscriptItemHeightCache } from './measurement/transcriptItemHeightCache';
import { createTestTranscriptMeasurementReconciler } from './measurement/transcriptMeasurementReconciler';

const SIGNATURE = {
  itemId: 'msg:notice',
  kind: 'message:event',
  structuralKey: 'notice-rev1',
  widthBucket: 'width:448',
  fontScaleKey: 'font:100',
  groupingMode: 'turns',
  forkContextKey: 'none',
  expansionKey: 'tools:none|thinking:none',
  rowState: 'stable',
} as const;

function setup(cachedHeightPx: number | null) {
  const reconciler = createTestTranscriptMeasurementReconciler({
    cache: createTestTranscriptItemHeightCache(),
  });
  if (cachedHeightPx !== null)
    reconciler.recordMeasuredHeight({
      signature: SIGNATURE,
      heightPx: cachedHeightPx,
    });
  const row = (renderTick: number) => (
    <TranscriptRowShell
      reconciler={reconciler}
      itemId={SIGNATURE.itemId}
      signature={SIGNATURE}
    >
      {renderTick}
    </TranscriptRowShell>
  );
  return { reconciler, row };
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

const shell = (screen: Screen) =>
  screen.findByTestId(`transcript-item-${SIGNATURE.itemId}`);
const content = (screen: Screen) =>
  screen.findByTestId(`transcript-row-content-${SIGNATURE.itemId}`);
const reservedMinHeight = (screen: Screen) =>
  (shell(screen)?.props.style as { minHeight?: number } | undefined)?.minHeight;
const layoutEvent = (height: number) => ({
  nativeEvent: { layout: { height } },
});

const contentLayout = (screen: Screen, height: number) =>
  act(async () => {
    (content(screen)!.props.onLayout as (event: unknown) => void)(
      layoutEvent(height),
    );
  });
const shellLayout = (screen: Screen, height: number) =>
  act(async () => {
    (shell(screen)!.props.onLayout as (event: unknown) => void)(
      layoutEvent(height),
    );
  });

describe('TranscriptRowShell stale exact reservation', () => {
  it('releases and corrects a cached height that the row natural content contradicts', async () => {
    const { reconciler, row } = setup(242);
    const screen = await renderScreen(row(0));
    expect(reservedMinHeight(screen)).toBe(242);

    await contentLayout(screen, 202);

    expect(reservedMinHeight(screen)).toBeUndefined();
    expect(reconciler.resolveReservation(SIGNATURE)).toEqual({
      kind: 'exact',
      minHeight: 202,
    });
  });

  it('keeps reserving a cached height that natural content confirms or exceeds', async () => {
    const { reconciler, row } = setup(202);
    const screen = await renderScreen(row(0));

    await contentLayout(screen, 202);
    expect(reservedMinHeight(screen)).toBe(202);

    await contentLayout(screen, 242);
    expect(reservedMinHeight(screen)).toBe(202);
    expect(reconciler.resolveReservation(SIGNATURE)).toEqual({
      kind: 'exact',
      minHeight: 242,
    });
  });

  it('never records the shell own forced height as a measurement', async () => {
    const { reconciler, row } = setup(242);
    const screen = await renderScreen(row(0));

    // The shell reports its reservation back; only the content measurement may change the cache.
    await shellLayout(screen, 242);

    expect(reconciler.resolveReservation(SIGNATURE)).toEqual({
      kind: 'exact',
      minHeight: 242,
    });
    await contentLayout(screen, 202);
    expect(reconciler.resolveReservation(SIGNATURE)).toEqual({
      kind: 'exact',
      minHeight: 202,
    });
  });
});
