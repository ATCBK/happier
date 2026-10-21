import { describe, expect, it } from 'vitest';
import {
  resolveSessionViewerBodyAspect,
  resolveSessionViewerCentredInset,
  SESSION_VIEWER_DEFAULT_ASPECT,
  SESSION_VIEWER_EDGE,
  SESSION_VIEWER_STATE_MIN_BODY,
} from './sessionViewerGeometry';

describe('resolveSessionViewerBodyAspect', () => {
  it('keeps the reported picture shape whatever the width', () => {
    expect(resolveSessionViewerBodyAspect(2, 358)).toBe(2);
  });

  it('gives a state card, which has no picture shape yet, the room it needs on a narrow frame', () => {
    const aspect = resolveSessionViewerBodyAspect(null, 358);
    expect(358 / aspect).toBeGreaterThanOrEqual(SESSION_VIEWER_STATE_MIN_BODY);
  });

  it('keeps the default picture shape where it already holds a state card', () => {
    const width = Math.ceil(SESSION_VIEWER_STATE_MIN_BODY * SESSION_VIEWER_DEFAULT_ASPECT) + 40;
    expect(resolveSessionViewerBodyAspect(null, width)).toBe(SESSION_VIEWER_DEFAULT_ASPECT);
  });

  it('falls back to the default shape before the frame has a width', () => {
    expect(resolveSessionViewerBodyAspect(null, 0)).toBe(SESSION_VIEWER_DEFAULT_ASPECT);
  });
});

describe('resolveSessionViewerCentredInset', () => {
  it('moves centred content into the free width beside a floating frame', () => {
    const rect = { x: 530, y: 360, width: 400, height: 300 };
    const inset = resolveSessionViewerCentredInset({ areaWidth: 946, contentBottom: 700, rect });
    expect(inset).toEqual({ left: 0, right: 946 - (rect.x - SESSION_VIEWER_EDGE), bottom: 0 });
  });

  it('rests above the frame, at full width, when the width beside it is too narrow for the tile', () => {
    // A Details pane narrows the transcript to 536: the frame leaves a sliver beside it.
    const rect = { x: 68, y: 314, width: 450, height: 375 };
    const inset = resolveSessionViewerCentredInset({ areaWidth: 536, contentBottom: 737, rect });
    expect(inset.left).toBe(0);
    expect(inset.right).toBe(0);
    expect(737 - inset.bottom).toBeLessThanOrEqual(rect.y - SESSION_VIEWER_EDGE);
    expect(737 - inset.bottom).toBeGreaterThan(0);
  });
});
