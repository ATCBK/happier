import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryMetadataSchema } from '@happier-dev/protocol/scm/diffSummary';
import type { ScmDiffSummaryGenerateOutput, ScmDiffSummaryOutputKind, ScmDiffSummaryResultResponse } from '@happier-dev/protocol';
import { ScmDiffSummaryPublicationReceiptSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import type {
  ExecutionRunProfileStartParams, ExecutionRunProfileTurnCompleteParams, ExecutionRunProfileBoundedCompleteResult,
} from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { scmDiffSummaryResultStore, type ScmDiffSummaryResultScope } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { parseDiffSummaryModelOutput } from './parseDiffSummaryModelOutput';
import { resolveExecutionRunInitialInputLocalId } from '../../initialInput';

export function readScmDiffSummaryIntent(input: unknown): Readonly<Record<string, unknown>> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Readonly<Record<string, unknown>> : {};
}

export function readScmDiffSummaryProducerModelId(start: ExecutionRunProfileStartParams): string | undefined {
  // Native usage wins; without it, retain the Run's admitted model selection.
  return start.effectiveEngine?.modelId ?? start.modelId;
}

export function readInitialScmDiffSummaryInputId(start: ExecutionRunProfileStartParams): string {
  const inputId = readScmDiffSummaryIntent(start.intentInput).resultInitialInputId;
  return resolveExecutionRunInitialInputLocalId(start.runId,
    typeof inputId === 'string' && inputId.trim() ? inputId : undefined);
}

export function buildPendingScmDiffSummaryOutput(input: Readonly<Record<string, unknown>>): ScmDiffSummaryGenerateOutput {
  const comparison = ScmComparisonSchema.parse(input.comparison);
  const requestedOutputs = (input.outputs ?? ['summary']) as ScmDiffSummaryOutputKind[];
  return ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: comparison.id,
    comparison, metadata: ScmDiffSummaryMetadataSchema.parse(input.metadata), requestedOutputs,
    outputs: Object.fromEntries(requestedOutputs.map((kind) => [kind, { state: 'pending' }])),
    analysis: { suppliedChangeRefs: [], analysedChangeRefs: [],
      remainingChangeRefs: comparison.inventory.files.flatMap((file) => file.occurrences.map((change) => change.id)) },
  });
}

export async function readOrCreateSavedScmResult(start: ExecutionRunProfileStartParams, previous?: unknown) {
  const input = readScmDiffSummaryIntent(start.intentInput);
  const comparison = ScmComparisonSchema.parse(input.comparison);
  const prior = ScmDiffSummaryGenerateOutputSchema.safeParse(previous);
  const resultId = typeof input.resultId === 'string' ? input.resultId : prior.success ? prior.data.resultId : undefined;
  const cwd = typeof input.cwd === 'string' ? input.cwd : comparison.repository.rootPath;
  const scope = { cwd, ...(start.sessionId ? { sessionId: start.sessionId } : {}) };
  if (resultId) {
    const readable = await scmDiffSummaryResultStore.read({ ...scope, resultId });
    if (!readable.success) throw new Error(readable.error);
    if (readable.result.output.comparison?.id !== comparison.id) throw new Error('Saved result does not belong to the captured comparison');
    return { scope: { ...scope, resultId }, result: readable.result };
  }
  const result = await scmDiffSummaryResultStore.create({ ...scope, output: prior.success && prior.data.comparison?.id === comparison.id
    ? prior.data : buildPendingScmDiffSummaryOutput(input) });
  return { scope: { ...scope, resultId: result.resultId }, result };
}

function publicationCompletion(result: ScmDiffSummaryResultResponse, previous: ScmDiffSummaryGenerateOutput,
  requestedOutputs: readonly ScmDiffSummaryOutputKind[], original?: ExecutionRunProfileBoundedCompleteResult) {
  if (!result.success) return null;
  const outputs = result.result.output.success ? requestedOutputs.flatMap(kind => {
    const before = previous.outputs?.[kind]?.value;
    const after = result.result.output.outputs?.[kind]?.value;
    return after === undefined || JSON.stringify(before) === JSON.stringify(after) ? []
      : [{ kind, change: before === undefined ? 'created' as const : 'updated' as const }];
  }) : [];
  const receipt = outputs.length ? ScmDiffSummaryPublicationReceiptSchema.parse({ status: 'published', outputs,
    canUndo: result.result.canUndo,
    ...(result.result.updateNotice?.revision === result.result.revision ? { updateNotice: result.result.updateNotice } : {}),
    ...(outputs.some(output => output.kind === 'walkthrough') && result.result.walkthroughProvenance?.titleEdited
      && previous.outputs?.walkthrough?.value?.title === result.result.output.outputs?.walkthrough?.value?.title
      ? { titleEditKept: true } : {}),
  }) : undefined;
  const walkthrough = receipt?.outputs.length === 1 && receipt.outputs[0]?.kind === 'walkthrough' ? receipt.outputs[0] : undefined;
  return { ...(original ?? { status: 'succeeded' as const, summary: 'Walkthrough updated.' }),
    // Progress and unchanged values are metadata; the one publication receipt owns success prose.
    ...(result.result.output.success ? { summary: '' } : {}),
    ...(result.result.output.success && !receipt ? { transcriptMaterialization: 'none' as const } : {}),
    ...(receipt ? { summary: walkthrough ? `Walkthrough ${walkthrough.change === 'created' ? 'written' : 'updated'}.` : 'Change analysis saved.',
      toolResultMeta: { ...original?.toolResultMeta, scmResultUpdate: receipt } } : {}),
    toolResultOutput: result.result.output, structuredMeta: { kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, payload: result.result.output } };
}

async function publicationNotice(scope: ScmDiffSummaryResultScope, response: ScmDiffSummaryResultResponse,
  previous: ScmDiffSummaryGenerateOutput, requestedOutputs: readonly ScmDiffSummaryOutputKind[],
  original?: ExecutionRunProfileBoundedCompleteResult): Promise<ExecutionRunProfileBoundedCompleteResult | null> {
  if (response.success) return publicationCompletion(response, previous, requestedOutputs, original);
  const readable = await scmDiffSummaryResultStore.read(scope);
  if (!readable.success) return null;
  return { status: 'succeeded', summary: response.error,
    toolResultOutput: readable.result.output, toolResultMeta: { scmResultUpdate: { status: response.errorCode,
      ...(response.latestRevision !== undefined ? { latestRevision: response.latestRevision } : {}) } },
    structuredMeta: { kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, payload: readable.result.output },
    // A conflict stops multipart admissions rather than overwriting manual edits in a later part.
  };
}

/** All structured retained turns use the same saved owner; transcript prose is not a write. */
export async function publishSavedScmDiffSummaryTurn(params: ExecutionRunProfileTurnCompleteParams,
  complete: (params: ExecutionRunProfileTurnCompleteParams) => ExecutionRunProfileBoundedCompleteResult | null,
  progressive = false): Promise<ExecutionRunProfileBoundedCompleteResult | null> {
  const saved = await readOrCreateSavedScmResult(params.start, params.previousStructuredMeta?.payload);
  if (saved.result.output.runId && saved.result.output.runId !== params.start.runId) return null;
  // The native initial turn may omit input IDs, but onStarted already admitted
  // its revision. Completion never grants itself authority at a newer revision.
  const inputIds = params.inputIds?.length ? params.inputIds : [readInitialScmDiffSummaryInputId(params.start)];
  const pending = await scmDiffSummaryResultStore.readInput({ ...saved.scope, inputIds });
  if (!pending) return null;
  if (!pending.outputs.length) {
    await scmDiffSummaryResultStore.abandonInput({ ...saved.scope, inputId: pending.inputId });
    return null;
  }
  const currentParams = { ...params, start: { ...params.start, intentInput: { ...readScmDiffSummaryIntent(params.start.intentInput),
    outputs: [...new Set([...(saved.result.output.requestedOutputs ?? []), ...pending.outputs])] } },
    previousStructuredMeta: { kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, payload: saved.result.output } };
  if (progressive) {
    const completion = complete(currentParams);
    if (!completion) return null;
    const output = ScmDiffSummaryGenerateOutputSchema.parse(completion.toolResultOutput);
    const response = await scmDiffSummaryResultStore.publishProgress({ ...saved.scope, expectedRevision: pending.baseRevision, inputId: pending.inputId, output });
    await scmDiffSummaryResultStore.abandonInput({ ...saved.scope, inputId: pending.inputId });
    return publicationNotice(saved.scope, response, saved.result.output, pending.outputs, completion);
  }
  const parsed = parseDiffSummaryModelOutput(params.rawText, pending.reviewExplanation
    ? { comparison: saved.result.output.comparison!, requestedOutputs: pending.outputs, allowReviewExplanation: true } : undefined);
  if (!parsed) {
    const hasPriorPublication = params.previousStructuredMeta !== undefined
      && Object.values(saved.result.output.outputs ?? {}).some((output) => output?.state !== 'pending');
    if (!hasPriorPublication) {
      const completion = complete(currentParams);
      if (completion) {
        const response = await scmDiffSummaryResultStore.publishProgress({ ...saved.scope, expectedRevision: pending.baseRevision,
          inputId: pending.inputId, output: ScmDiffSummaryGenerateOutputSchema.parse(completion.toolResultOutput) });
        await scmDiffSummaryResultStore.abandonInput({ ...saved.scope, inputId: pending.inputId });
        return publicationNotice(saved.scope, response, saved.result.output, pending.outputs, completion);
      }
    }
    await scmDiffSummaryResultStore.abandonInput({ ...saved.scope, inputId: pending.inputId });
    return null;
  }
  const completion = pending.stopIds || pending.reviewExplanation ? undefined : complete(currentParams) ?? undefined;
  const modelId = readScmDiffSummaryProducerModelId(params.start);
  const response = await scmDiffSummaryResultStore.publish({ ...saved.scope, inputId: pending.inputId, modelOutput: parsed,
    runId: params.start.runId, generatedAtMs: params.finishedAtMs,
    ...(modelId ? { modelId } : {}),
    ...(completion ? { outputEnvelope: ScmDiffSummaryGenerateOutputSchema.parse(completion.toolResultOutput) } : {}) });
  if (!response.success) await scmDiffSummaryResultStore.abandonInput({ ...saved.scope, inputId: pending.inputId });
  return publicationNotice(saved.scope, response, saved.result.output, pending.outputs, completion);
}
