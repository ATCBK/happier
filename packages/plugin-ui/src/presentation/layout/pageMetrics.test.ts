import { describe, expect, it } from 'vitest';

import { isHappierSectionActionStacked, resolveHappierPageBackMeasuringLine, resolveHappierPageBackPlacement } from './pageMetrics.js';

describe('isHappierSectionActionStacked', () => {
  // A Work pane section at the pane's default width: a short title beside an ⓘ and a +.
  const narrowPane = { headerWidthPx: 251, actionWidthPx: 70, gapPx: 12 };

  it('moves a labelled action under the text when the text column would get too narrow', () => {
    expect(isHappierSectionActionStacked({ ...narrowPane, actionLayout: 'inline' })).toBe(true);
  });

  it('moves a labelled action beneath a described section on a phone, beside a title-only one', () => {
    // A 390pt phone page: "+ Add connection" fits beside the text column, but beside a description
    // it would sit against wrapped explanation lines (anatomy: on narrow widths it drops beneath).
    const phone = { headerWidthPx: 358, actionWidthPx: 132, gapPx: 12, actionLayout: 'inline' as const };
    expect(isHappierSectionActionStacked({ ...phone, hasDescription: true })).toBe(true);
    expect(isHappierSectionActionStacked({ ...phone, hasDescription: false })).toBe(false);
    // A desktop page keeps it beside the description.
    expect(isHappierSectionActionStacked({ ...phone, headerWidthPx: 704, hasDescription: true })).toBe(false);
  });

  it('keeps a trailing icon cluster on the title line at any width', () => {
    expect(isHappierSectionActionStacked({ ...narrowPane, actionLayout: 'trailing' })).toBe(false);
    expect(isHappierSectionActionStacked({ headerWidthPx: 180, actionWidthPx: null, actionLayout: 'trailing', gapPx: 12 })).toBe(false);
  });
});

describe('resolveHappierPageBackPlacement', () => {
  const columnMaxWidthPx = 720;

  it('puts back in the gutter where the space left of the content edge holds it', () => {
    expect(resolveHappierPageBackPlacement({ paneWidthPx: 1100, columnMaxWidthPx })).toBe('gutter');
  });

  it('puts back on its own line above the title when the column fills the pane, never before the title', () => {
    // A Team's sub-page beside the Teams rail at 1440: the column fills the ~725px pane.
    expect(resolveHappierPageBackPlacement({ paneWidthPx: 725, columnMaxWidthPx })).toBe('above-title');
  });

  it('waits for the pane to be measured', () => {
    expect(resolveHappierPageBackPlacement({ paneWidthPx: null, columnMaxWidthPx })).toBeNull();
  });

  it('places nothing when no back will render, so a narrow pane keeps zero extra space', () => {
    expect(resolveHappierPageBackPlacement({ paneWidthPx: 725, columnMaxWidthPx, backShown: false })).toBeNull();
    expect(resolveHappierPageBackPlacement({ paneWidthPx: 725, columnMaxWidthPx, backShown: true })).toBe('above-title');
  });
});

describe('resolveHappierPageBackMeasuringLine', () => {
  it('reserves the line above the title while measuring a detail beside a collection list', () => {
    // Beside a list the pane is narrow by construction: reserve the line, so the header never grows.
    expect(resolveHappierPageBackMeasuringLine({ backShown: true, collectionMode: 'split' })).toBe(true);
  });

  it('keeps the gutter assumption on a page that is not beside a list', () => {
    expect(resolveHappierPageBackMeasuringLine({ backShown: true, collectionMode: null })).toBe(false);
    expect(resolveHappierPageBackMeasuringLine({ backShown: true, collectionMode: 'stacked' })).toBe(false);
    expect(resolveHappierPageBackMeasuringLine({ backShown: true, collectionMode: 'measuring' })).toBe(false);
  });

  it('reserves nothing for a page whose back is hidden (a collection-root detail beside its list)', () => {
    expect(resolveHappierPageBackMeasuringLine({ backShown: false, collectionMode: 'split' })).toBe(false);
  });
});
