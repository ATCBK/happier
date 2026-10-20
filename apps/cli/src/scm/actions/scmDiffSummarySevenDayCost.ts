import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { ScmDiffSummarySevenDayCost } from '@happier-dev/protocol';
import type { RetainedExecutionRunRecord } from '@/agent/runtime/bridges/executionRun/retainedState';

type CostRecord = Pick<RetainedExecutionRunRecord['state'], 'intent' | 'startedAtMs' | 'finishedAtMs' | 'structuredMeta'>;
const StoredScmDiffSummaryGenerateOutputSchema = createStoredReadSchema(ScmDiffSummaryGenerateOutputSchema);
/** Retained Run projections are not a complete historical cost ledger. */
export function summarizeScmDiffSummarySevenDayCost(records: readonly CostRecord[], untilMs: number): ScmDiffSummarySevenDayCost {
  const sinceMs = Math.max(0, untilMs - 7 * 24 * 60 * 60 * 1000);
  const recent = records.filter(record => record.intent === 'scm_diff_summary'
    && (record.finishedAtMs ?? record.startedAtMs) >= sinceMs && (record.finishedAtMs ?? record.startedAtMs) <= untilMs);
  let estimatedUsd = 0;
  let pricedRunCount = 0;
  for (const record of recent) {
    if (record.structuredMeta?.kind !== EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary) continue;
    const output = StoredScmDiffSummaryGenerateOutputSchema.safeParse(record.structuredMeta.payload);
    const cost = output.success ? output.data.cost?.estimatedUsd : undefined;
    if (cost === undefined) continue;
    estimatedUsd += cost;
    pricedRunCount += 1;
  }
  // One retained projection may represent only the latest turn and old Runs can be retired.
  // Never label this real-record subtotal a complete seven-day charge total.
  return { status: pricedRunCount ? 'partial' : 'unavailable', ...(pricedRunCount ? { estimatedUsd } : {}),
    pricedRunCount, unpricedRunCount: recent.length - pricedRunCount, sinceMs, untilMs };
}
