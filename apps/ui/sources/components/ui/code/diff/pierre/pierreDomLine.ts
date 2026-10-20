/**
 * Pierre's DOM facts for one rendered line (version-specific, owned beside the adapter): a row carries
 * `data-line` (its number on its side) and `data-line-type`; a context row's side is its column.
 * Mirrors the library's own `getAnnotationSide` (InteractionManager) so a selection reads like a click.
 */
export const PIERRE_DIFF_HOST_SELECTOR = 'diffs-container';

type PierreDomElement = Readonly<{
  parentElement?: PierreDomElement | null;
  getAttribute?: (name: string) => string | null;
  hasAttribute?: (name: string) => boolean;
}>;

export function readPierreDomLine(
  row: PierreDomElement,
): Readonly<{ oldLine: number | null; newLine: number | null }> | null {
  const number = Number.parseInt(row.getAttribute?.('data-line') ?? '', 10);
  const type = row.getAttribute?.('data-line-type');
  if (!Number.isFinite(number) || number <= 0 || !type) return null;
  if (type === 'change-deletion') return { oldLine: number, newLine: null };
  if (type === 'change-addition') return { oldLine: null, newLine: number };
  let column = row.parentElement ?? null;
  while (column && !column.hasAttribute?.('data-code'))
    column = column.parentElement ?? null;
  return column?.hasAttribute?.('data-deletions')
    ? { oldLine: number, newLine: null }
    : { oldLine: null, newLine: number };
}
