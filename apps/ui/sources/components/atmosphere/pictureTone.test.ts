import { describe, expect, it } from 'vitest';
import { measurePictureTone } from './pictureTone';

/** A 100 × 10 picture: a night sky on the left half, a pale sky on the right, the bottom rows dissolved. */
function picture() {
  const w = 100,
    h = 10;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = (y * w + x) * 4;
      const [r, g, b] = x < 50 ? [20, 26, 40] : [235, 238, 240];
      rgba.set([r, g, b, y >= 8 ? 0 : 255], at);
    }
  }
  return { rgba, w, h };
}

describe('measurePictureTone', () => {
  it('reads the picture only where content sits, seeing a dissolved foot as the page', () => {
    const page = [245, 245, 245] as const;
    const night = measurePictureTone(picture(), page, {
      x0: 0,
      x1: 0.5,
      y0: 0,
      y1: 1,
    })!;
    // The night half is dark, but its dissolved foot (a fifth of it) reads as the light page.
    expect(night.dark).toBeLessThan(0.02);
    expect(night.focus).toBeLessThan(0.02);
    expect(night.light).toBeGreaterThan(0.85);
    const pale = measurePictureTone(picture(), page, {
      x0: 0.5,
      x1: 1,
      y0: 0,
      y1: 0.8,
    })!;
    expect(pale.dark).toBeGreaterThan(0.8);
    const whole = measurePictureTone(picture(), page, {
      x0: 0,
      x1: 1,
      y0: 0,
      y1: 0.8,
    })!;
    expect(whole.dark).toBeLessThan(0.02);
    expect(whole.light).toBeGreaterThan(0.8);
  });
  it('has no tone for an empty region', () => {
    expect(
      measurePictureTone(picture(), [0, 0, 0], {
        x0: 0.4,
        x1: 0.4,
        y0: 0,
        y1: 1,
      }),
    ).toBeUndefined();
  });
});
