import { describe, expect, it } from 'vitest';

import { resolveHappierListDetailGeometry } from './listDetailGeometry.js';

const readingMeasures = {
  minListWidth: 300,
  minDetailWidth: 400,
  preferredListRatio: 0.4,
  gap: 12,
};

describe('list/detail readable geometry', () => {
  it('clamps a remembered pixel width without changing the stacking threshold', () => {
    expect(resolveHappierListDetailGeometry({ ...readingMeasures, availableWidth: 1012, listWidthPx: 350 })).toEqual({ mode: 'split', listRatio: 0.35, detailWidthPx: 650 });
    expect(resolveHappierListDetailGeometry({ ...readingMeasures, availableWidth: 1012, listWidthPx: 50 })).toEqual({ mode: 'split', listRatio: 0.3, detailWidthPx: 700 });
    expect(resolveHappierListDetailGeometry({ ...readingMeasures, availableWidth: 1012, listWidthPx: 900 })).toEqual({ mode: 'split', listRatio: 0.6, detailWidthPx: 400 });
    expect(resolveHappierListDetailGeometry({ ...readingMeasures, availableWidth: 711, listWidthPx: 350 })).toEqual({ mode: 'stacked' });
  });
  it('includes the gutter when deciding whether the panes fit', () => {
    expect(resolveHappierListDetailGeometry({ ...readingMeasures, availableWidth: 711 })).toEqual({ mode: 'stacked' });
    expect(resolveHappierListDetailGeometry({ ...readingMeasures, availableWidth: 712 })).toEqual({
      mode: 'split', listRatio: 300 / 700, detailWidthPx: 400,
    });
    expect(resolveHappierListDetailGeometry({ ...readingMeasures, availableWidth: 0 })).toEqual({ mode: 'stacked' });
  });

  it('keeps the requested ratio only while both panes remain readable', () => {
    expect(resolveHappierListDetailGeometry({ ...readingMeasures, availableWidth: 1012 })).toEqual({
      mode: 'split', listRatio: 0.4, detailWidthPx: 600,
    });
    expect(resolveHappierListDetailGeometry({
      ...readingMeasures, availableWidth: 1012, preferredListRatio: 0.2,
    })).toEqual({ mode: 'split', listRatio: 0.3, detailWidthPx: 700 });
    expect(resolveHappierListDetailGeometry({
      ...readingMeasures, availableWidth: 1012, preferredListRatio: 0.9,
    })).toEqual({ mode: 'split', listRatio: 0.6, detailWidthPx: 400 });
  });
});
