import type { ScmComparison } from '@happier-dev/protocol';
import { presentReviewFindingCitations, type ReviewFindingCitations } from '@/agent/executionRuns/profiles/review/reviewFindingCitations';

/** Targeted turns keep the captured aliases and evidence, scoped to their admitted references. */
export function scopeScmDiffSummaryComparison(comparison: ScmComparison, changeRefs: ReadonlySet<string> | null): ScmComparison {
  if (!changeRefs) return comparison;
  return { ...comparison, inventory: { ...comparison.inventory, files: comparison.inventory.files.flatMap(file => {
    const occurrences = file.occurrences.filter(change => changeRefs.has(change.id));
    return occurrences.length ? [{ ...file, occurrences }] : [];
  }) } };
}

/** Host identities stay in saved state; every model turn receives the captured aliases. */
export function presentScmDiffSummaryModelContext(value: unknown, comparison: ScmComparison,
  citations: ReviewFindingCitations = []): unknown {
  const aliases = new Map(comparison.inventory.files.flatMap(file => file.occurrences.map(change => [change.id, change.alias] as const)));
  function present(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(present);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(Object.entries(input).map(([key, entry]) => {
      if ((key === 'changeRefs' || key.endsWith('ChangeRefs')) && Array.isArray(entry)) {
        return [key, entry.map(ref => {
          const alias = typeof ref === 'string' ? aliases.get(ref) : undefined;
          if (!alias) throw new Error('Model context contains a reference outside its captured comparison');
          return alias;
        })];
      }
      if (key === 'occurrences' && Array.isArray(entry)) {
        return [key, entry.map(occurrence => {
          if (!occurrence || typeof occurrence !== 'object' || Array.isArray(occurrence)) {
            throw new Error('Model context contains an invalid captured occurrence');
          }
          const { id: _hostId, ...fields } = occurrence as Record<string, unknown>;
          return present(fields);
        })];
      }
      return [key, present(entry)];
    }));
  }
  return present(presentReviewFindingCitations(value, citations));
}
