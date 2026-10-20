import { useCallback, useMemo, useState } from 'react';
import { useResizableSize, type DockedPaneResizeCommitMeta } from '../layout/resize/useResizableSize.js';
import { resolveHappierListDetailGeometry } from './listDetailGeometry.js';

/**
 * Width controls for a layout's own list/detail split. Collection's installed
 * app-details-pane placement keeps the host pane's width owner instead.
 */
export type HappierCollectionRailSizingProps = Readonly<{
  listWidthPx?: number;
  /** Live controlled geometry; persistence belongs in onListWidthCommit. */
  onListWidthChange?: (widthPx: number) => void;
  onListWidthCommit?: (widthPx: number) => void;
  onListWidthReset?: () => void;
  resizeKey?: string;
}>;

/** Shared rail geometry for the standalone split and Collection's composed split. */
export function useResizableListDetailGeometry(input: HappierCollectionRailSizingProps & Readonly<{
  availableWidth: number | null;
  minListWidth: number;
  minDetailWidth: number;
  preferredListRatio: number;
  gap: number;
}>) {
  const [rememberedWidths, setRememberedWidths] = useState<Readonly<Record<string, number>>>({});
  const [dragMeta, setDragMeta] = useState<DockedPaneResizeCommitMeta | null>(null);
  const memoryKey = input.resizeKey ?? '';
  const width = input.listWidthPx ?? rememberedWidths[memoryKey];
  const base = useMemo(() => input.availableWidth === null ? null : resolveHappierListDetailGeometry({
    availableWidth: input.availableWidth, minListWidth: input.minListWidth, minDetailWidth: input.minDetailWidth,
    preferredListRatio: input.preferredListRatio, gap: input.gap, listWidthPx: width,
  }), [input.availableWidth, input.minListWidth, input.minDetailWidth, input.preferredListRatio, input.gap, width]);
  const paneWidth = (input.availableWidth ?? 0) - input.gap;
  const commit = useCallback((widthPx: number) => {
    // A bound commit owner is the preference authority, including when its default is unset.
    if (input.listWidthPx === undefined && input.onListWidthCommit === undefined) {
      setRememberedWidths(current => ({ ...current, [memoryKey]: widthPx }));
    }
    input.onListWidthChange?.(widthPx);
    input.onListWidthCommit?.(widthPx);
  }, [input.listWidthPx, input.onListWidthChange, input.onListWidthCommit, memoryKey]);
  const reset = useCallback(() => {
    setDragMeta(null);
    setRememberedWidths(current => {
      if (current[memoryKey] === undefined) return current;
      const next = { ...current };
      delete next[memoryKey];
      return next;
    });
    input.onListWidthReset?.();
  }, [input.onListWidthReset, memoryKey]);
  const resize = useResizableSize({
    axis: 'x', resizeEdge: 'end',
    sizePx: base?.mode === 'split' ? paneWidth * base.listRatio : input.minListWidth,
    minSizePx: input.minListWidth,
    maxSizePx: Math.max(input.minListWidth, paneWidth - input.minDetailWidth),
    onCommitSizePx: commit,
    onDragSizePx: (value, meta) => {
      setDragMeta(meta ?? null);
      if (value !== null) input.onListWidthChange?.(value);
    },
    onResetRequest: reset,
  });
  const layout = useMemo(() => base?.mode !== 'split' ? base : resolveHappierListDetailGeometry({
    availableWidth: input.availableWidth!, minListWidth: input.minListWidth, minDetailWidth: input.minDetailWidth,
    preferredListRatio: input.preferredListRatio, gap: input.gap, listWidthPx: resize.effectiveSizePx,
  }), [base, input.availableWidth, input.minListWidth, input.minDetailWidth, input.preferredListRatio, input.gap, resize.effectiveSizePx]);
  return { layout, resize, dragMeta };
}
