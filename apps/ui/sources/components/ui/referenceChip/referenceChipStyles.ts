import { motionTokens } from '@/components/ui/motion/motionTokens';
import { REFERENCE_CHIP_FILL_ALPHA } from './referenceChipFill';

/**
 * The one presentation of an inline reference chip on web (lab CA, "quiet ink"): the composer's chip
 * node and the transcript's `happier-ref` link both take their anatomy from here.
 *
 * One line, 20 px tall so it never changes the height of the line it sits on, a 14 px glyph or picture
 * and the label at the surrounding body size in medium weight, ink at low alpha behind it. Colour is
 * left free for state: hover deepens the ink, a range selection paints it like selected text, a
 * keyboard-selected chip takes the one focus ring, and pending, unavailable and removed chips dim.
 *
 * The ink roles arrive as custom properties from the host that knows the theme
 * ({@link referenceChipCssVariables}); the fill is derived from the text colour the chip stands in,
 * so it holds on every surface and theme without a second palette.
 */

export const REFERENCE_CHIP_MAX_LABEL_PX = 240;

const FILL = `color-mix(in srgb, currentColor ${REFERENCE_CHIP_FILL_ALPHA * 100}%, transparent)`;
const FILL_HOVER = 'color-mix(in srgb, currentColor 11%, transparent)';
const FILL_PRESS = 'color-mix(in srgb, currentColor 14%, transparent)';
const FILL_SELECTED =
  'color-mix(in srgb, var(--happier-ref-accent, Highlight) 26%, transparent)';

/** The chip's box, shared by the composer's node and the transcript's link. */
const BOX = [
  'box-sizing: border-box',
  'height: 20px',
  'line-height: 20px',
  `max-width: ${REFERENCE_CHIP_MAX_LABEL_PX}px`,
  'padding: 0 6px 0 4px',
  'margin: 0 1px',
  'border-radius: 6px',
  'vertical-align: middle',
  'position: relative',
  'top: -1px',
  'white-space: nowrap',
  'overflow: hidden',
  'text-overflow: ellipsis',
  'font-size: inherit',
  'font-weight: 500',
  'text-decoration: none',
  `background-color: ${FILL}`,
  `transition: background-color ${motionTokens.durationMs.hover}ms ${motionTokens.easingCss.standard}`,
].join('; ');

/** The glyph: a 14 px box painting the icon's drawing through a mask in the secondary ink. */
const GLYPH = [
  'display: inline-block',
  'flex: none',
  'width: 14px',
  'height: 14px',
  'margin-right: 4px',
  'vertical-align: -2px',
  'background-color: var(--happier-ref-ink2, currentColor)',
  '-webkit-mask: var(--happier-ref-glyph) center / 13px 13px no-repeat',
  'mask: var(--happier-ref-glyph) center / 13px 13px no-repeat',
].join('; ');

/** A picture reference shows the picture itself as its glyph. */
const THUMB = [
  'display: inline-block',
  'flex: none',
  'width: 14px',
  'height: 14px',
  'margin-right: 4px',
  'vertical-align: -2px',
  'border-radius: 3px',
  'overflow: hidden',
  'box-shadow: inset 0 0 0 0.5px color-mix(in srgb, currentColor 18%, transparent)',
  'background: var(--happier-ref-thumb) center / cover no-repeat',
].join('; ');

const COMPOSER_CSS = `
[data-happier-ref-chip] { display: inline-flex; align-items: center; ${BOX}; cursor: default; user-select: none; -webkit-user-select: none; }
[data-happier-ref-chip] > [data-happier-ref-glyph] { ${GLYPH}; }
[data-happier-ref-chip] > [data-happier-ref-thumb] { ${THUMB}; position: relative; }
[data-happier-ref-chip] > [data-happier-ref-thumb] > * { position: absolute; inset: 0; width: 100% !important; height: 100% !important; }
[data-happier-ref-chip] > [data-happier-ref-label] { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
@media (hover: hover) and (pointer: fine) {
  [data-happier-ref-chip][data-state="ready"]:hover, [data-happier-ref-chip][data-hovered] { background-color: ${FILL_HOVER}; }
  [data-happier-ref-chip][data-state="ready"]:active { background-color: ${FILL_PRESS}; }
}
[data-happier-ref-chip][data-state="pending"] { color: var(--happier-ref-ink2, inherit); }
[data-happier-ref-chip][data-state="pending"] > [data-happier-ref-thumb] { opacity: 0.45; }
[data-happier-ref-chip][data-state="unavailable"] { color: var(--happier-ref-ink3, inherit); }
[data-happier-ref-chip][data-state="unavailable"] > [data-happier-ref-glyph] { background-color: var(--happier-ref-ink3, currentColor); }
[data-happier-ref-chip][data-state="removed"] { color: var(--happier-ref-ink3, inherit); background-color: transparent; outline: 1px dashed color-mix(in srgb, currentColor 26%, transparent); outline-offset: -1px; }
[data-happier-ref-chip][data-state="removed"] > [data-happier-ref-glyph] { background-color: var(--happier-ref-ink3, currentColor); }
[data-composer-chip][data-in-selection] > [data-happier-ref-chip] { background-color: ${FILL_SELECTED}; color: inherit; outline: none; }
[data-composer-chip][data-in-selection] > [data-happier-ref-chip] > [data-happier-ref-glyph] { background-color: currentColor; }
[data-composer-chip][data-selected] > [data-happier-ref-chip] { box-shadow: 0 0 0 2px var(--happier-ref-gap, transparent), 0 0 0 3.5px var(--happier-ref-focus, Highlight); }
[data-composer-chip] { display: inline; }
[data-composer-chip][data-entering] > [data-happier-ref-chip] { animation: happierRefChipEnter ${motionTokens.durationMs.base}ms ${motionTokens.easingCss.standard}; }
@keyframes happierRefChipEnter { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }
[data-composer-drop-caret] { display: inline-block; position: relative; width: 0; height: 1.25em; vertical-align: text-bottom; pointer-events: none; }
[data-composer-drop-caret]::after { content: ""; position: absolute; left: -1px; top: 0; bottom: 0; width: 2px; border-radius: 1px; background: var(--happier-ref-accent, Highlight); animation: happierRefCaretIn ${motionTokens.durationMs.fast}ms ${motionTokens.easingCss.standard}; }
@keyframes happierRefCaretIn { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  [data-happier-ref-chip] { transition: none; }
  [data-composer-chip][data-entering] > [data-happier-ref-chip], [data-composer-drop-caret]::after { animation: none; }
}
`;

const STYLE_ELEMENT_ID = 'happier-reference-chip-styles';

/** Installs the chip's shared rules once per document. */
export function ensureReferenceChipStyles(): void {
  if (
    typeof document === 'undefined' ||
    document.getElementById(STYLE_ELEMENT_ID)
  )
    return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = COMPOSER_CSS;
  document.head.appendChild(style);
}

export type ReferenceChipInks = Readonly<{
  secondary: string;
  tertiary: string;
  accent: string;
  focus: string;
}>;

/** The ink roles a chip reads, as custom properties for the element that hosts chips. */
export function referenceChipCssVariables(
  inks: ReferenceChipInks,
): Readonly<Record<string, string>> {
  return {
    '--happier-ref-ink2': inks.secondary,
    '--happier-ref-ink3': inks.tertiary,
    '--happier-ref-accent': inks.accent,
    '--happier-ref-focus': inks.focus,
  };
}

function cssString(value: string): string {
  return value.replace(
    /["\\\n\r]/g,
    (char) => `\\${char === '\n' ? 'a ' : char === '\r' ? 'd ' : char}`,
  );
}

/**
 * The rules for one reference drawn as a Markdown link, which the package renders itself: the same
 * box, with the glyph or picture painted before the label.
 */
export function referenceChipLinkRule(
  selector: string,
  input: Readonly<{
    color: string;
    /** The caller's fill (the quiet-ink fill for the app's own references). */
    background: string;
    inks: ReferenceChipInks;
    glyphUrl?: string | null;
    thumbnailUri?: string | null;
  }>,
): string {
  const variables = Object.entries(referenceChipCssVariables(input.inks))
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');
  const lead = input.thumbnailUri
    ? `${selector}::before { content: ""; ${THUMB}; --happier-ref-thumb: url("${cssString(input.thumbnailUri)}"); }`
    : input.glyphUrl
      ? `${selector}::before { content: ""; ${GLYPH}; --happier-ref-glyph: ${input.glyphUrl}; }`
      : '';
  return [
    `${selector} { display: inline-block; ${BOX}; color: ${input.color} !important; background-color: ${input.background}; text-decoration: none !important; ${variables} cursor: pointer; }`,
    `@media (hover: hover) and (pointer: fine) { ${selector}:hover { background-color: ${FILL_HOVER}; } ${selector}:active { background-color: ${FILL_PRESS}; } }`,
    lead,
  ]
    .filter(Boolean)
    .join('\n');
}
