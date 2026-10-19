import { ScmDiffSummaryModelOutputSchema, normalizeScmDiffSummaryModelOutput } from '@happier-dev/protocol/scm/diffSummary';
import type { ScmDiffSummaryModelOutput } from '@happier-dev/protocol';

import { parseTrailingJsonObject } from '@/agent/executionRuns/profiles/shared/parseTrailingJsonObject';

export type DiffSummaryModelOutput = ScmDiffSummaryModelOutput;

export function parseDiffSummaryModelOutput(
  rawText: string,
  context?: Parameters<typeof normalizeScmDiffSummaryModelOutput>[1],
): DiffSummaryModelOutput | null {
  // The shared Run-output reader tolerates the prose or code fence a model puts around its JSON.
  // The strict protocol schema below remains the contract.
  const parsed = parseTrailingJsonObject(rawText);

  const result = ScmDiffSummaryModelOutputSchema.safeParse(parsed);
  if (!result.success) return null;
  try {
    return context ? normalizeScmDiffSummaryModelOutput(result.data, context) : result.data;
  } catch { return null; }
}
