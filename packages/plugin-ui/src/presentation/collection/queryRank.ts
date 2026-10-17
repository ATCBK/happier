/**
 * The plain text a searchable row is matched by. `label` is the row's visible name; `subtitle` its
 * visible second line; `searchText` hidden metadata that may match; `exactSearchText` newline-separated
 * canonical identities (an id, a path) that count only on exact equality.
 */
export type HappierQueryText = Readonly<{
  label: string;
  subtitle?: string;
  searchText?: string;
  exactSearchText?: string;
}>;

export type HappierQueryRankOptions = Readonly<{
  /**
   * Leave the subtitle out of matching. For domains whose subtitle repeats the query's context on every
   * row (a path picker, where each child's subtitle contains its parent folder).
   */
  matchSubtitle?: boolean;
}>;

/**
 * The one query ranking for searchable lists (core pickers and the public List). A case-insensitive query
 * keeps matching items in four bands, each in the caller's order:
 *   1. the label starts with the query, or an exact identity equals it;
 *   2. the label contains it;
 *   3. the subtitle contains it;
 *   4. the hidden search text contains it.
 * Items that match nothing are dropped. An empty query returns the caller's array itself, so a list can
 * skip re-deriving its window.
 */
export function rankHappierQueryMatches<Item>(
  items: readonly Item[],
  query: string,
  textOf: (item: Item) => HappierQueryText,
  options?: HappierQueryRankOptions,
): readonly Item[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return items;
  const matchSubtitle = options?.matchSubtitle !== false;
  const bands: [Item[], Item[], Item[], Item[]] = [[], [], [], []];
  for (const item of items) {
    const text = textOf(item);
    const label = text.label.toLowerCase();
    if (
      label.startsWith(normalized) ||
      text.exactSearchText
        ?.split('\n')
        .some((value) => value.trim().toLowerCase() === normalized)
    ) {
      bands[0].push(item);
    } else if (label.includes(normalized)) {
      bands[1].push(item);
    } else if (
      matchSubtitle &&
      text.subtitle?.toLowerCase().includes(normalized)
    ) {
      bands[2].push(item);
    } else if (text.searchText?.toLowerCase().includes(normalized)) {
      bands[3].push(item);
    }
  }
  return bands.flat();
}
