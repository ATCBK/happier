import type { ScmComparisonFile } from './comparison.js';
import { isMetadataOccurrence } from './comparisonOccurrences.js';
import type { ScmWorkingEntry } from './workingSnapshot.js';

export type ScmComparisonDiscardReason = 'staged' | 'renamed_or_copied' | 'untracked' | 'added_file';
export type ScmComparisonDiscardRestriction = Readonly<{ reason: ScmComparisonDiscardReason; error: string }>;

/**
 * Structural restrictions of the comparison arm of scm.change.discard. Presentation uses its
 * displayed evidence; the executor repeats this decision on authoritative evidence before writing.
 * Hash, encoding and zero-fuzz checks still belong to the effect-time executor.
 */
export function getScmComparisonDiscardRestriction(input:
  | Readonly<{ kind: 'captured'; file: ScmComparisonFile; hunkIndexes?: readonly number[] }>
  | Readonly<{ kind: 'live'; entry?: Pick<ScmWorkingEntry, 'kind' | 'hasIncludedDelta'>; hunks: boolean }>,
): ScmComparisonDiscardRestriction | null {
  if (input.kind === 'live') {
    const entry = input.entry;
    if (input.hunks && entry?.kind === 'added') return { reason: 'added_file', error: 'Discard an added file as a whole file' };
    if (entry?.hasIncludedDelta) return { reason: 'staged', error: 'Unstage these changes first' };
    if (entry?.kind === 'renamed' || entry?.kind === 'copied') return { reason: 'renamed_or_copied', error: 'Use Git discard for this file kind' };
    if (entry?.kind === 'untracked') return { reason: 'untracked', error: 'Use Git discard for this file kind' };
    return null;
  }
  const { file, hunkIndexes } = input;
  if (hunkIndexes && file.changeKind === 'added' && !file.beforeBlobId) return { reason: 'added_file', error: 'Discard an added file as a whole file' };
  if (file.changeKind === 'renamed' || file.changeKind === 'copied') return { reason: 'renamed_or_copied', error: 'Use turn rollback for renamed or copied files' };
  if (file.occurrences.some(occurrence => occurrence.layer === 'untracked')) return { reason: 'untracked', error: 'Use Git discard for untracked files' };
  const occurrences = file.occurrences.filter(occurrence => !isMetadataOccurrence(occurrence));
  if (hunkIndexes ? hunkIndexes.some(index => occurrences[index]?.layer === 'staged')
    : file.occurrences.some(occurrence => occurrence.layer === 'staged')) return { reason: 'staged', error: 'Unstage these changes first' };
  return null;
}
