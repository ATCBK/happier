import { PLANET_LIGHT_RAMP, PLANET_PALETTES } from '@happier-dev/brand/planet';
import { withUsageAccentAlpha } from '../../usageAccent';
import type { UsageRecapFormat, UsageRecapStyle } from './usageStatCardModel';

/**
 * The private stat card's named palette (an art-directed image, AGENTS "bounded art-directed
 * experience"): every colour comes from the Brand planet palette, the one owner of Daybreak art, so the
 * seven styles stay one family and follow the person's light/dark choice. Styles change art and ink
 * only; the facts and their layout are the one renderer's.
 */
export type UsageStatCardTone = 'light' | 'dark';
export type UsageStatCardArt =
  | 'planet'
  | 'sigil'
  | 'rules'
  | 'glass'
  | 'holo'
  | 'skyline'
  | 'terminal';
export type UsageStatCardPalette = Readonly<{
  art: UsageStatCardArt;
  background: string;
  /** Optional second background stop (top → bottom). */
  backgroundEnd?: string;
  ink: string;
  inkSecondary: string;
  inkFaint: string;
  rule: string;
  /** Category colours for mix bars and rings, in rank order. */
  series: readonly string[];
  /** A panel under the facts (Glass's frosted sheet, Holo's card). */
  panel?: Readonly<{ fill: string; border: string }>;
  mono: boolean;
  /** Headline weight: Editorial reads light and large, the rest semibold. */
  headlineWeight: 'regular' | 'semiBold';
}>;

const rgb = (value: readonly [number, number, number]) =>
  `#${value
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;

const PAPER = rgb(PLANET_PALETTES.light.background);
const NIGHT = rgb(PLANET_PALETTES.dark.background);
const SERIES = [
  PLANET_LIGHT_RAMP.warm,
  PLANET_LIGHT_RAMP.blush,
  PLANET_LIGHT_RAMP.violet,
  PLANET_LIGHT_RAMP.cool,
  PLANET_LIGHT_RAMP.deep,
];

function base(tone: UsageStatCardTone) {
  const palette = PLANET_PALETTES[tone];
  // Ink is the opposite planet background: warm paper on the night sky, deep night on paper.
  const ink = tone === 'dark' ? PAPER : NIGHT;
  return {
    background: palette.horizon.backgroundColor,
    ink,
    inkSecondary: withUsageAccentAlpha(ink, 0.66),
    inkFaint: withUsageAccentAlpha(ink, 0.38),
    rule: withUsageAccentAlpha(ink, 0.12),
    series: SERIES,
    mono: false,
    headlineWeight: 'semiBold' as const,
  };
}

export function resolveUsageStatCardPalette(
  style: UsageRecapStyle,
  tone: UsageStatCardTone,
): UsageStatCardPalette {
  const shared = base(tone);
  const dark = PLANET_PALETTES.dark;
  const light = PLANET_PALETTES.light;
  switch (style) {
    case 'daybreak':
      return { ...shared, art: 'planet' };
    case 'sigil':
      return { ...shared, art: 'sigil' };
    case 'editorial':
      return { ...shared, art: 'rules', headlineWeight: 'regular' };
    case 'glass': {
      const orb = tone === 'dark' ? dark.orb : light.orb;
      const ink = tone === 'dark' ? PAPER : NIGHT;
      return {
        ...shared,
        art: 'glass',
        background: orb.gold,
        backgroundEnd: tone === 'dark' ? dark.orb.plum : light.orb.plum,
        ink,
        inkSecondary: withUsageAccentAlpha(ink, 0.72),
        inkFaint: withUsageAccentAlpha(ink, 0.46),
        rule: withUsageAccentAlpha(ink, 0.18),
        panel: {
          fill: withUsageAccentAlpha(
            light.orb.veil,
            tone === 'dark' ? 0.12 : 0.42,
          ),
          border: withUsageAccentAlpha(
            light.orb.veil,
            tone === 'dark' ? 0.28 : 0.7,
          ),
        },
      };
    }
    case 'holo': {
      // A collector card: always the night sky, whatever the app's theme.
      const ink = PAPER;
      return {
        ...shared,
        art: 'holo',
        background: dark.orb.abyss,
        backgroundEnd: dark.horizon.backgroundColor,
        ink,
        inkSecondary: withUsageAccentAlpha(ink, 0.7),
        inkFaint: withUsageAccentAlpha(ink, 0.42),
        rule: withUsageAccentAlpha(ink, 0.14),
        panel: {
          fill: withUsageAccentAlpha(dark.orb.core, 0.18),
          border: withUsageAccentAlpha(dark.orb.amber, 0.55),
        },
      };
    }
    case 'skyline':
      return { ...shared, art: 'skyline' };
    case 'terminal': {
      const ink = tone === 'dark' ? PAPER : NIGHT;
      return {
        ...shared,
        art: 'terminal',
        background:
          tone === 'dark'
            ? dark.horizon.backgroundColor
            : light.horizon.backgroundColor,
        ink,
        inkSecondary: withUsageAccentAlpha(ink, 0.68),
        inkFaint: withUsageAccentAlpha(ink, 0.4),
        rule: withUsageAccentAlpha(ink, 0.16),
        mono: true,
        headlineWeight: 'regular',
      };
    }
  }
}

/** Logical card sizes; capture scales them by the device pixel ratio. */
export const USAGE_STAT_CARD_SIZES: Readonly<
  Record<UsageRecapFormat, Readonly<{ width: number; height: number }>>
> = {
  square: { width: 540, height: 540 },
  story: { width: 405, height: 720 },
  'link-preview': { width: 600, height: 315 },
};

/** Type scale relative to the card (an image at a fixed size, not app text). */
export const USAGE_STAT_CARD_TYPE = {
  caption: 13,
  headline: { square: 104, story: 96, 'link-preview': 72 },
  unit: 20,
  legend: 12,
  footer: 11,
} as const;

/**
 * How the card's body sits: every admitted stat and every selected mix is drawn, so the stats grid steps
 * its columns and type down, and the headline gives back room, as the selection grows (a fixed-size
 * image cannot scroll). Pure: counts in, metrics out.
 */
export type UsageStatCardLayout = Readonly<{
  columns: number;
  value: number;
  label: number;
  cellPadding: number;
  headline: number;
  gap: number;
  /** Two mixes share one row on the short link-preview card. */
  mixesInline: boolean;
  /**
   * The most legend rows one mix draws before its tail folds into "+N more"; null draws every row. Only the
   * short link-preview image, which cannot scroll, folds.
   */
  mixRows: number | null;
}>;

/** What the short link-preview image needs to know to keep its footer inside the canvas. */
export type UsageStatCardFit = Readonly<{
  /** Money rows above the facts grid: the selected total, then its comparisons. */
  hasLead: boolean;
  hasComparisons: boolean;
  /** The longest legend any drawn mix shows before its tail folds. */
  mixRowCount: number;
  hasHeadline: boolean;
  /** Panel and mono styles give each figure less room, so their labels wrap. */
  wrapsLabels: boolean;
  panel: boolean;
}>;

/** Logical px of the link-preview canvas (315) less its padding (2 x 32) and the period line. */
const LINK_PREVIEW_BODY_BUDGET = 233;
const LINK_PREVIEW_LEVELS: readonly Readonly<{ headline: number; gap: number; mixRows: number }>[] = [
  { headline: 72, gap: 12, mixRows: 5 },
  { headline: 60, gap: 12, mixRows: 5 },
  { headline: 52, gap: 6, mixRows: 3 },
  { headline: 44, gap: 6, mixRows: 3 },
  { headline: 44, gap: 6, mixRows: 2 },
  { headline: 36, gap: 6, mixRows: 2 },
  { headline: 30, gap: 4, mixRows: 2 },
  { headline: 30, gap: 4, mixRows: 1 },
];

/**
 * The short link-preview image cannot scroll, so its body is the one part the selection can overflow: it
 * steps the headline, gaps and legend rows down until the estimated height fits (measured on the live card
 * with every field on; labels are assumed to wrap in the styles that squeeze them).
 */
function resolveLinkPreviewFit(
  grid: Readonly<{ value: number; label: number; cellPadding: number }>,
  counts: Readonly<{ facts: number; columns: number; mixGroups: number; lead: number; comparisons: number; mixRowCap: number | null }>,
  fit: UsageStatCardFit,
) {
  const factRows = counts.facts > 0 ? Math.ceil(counts.facts / counts.columns) : 0;
  const factRow = 2 * grid.cellPadding + grid.value * 1.15 + grid.label * 1.25 * 2 + 14;
  const comparisonRow = 2 * grid.cellPadding + Math.max(12, grid.value * 0.75) * 1.15
    + grid.label * 1.25 * (fit.wrapsLabels ? 2 : 1) + 6;
  const leadRow = 2 * grid.cellPadding + grid.value * 1.5 * 1.15 + grid.label * 1.25 + 4;
  const stats = counts.lead * leadRow + counts.comparisons * comparisonRow + factRows * factRow
    + (fit.panel && (counts.lead + counts.comparisons + factRows) > 0 ? 10 : 0);
  const blocks = (fit.hasHeadline ? 1 : 0) + (counts.mixGroups > 0 ? 1 : 0) + (stats > 0 ? 1 : 0) + 1;
  const estimate = (level: (typeof LINK_PREVIEW_LEVELS)[number]) => {
    const rows = counts.mixRowCap === null ? 0 : Math.min(level.mixRows, counts.mixRowCap, fit.mixRowCount);
    return (fit.hasHeadline ? Math.max(26, level.headline * 1.02) : 0)
      + (counts.mixGroups > 0 ? 28 + 21 * rows : 0)
      + stats + 14 + (blocks - 1) * level.gap;
  };
  const level = LINK_PREVIEW_LEVELS.find(candidate => estimate(candidate) <= LINK_PREVIEW_BODY_BUDGET)
    ?? LINK_PREVIEW_LEVELS[LINK_PREVIEW_LEVELS.length - 1]!;
  return {
    headline: level.headline,
    gap: level.gap,
    mixRows: counts.mixRowCap === null ? null : Math.min(level.mixRows, counts.mixRowCap),
  };
}

/**
 * `statCount` counts the facts grid's cells; each money row above it (the lead total, then its comparisons)
 * weighs on the headline and the density like two more cells.
 */
/** The semibold tabular figure's average advance, as a share of its size (Inter, slightly tightened). */
const STAT_FIGURE_ADVANCE_EM = 0.62;

/**
 * A stat figure stays on one line: when its text would not fit its cell at the grid's size it steps
 * down until it does ("112.1M" in a 4-up row), never wrapping its unit onto a second line.
 */
export function fitUsageStatFigureSize(text: string, size: number, width: number): number {
  const needed = text.length * size * STAT_FIGURE_ADVANCE_EM;
  if (needed <= width || text.length === 0) return size;
  return Math.max(1, Math.floor((width / (text.length * STAT_FIGURE_ADVANCE_EM)) * 10) / 10);
}

export function resolveUsageStatCardLayout(
  format: UsageRecapFormat,
  factCount: number,
  mixGroupCount: number,
  fit: UsageStatCardFit,
): UsageStatCardLayout {
  const headline = USAGE_STAT_CARD_TYPE.headline[format];
  const moneyRows = (fit.hasLead ? 1 : 0) + (fit.hasComparisons ? 1 : 0);
  const statCount = factCount + moneyRows * 2;
  if (format === 'story') {
    const dense = statCount > 6;
    const grid = statCount <= 6
      ? { columns: 2, value: 30, label: 12, cellPadding: 12 }
      : statCount <= 12
        ? { columns: 3, value: 22, label: 11, cellPadding: 8 }
        : { columns: 3, value: 18, label: 10, cellPadding: 6 };
    return { ...grid, headline: dense ? headline - 12 : headline, gap: 18, mixesInline: false, mixRows: null };
  }
  if (format === 'link-preview') {
    const grid = statCount <= 3
      ? { columns: Math.max(1, statCount), value: 24, label: 11, cellPadding: 6 }
      : statCount <= 6
        ? { columns: 3, value: 18, label: 10, cellPadding: 4 }
        : { columns: 4, value: 14, label: 9, cellPadding: 1 };
    // The facts share one row (up to five across the narrow column); each figure fits its cell.
    const columns = Math.max(1, Math.min(factCount || 1, 5));
    const mixRowCap = mixGroupCount > 0 ? (statCount > 0 ? 3 : 5) : null;
    const fitted = resolveLinkPreviewFit(grid, {
      facts: factCount, columns, mixGroups: mixGroupCount, mixRowCap,
      lead: fit.hasLead ? 1 : 0, comparisons: fit.hasComparisons ? 1 : 0,
    }, fit);
    return { ...grid, columns, ...fitted, mixesInline: mixGroupCount > 1 };
  }
  const grid = statCount <= 4
    ? { columns: Math.max(1, statCount), value: 30, label: 12, cellPadding: 12 }
    : statCount <= 8
      ? { columns: 4, value: 22, label: 11, cellPadding: 8 }
      : { columns: 4, value: 18, label: 10, cellPadding: 5 };
  const load = Math.ceil(factCount / grid.columns) + moneyRows + mixGroupCount;
  return {
    ...grid,
    headline: load <= 4 ? headline : load === 5 ? 88 : load === 6 ? 76 : 64,
    gap: load <= 4 ? 14 : 10,
    mixesInline: false,
    mixRows: null,
  };
}

export const USAGE_STAT_CARD_STYLES: readonly UsageRecapStyle[] = [
  'daybreak',
  'sigil',
  'editorial',
  'glass',
  'holo',
  'skyline',
  'terminal',
];
