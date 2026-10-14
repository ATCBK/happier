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
  for (const line of lines) {
    if (line.kind === 'header') {
      if (old.length > 0 || next.length > 0) {
        old.push({ id: `${line.id}:old`, kind: 'gap', number: null, text: '' });
        next.push({ id: `${line.id}:new`, kind: 'gap', number: null, text: '' });
      }
      continue;
    }
    if (line.kind === 'remove') {
      old.push({ id: line.id, kind: 'changed', number: line.oldLine, text: line.renderCodeText });
    } else if (line.kind === 'add') {
      next.push({ id: line.id, kind: 'changed', number: line.newLine, text: line.renderCodeText });
    } else if (line.kind === 'context') {
      old.push({ id: `${line.id}:old`, kind: 'same', number: line.oldLine, text: line.renderCodeText });
      next.push({ id: `${line.id}:new`, kind: 'same', number: line.newLine, text: line.renderCodeText });
    }
  }
  return { old, new: next };
}
