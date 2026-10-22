import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import type { TriageListLoadMoreV1 } from '../../projection/listWindowStore.js';
import { parseTriageRouteSubPathV1 } from '../navigation/location.js';
import { sameTriageEntryRefV1 } from '../state/surface.js';

/**
 * What a settled page says about a location naming an entry nothing it can
 * read holds (`core/SURFACE.md` §3.1).
 *
 * An identity-only location carries no connection, so the page can only adopt
 * it from a row some window lists. While the walk can still continue, the
 * acquisition owner keeps going and there is nothing to say. Once it cannot —
 * every connection finished its walk, or the result is incomplete with no
 * frontier to resume from — the location is a request the page cannot serve,
 * and the list alone would read as if the link did nothing.
 *
 * The answer is a presentation fact only: it keeps the requested ref and
 * names whether the result was complete. It never selects the entry, never
 * reconstructs a connection from the route and never asks for a detail read.
 *
 * `failed` and `loading` are not terminal (a retry or a pending append is
 * still the owner's), and neither is a refresh in flight.
 */
export type TriageAbsentRouteV1 = Readonly<{
  entryRef: TriageEntryRefV1;
  /** The window was complete (`exhausted`) or only the part it could read (`unresumable`). */
  coverage: 'complete' | 'incomplete';
}>;

export function readTriageAbsentRouteV1(input: Readonly<{
  subPath: string | undefined;
  /** Whether a window was ever assembled; before one, absence is unknown, not false. */
  windowSettled: boolean;
  /** The reducer already holds a selection, so the location was answered. */
  selected: boolean;
  pending: 'idle' | 'initial' | 'refresh';
  loadMore: TriageListLoadMoreV1 | undefined;
  /** Every row the page lists, pins included: any of them answers the location. */
  rowsByKey: ReadonlyMap<string, Readonly<{ row: Readonly<{ entryRef: TriageEntryRefV1 }> }>>;
}>): TriageAbsentRouteV1 | null {
  if (!input.windowSettled || input.selected || input.pending !== 'idle') return null;
  const kind = input.loadMore?.kind;
  if (kind !== 'exhausted' && kind !== 'unresumable') return null;
  const located = parseTriageRouteSubPathV1(input.subPath).selection;
  if (located === null) return null;
  for (const hit of input.rowsByKey.values()) {
    if (sameTriageEntryRefV1(hit.row.entryRef, located)) return null;
  }
  return { entryRef: located, coverage: kind === 'exhausted' ? 'complete' : 'incomplete' };
}
