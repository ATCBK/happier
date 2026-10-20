import { readPierreDomLine } from './pierre/pierreDomLine';

/** A rendered diff line's numbers, as either renderer draws them (one side may be absent). */
export type DiffDomLine = Readonly<{
  oldLine: number | null;
  newLine: number | null;
}>;

type DiffDomNode = Readonly<{
  nodeType?: number;
  parentElement?: DiffDomElement | null;
}>;
type DiffDomElement = DiffDomNode &
  Readonly<{
    getAttribute?: (name: string) => string | null;
    hasAttribute?: (name: string) => boolean;
  }>;

function lineNumber(value: string | null | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The diff line a DOM node sits in: Happier rows carry `data-code-line-*` (CodeLinesViewCore), Pierre rows
 * `data-line` + `data-line-type` (inside its shadow root).
 */
export function readDiffLineFromDomNode(
  node: DiffDomNode | null | undefined,
): DiffDomLine | null {
  let element: DiffDomElement | null | undefined =
    node?.nodeType === 1 ? (node as DiffDomElement) : node?.parentElement;
  while (element) {
    if (element.hasAttribute?.('data-code-line-kind')) {
      const oldLine = lineNumber(element.getAttribute?.('data-code-line-old'));
      const newLine = lineNumber(element.getAttribute?.('data-code-line-new'));
      return oldLine === null && newLine === null ? null : { oldLine, newLine };
    }
    if (
      element.hasAttribute?.('data-line') &&
      element.hasAttribute?.('data-line-type')
    )
      return readPierreDomLine(element);
    element = element.parentElement;
  }
  return null;
}

/**
 * The lines a selection between two rendered diff lines asks about: the new side it lands on, or the old
 * side when it only covers removed lines (the anchor the per-change Ask uses for a pure deletion).
 */
export function resolveDiffSelectionLines(
  start: DiffDomLine | null,
  end: DiffDomLine | null,
): Readonly<{
  startLine: number;
  endLine: number;
  side: 'before' | 'after';
}> | null {
  if (!start || !end) return null;
  const first = start.newLine ?? end.newLine;
  const last = end.newLine ?? start.newLine;
  if (first !== null && last !== null)
    return {
      startLine: Math.min(first, last),
      endLine: Math.max(first, last),
      side: 'after',
    };
  const oldFirst = start.oldLine ?? end.oldLine;
  const oldLast = end.oldLine ?? start.oldLine;
  if (oldFirst === null || oldLast === null) return null;
  return {
    startLine: Math.min(oldFirst, oldLast),
    endLine: Math.max(oldFirst, oldLast),
    side: 'before',
  };
}
