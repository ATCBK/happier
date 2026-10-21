import * as React from 'react';
import { Platform, type View } from 'react-native';

import { findVerticalScroller } from '@/components/ui/code/view/readCodeViewReadingLine';
import type { DiffHunkInfo } from '../diffViewerTypes';

/** The mounted change rows of one diff, so the surface can tell which change crosses its reading line. */
export type DiffHunkRowRegistry = Readonly<{
  register: (hunk: DiffHunkInfo, node: View) => () => void;
}>;

export const DiffHunkRowRegistryContext =
  React.createContext<DiffHunkRowRegistry | null>(null);

/** Where the reading line sits in the visible part of the diff (P5 §3.11: a third down). */
const READING_LINE = 1 / 3;

type Rect = Readonly<{ top: number; height: number }>;

/**
 * The change crossing the reading line: the last change whose row is at or above it. Rows may be
 * virtualized away; the row below the line still says which change the line is in.
 */
export function pickReadingLineHunk(
  rows: readonly Readonly<{ key: string; index: number; top: number }>[],
  lineY: number,
  keyAt: (index: number) => string | undefined,
): string | null {
  let above: { key: string; index: number } | null = null;
  let below: { key: string; index: number } | null = null;
  for (const row of rows) {
    if (row.top <= lineY) {
      if (!above || row.index > above.index) above = row;
    } else if (!below || row.index < below.index) below = row;
  }
  if (above && (!below || above.index === below.index - 1)) return above.key;
  if (below)
    return below.index === 0
      ? below.key
      : (keyAt(below.index - 1) ?? above?.key ?? null);
  return null;
}

function webRect(node: unknown): DOMRect | null {
  return typeof HTMLElement !== 'undefined' && node instanceof HTMLElement
    ? node.getBoundingClientRect()
    : null;
}

function measureNative(node: View | null): Promise<Rect | null> {
  return new Promise((resolve) => {
    if (!node?.measureInWindow) {
      resolve(null);
      return;
    }
    node.measureInWindow((_x, y, _width, height) =>
      resolve({ top: y, height }),
    );
  });
}

/**
 * Follows the reader on a phone: after the reader scrolls (touch or wheel), the change crossing the
 * reading line is reported through `onRead`. A move the page made itself (navigation, Keep advance)
 * never counts as reading, so it cannot pull the current change back to a neighbour.
 */
export function useDiffHunkReadingLine(
  params: Readonly<{
    enabled: boolean;
    rootRef: React.RefObject<View | null>;
    /** The change the page last moved to; a new one means the next scroll events are the page's own. */
    revealKey: string | null;
    /** Keys by change index, for a change whose row is virtualized away. */
    keys: readonly string[];
    onRead: (key: string) => void;
  }>,
) {
  const rows = React.useRef(new Map<string, { index: number; node: View }>());
  // Until the page makes its first move, any scroll is the reader's (a restored position counts too).
  const reading = React.useRef(true);
  const pending = React.useRef(false);
  const latest = React.useRef(params);
  latest.current = params;
  // The change the reading line was in when this reading began. The current change moves only when a
  // row crosses the line, so a change the page moved to stays current even where the renderer left it.
  // Before any move the reader's first scroll applies directly (`null`); after a move it is `undefined`.
  const baseline = React.useRef<string | null | undefined>(null);
  const firstReveal = React.useRef(true);
  React.useEffect(() => {
    if (params.revealKey === null) return;
    // The landing on the first change when the diff arrives is not a move.
    if (firstReveal.current) {
      firstReveal.current = false;
      return;
    }
    reading.current = false;
    baseline.current = undefined;
  }, [params.revealKey]);

  const registry = React.useMemo<DiffHunkRowRegistry>(
    () => ({
      register: (hunk, node) => {
        rows.current.set(hunk.key, { index: hunk.index, node });
        return () => {
          if (rows.current.get(hunk.key)?.node === node)
            rows.current.delete(hunk.key);
        };
      },
    }),
    [],
  );

  const measure = React.useCallback(() => {
    if (!latest.current.enabled || !reading.current || pending.current) return;
    pending.current = true;
    const settle = (
      viewport: Rect | null,
      measured: readonly ({ key: string; index: number; top: number } | null)[],
    ) => {
      pending.current = false;
      if (!viewport || viewport.height <= 0) return;
      const key = pickReadingLineHunk(
        measured.filter((row) => row !== null),
        viewport.top + viewport.height * READING_LINE,
        (index) => latest.current.keys[index],
      );
      if (baseline.current === undefined) {
        baseline.current = key;
        return;
      }
      if (key && key !== baseline.current) {
        baseline.current = key;
        latest.current.onRead(key);
      }
    };
    const entries = [...rows.current.entries()];
    if (Platform.OS === 'web') {
      requestAnimationFrame(() => {
        const root = webRect(latest.current.rootRef.current);
        const first = entries[0]?.[1].node as unknown;
        const scroller =
          typeof HTMLElement !== 'undefined' && first instanceof HTMLElement
            ? findVerticalScroller(first)
            : null;
        const box = scroller?.getBoundingClientRect() ?? root;
        if (!box) {
          pending.current = false;
          return;
        }
        // The visible part of the scroller: a page-level scroller can run past the window.
        const top = Math.max(box.top, 0);
        const bottom = Math.min(box.bottom, window.innerHeight);
        settle(
          { top, height: bottom - top },
          entries.map(([key, row]) => {
            const rect = webRect(row.node);
            return rect && rect.height > 0
              ? { key, index: row.index, top: rect.top }
              : null;
          }),
        );
      });
      return;
    }
    void Promise.all([
      measureNative(latest.current.rootRef.current),
      ...entries.map(([key, row]) =>
        measureNative(row.node).then((rect) =>
          rect ? { key, index: row.index, top: rect.top } : null,
        ),
      ),
    ]).then(([viewport, ...measured]) =>
      settle(
        viewport as Rect | null,
        measured as ({ key: string; index: number; top: number } | null)[],
      ),
    );
  }, []);

  // The diff arriving at a restored scroll position: read where it opened.
  React.useEffect(() => {
    if (params.enabled) measure();
  }, [params.enabled, measure]);

  // Web: scroll events do not bubble, so listen in the capture phase for the scroller that holds this diff.
  React.useEffect(() => {
    if (
      !params.enabled ||
      Platform.OS !== 'web' ||
      typeof window === 'undefined'
    )
      return;
    const inRoot = (target: EventTarget | null) => {
      const root = latest.current.rootRef.current as unknown;
      return (
        typeof Node !== 'undefined' &&
        root instanceof Node &&
        target instanceof Node &&
        root.contains(target)
      );
    };
    const onUser = (event: Event) => {
      if (inRoot(event.target)) reading.current = true;
    };
    const onScroll = (event: Event) => {
      const root = latest.current.rootRef.current as unknown;
      const target = event.target;
      if (!(root instanceof Node) || !(target instanceof Node)) return;
      if (target === document || target.contains(root) || root.contains(target))
        measure();
    };
    window.addEventListener('touchstart', onUser, {
      capture: true,
      passive: true,
    });
    window.addEventListener('wheel', onUser, { capture: true, passive: true });
    window.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener('touchstart', onUser, { capture: true });
      window.removeEventListener('wheel', onUser, { capture: true });
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [params.enabled, measure]);

  return {
    registry,
    /** Native: the diff's scroll events (the page's scroller), measured once per event batch. */
    onScroll: measure,
    /** Native: a touch inside the diff starts reading. */
    onTouchStart: React.useCallback(() => {
      reading.current = true;
    }, []),
  };
}
