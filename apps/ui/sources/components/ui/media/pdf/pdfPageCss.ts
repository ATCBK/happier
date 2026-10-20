/**
 * The one stylesheet for pdf.js pages, used by the web viewer (injected once per theme) and by the
 * native WebView document. Pages are always-white paper with an ink hairline on the inset well (lab
 * files FV5); the text layer is pdf.js's own transparent selection layer; Find marks use the theme's
 * find roles. Values arrive from the theme owner, never as literals here.
 */
export type PdfPageCssColors = Readonly<{
  well: string;
  paper: string;
  hairline: string;
  matchAll: string;
  matchCurrent: string;
}>;

export type PdfPageCssMetrics = Readonly<{
  /** Gap between pages and around the column (`theme.space.s16`). */
  gap: number;
}>;

export function buildPdfPageCss(
  scope: string,
  colors: PdfPageCssColors,
  metrics: PdfPageCssMetrics,
): string {
  return `
${scope} { background: ${colors.well}; overflow: auto; display: flex; flex-direction: column; align-items: center;
  gap: ${metrics.gap}px; padding: ${metrics.gap}px; box-sizing: border-box; overscroll-behavior: contain; }
${scope}[data-pdf-viewer="stage"] { background: transparent; }
${scope} .pdf-page { position: relative; flex: none; background: ${colors.paper}; box-shadow: 0 0 0 1px ${colors.hairline}; overflow: hidden; }
${scope} .pdf-page-canvas { position: absolute; inset: 0; display: block; }
${scope} .textLayer { position: absolute; text-align: initial; inset: 0; overflow: clip; opacity: 1; line-height: 1;
  -webkit-text-size-adjust: none; text-size-adjust: none; forced-color-adjust: none; transform-origin: 0 0; z-index: 0;
  --min-font-size: 1; --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size)); --min-font-size-inv: calc(1 / var(--min-font-size)); }
${scope} .textLayer :is(span, br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; user-select: text; -webkit-user-select: text; }
${scope} .textLayer > :not(.markedContent), ${scope} .textLayer .markedContent span:not(.markedContent) { z-index: 1; --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height)); --scale-x: 1; --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv)); }
${scope} .textLayer .markedContent { display: contents; }
${scope} .textLayer .endOfContent { display: block; position: absolute; inset: 100% 0 0; z-index: 0; cursor: default; user-select: none; }
${scope} .textLayer mark[data-pdf-find-match] { color: transparent; background: ${colors.matchAll}; border-radius: 2px; }
${scope} .textLayer mark[data-pdf-find-current] { background: ${colors.matchCurrent}; }
`;
}
