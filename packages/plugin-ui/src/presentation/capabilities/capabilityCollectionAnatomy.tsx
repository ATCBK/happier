import type { ReactNode } from 'react';

import type { HappierCapabilityFactsInput } from './capabilityFacts.js';
import {
  doesHappierCapabilityStatusSpeak,
  type HappierCapabilityStatus,
} from './capabilityStatus.js';

export type HappierCapabilityCollectionAnatomyInput<Item> = Readonly<{
  title: (item: Item) => string;
  description: (item: Item) => string | null;
  /** Where it is on ("Everywhere", "2 projects"), at the title line's end and never truncated. */
  whereSummary?: (item: Item) => ReactNode;
  facts: (item: Item) => HappierCapabilityFactsInput;
  status?: (item: Item) => HappierCapabilityStatus | null;
  /** The item's identity mark; omit for kinds without one (skills), which then draw no glyph column. */
  mark?: (item: Item) => ReactNode;
  action?: (item: Item) => ReactNode;
  accessibilityLabel: (item: Item) => string;
  testID: (item: Item) => string;
}>;

/** How the caller draws each part with its own primitives. */
export type HappierCapabilityCollectionAnatomyParts = Readonly<{
  facts: (facts: HappierCapabilityFactsInput) => ReactNode;
  status: (status: HappierCapabilityStatus, testID: string) => ReactNode;
  /** A plain-text where-summary as quiet tabular meta. */
  summary: (text: string) => ReactNode;
}>;

/** Structurally the public `Collection`'s anatomy for a capability list. */
export type HappierCapabilityCollectionAnatomy<Item> = Readonly<{
  glyph: (item: Item) => ReactNode;
  title: (item: Item) => string;
  description: (item: Item) => string | null;
  titleMeta?: (item: Item) => ReactNode;
  byline: (item: Item) => ReactNode;
  reason: (item: Item) => ReactNode;
  action?: (item: Item) => ReactNode;
  accessibilityLabel: (item: Item) => string;
  testID: (item: Item) => string;
  columnTitles: Readonly<{ title: string }>;
}>;

/**
 * The capability row anatomy for the public `Collection` (an add dialog's list, a homepage shelf, a plugin's
 * installable things): name with the where-summary at the title line's end (never truncated), description, then
 * the facts line, which a speaking status takes. Kinds without a mark draw no glyph column.
 */
export function buildHappierCapabilityCollectionAnatomy<Item>(
  input: HappierCapabilityCollectionAnatomyInput<Item>,
  parts: HappierCapabilityCollectionAnatomyParts,
): HappierCapabilityCollectionAnatomy<Item> {
  const whereSummary = input.whereSummary;
  return {
    glyph: (item) => input.mark?.(item) ?? null,
    title: input.title,
    description: input.description,
    ...(whereSummary === undefined
      ? {}
      : {
          titleMeta: (item: Item) => {
            const summary = whereSummary(item);
            return typeof summary === 'string'
              ? parts.summary(summary)
              : summary;
          },
        }),
    byline: (item) => parts.facts(input.facts(item)),
    reason: (item) => {
      const status = input.status?.(item) ?? null;
      return status !== null && doesHappierCapabilityStatusSpeak(status, 'row')
        ? parts.status(status, `${input.testID(item)}:status`)
        : null;
    },
    ...(input.action === undefined ? {} : { action: input.action }),
    accessibilityLabel: input.accessibilityLabel,
    testID: input.testID,
    columnTitles: { title: '' },
  };
}
