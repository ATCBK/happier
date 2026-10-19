import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

/** One line of one side of a prose diff: unchanged, changed on this side, or the gap between two hunks. */
export type ProseDiffLine = Readonly<{
  id: string;
  kind: 'same' | 'changed' | 'gap';
  number: number | null;
  text: string;
}>;

export type ProseDiffSides = Readonly<{ old: readonly ProseDiffLine[]; new: readonly ProseDiffLine[] }>;

/**
 * R5's two sides (P6 U6.6): the canonical text-diff lines split into what each side reads. A side keeps its
 * unchanged context and its own changed lines with its own numbers; hunks are separated by one gap line,
 * and the hunk header (a code-diff device) is never shown in prose.
 */
export function buildProseDiffSides(lines: readonly CodeLine[]): ProseDiffSides {
  const old: ProseDiffLine[] = [];
  const next: ProseDiffLine[] = [];
  // A hunk boundary becomes a gap on a side only between two lines that side shows.
  let gap: string | null = null;
  const pending = { old: false, new: false };
  const push = (side: 'old' | 'new', line: ProseDiffLine) => {
    const target = side === 'old' ? old : next;
    if (pending[side] && gap !== null && target.length > 0) {
      target.push({ id: `${gap}:${side}`, kind: 'gap', number: null, text: '' });
    }
    pending[side] = false;
    target.push(line);
  };
  for (const line of lines) {
    if (line.kind === 'header') {
      gap = line.id;
      pending.old = true;
      pending.new = true;
      continue;
    }
    if (line.kind === 'remove') {
      push('old', { id: line.id, kind: 'changed', number: line.oldLine, text: line.renderCodeText });
    } else if (line.kind === 'add') {
      push('new', { id: line.id, kind: 'changed', number: line.newLine, text: line.renderCodeText });
    } else if (line.kind === 'context') {
      push('old', { id: `${line.id}:old`, kind: 'same', number: line.oldLine, text: line.renderCodeText });
      push('new', { id: `${line.id}:new`, kind: 'same', number: line.newLine, text: line.renderCodeText });
    }
  }
  return { old, new: next };
}
