export type HappierListDetailLayoutState =
  /** `detailWidthPx` is the detail pane's width, known as soon as the split is, for what renders inside it. */
  | Readonly<{ mode: 'split'; listRatio: number; detailWidthPx: number }>
  | Readonly<{ mode: 'stacked' }>;

/** Pane minima and the ratio preference belong to the content's owner. */
export function resolveHappierListDetailGeometry(input: Readonly<{
  availableWidth: number;
  minListWidth: number;
  minDetailWidth: number;
  preferredListRatio: number;
  /** Remembered device-local width; the pane minima still decide whether the split fits. */
  listWidthPx?: number;
  gap: number;
}>): HappierListDetailLayoutState {
  const paneWidth = input.availableWidth - input.gap;
  if (!Number.isFinite(paneWidth) || paneWidth <= 0
    || paneWidth < input.minListWidth + input.minDetailWidth) {
    return { mode: 'stacked' };
  }

  const listWidth = Math.min(
    Math.max(input.listWidthPx ?? input.preferredListRatio * paneWidth, input.minListWidth),
    paneWidth - input.minDetailWidth,
  );
  return { mode: 'split', listRatio: listWidth / paneWidth, detailWidthPx: paneWidth - listWidth };
}
