// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

import { buildPdfPageCss } from './pdfPageCss';

/** The PDF column as a browser lays it out: pages at their zoomed size inside the scrolling well. */

const GAP = 16;
const COLORS = {
  well: '#eee',
  paper: '#fff',
  hairline: '#ccc',
  matchAll: '#ff0',
  matchCurrent: '#f80',
} as const;

let host: HTMLElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

async function measureColumn(containerWidth: number, pageWidth: number) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const style = document.createElement('style');
  style.textContent = buildPdfPageCss('[data-pdf-viewer]', COLORS, {
    gap: GAP,
  });
  document.head.appendChild(style);
  host.innerHTML =
    `<div data-pdf-viewer data-testid="viewer" style="width:${containerWidth}px;height:600px">` +
    `<div class="pdf-page" data-testid="page" style="width:${pageWidth}px;height:800px"></div></div>`;
  try {
    return await measureWebLayout(host, {
      viewport: { width: Math.max(containerWidth, 400), height: 700 },
    });
  } finally {
    style.remove();
  }
}

describe('the PDF column, as a browser lays it out', () => {
  it('keeps every part of a page wider than its well reachable, with the same scroll origin at any width', async () => {
    // A 150% page (918 px) at the phone's 390 and in the desktop pane's 600.
    for (const width of [390, 600]) {
      const layout = await measureColumn(width, 918);
      const viewer = layout.rect('viewer');
      const page = layout.rect('page');
      // At scroll 0 the page's leading edge shows, one gap in from the well's edge (never at a negative offset).
      expect(page.left - viewer.left).toBeCloseTo(GAP, 0);
      // And the scroll reaches its trailing edge plus the gap: the whole page is in the scroll range.
      expect(viewer.scrollWidth).toBeGreaterThanOrEqual(918 + 2 * GAP);
    }
  });

  it('centres a page narrower than its well', async () => {
    const layout = await measureColumn(600, 300);
    const viewer = layout.rect('viewer');
    const page = layout.rect('page');
    expect(page.left - viewer.left).toBeCloseTo((600 - 300) / 2, 0);
  });
});
