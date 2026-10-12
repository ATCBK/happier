import { describe, expect, it } from 'vitest';
import { resolveTranscriptJumpPlacement } from './transcriptJumpPlacement';

describe('transcript jump placement', () => {
  const reveal = {
    kind: 'reveal',
    clearancePx: 64,
    focusTestId: 'find-match-current',
  } as const;

  it('starts a row that fits below the clearance right under it, whatever its focus', () => {
    expect(
      resolveTranscriptJumpPlacement({
        align: reveal,
        itemHeight: 120,
        viewportHeight: 600,
        focusTopPx: 40,
      }),
    ).toEqual({ kind: 'item-offset', itemOffsetPx: 64 });
  });

  it('places the mounted focus of a taller row at the clearance, and centres it until mounted', () => {
    expect(
      resolveTranscriptJumpPlacement({
        align: reveal,
        itemHeight: 1400,
        viewportHeight: 600,
        focusTopPx: 1000,
      }),
    ).toEqual({ kind: 'item-offset', itemOffsetPx: -936 });
    expect(
      resolveTranscriptJumpPlacement({
        align: reveal,
        itemHeight: 1400,
        viewportHeight: 600,
      }),
    ).toEqual({ kind: 'center' });
    expect(
      resolveTranscriptJumpPlacement({
        align: reveal,
        itemHeight: null,
        viewportHeight: 600,
      }),
    ).toEqual({ kind: 'center' });
  });

  it('keeps the centred landing for a fitting row when no capsule covers the top', () => {
    expect(
      resolveTranscriptJumpPlacement({
        align: { ...reveal, clearancePx: 0 },
        itemHeight: 120,
        viewportHeight: 600,
      }),
    ).toEqual({ kind: 'center' });
  });

  it('keeps explicit alignments as given', () => {
    expect(
      resolveTranscriptJumpPlacement({
        align: { kind: 'center' },
        itemHeight: 10,
        viewportHeight: 600,
      }),
    ).toEqual({ kind: 'center' });
    expect(
      resolveTranscriptJumpPlacement({
        align: { kind: 'top-with-item-offset', itemOffsetPx: 24 },
        itemHeight: 10,
        viewportHeight: 600,
      }),
    ).toEqual({ kind: 'item-offset', itemOffsetPx: 24 });
  });
});
