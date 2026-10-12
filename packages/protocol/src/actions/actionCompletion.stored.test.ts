import { expect, it } from 'vitest';
import { z } from 'zod';
import { reviewWalkthroughCompletion } from './specs/executionRunCompletion.js';
import {
  ActionCompletionContractV1Schema,
  ActionCompletionStateV1Schema,
  freezeActionCompletionContractV1,
  readActionCompletionRunObservationV1,
  resumeActionCompletionV1,
  type ActionCompletionDeclaration,
} from './actionCompletion.js';

it('resumes the canonical narrator launch with annotated retained observation but rejects invalid correspondence', async () => {
  const declaration = reviewWalkthroughCompletion;
  const observation = { kind: 'review_walkthrough', comparisonId: 'comparison' } as const;
  const output = { runId: 'narrator', comparisonId: 'comparison', observation };
  const completion = freezeActionCompletionContractV1(declaration);
  const state = { output, awaitedRuns: [{ key: 'narrator', runId: 'narrator', observation }] };
  const input = { actionId: 'review.walkthrough', completion, state,
    resolveDeclaration: () => declaration,
    observeRun: async () => ({ kind: 'completed' as const, result: {} }) };
  const expected = { kind: 'completed', value: { narration: { runId: 'narrator', outcome: 'completed', result: {} } } };
  expect(await resumeActionCompletionV1(input)).toEqual(expected);
  const retained = { ...state, output: { ...output, observation: { ...observation, retired: true } } };
  expect(() => declaration.launched(retained.output)).toThrow();
  expect(await resumeActionCompletionV1({ ...input, state: retained })).toEqual(expected);
  expect(await resumeActionCompletionV1({ ...input, state: { ...retained, output: { ...retained.output,
    observation: { ...retained.output.observation, comparisonId: 'foreign' } } } }))
    .toEqual({ kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' });
});

it('resumes a retained completion projection while preserving opaque authored output and correspondence', async () => {
  const declaration: ActionCompletionDeclaration = { awaits: 'execution_runs',
    launched: () => ({ runs: [{ key: 'worker', runId: 'run' }], failed: [] }),
    terminalOutputSchema: z.object({ ok: z.literal(true), payload: z.unknown() }).strict(),
    terminal: output => ({ ok: true, payload: output }) };
  const completion = freezeActionCompletionContractV1(declaration);
  const output = { pluginOwned: { constructor: 'data', retired: 'declared opaque JSON' } };
  const state = { output, awaitedRuns: [{ key: 'worker', runId: 'run' }] };
  const retained = { ...state, retired: true,
    awaitedRuns: [{ ...state.awaitedRuns[0], retired: true }] };
  const input = { actionId: 'fixture.action', completion: { ...completion, retired: true }, state: retained,
    resolveDeclaration: () => declaration,
    observeRun: async () => ({ kind: 'completed' as const, result: { ok: true } }) };
  expect(await resumeActionCompletionV1(input)).toEqual({ kind: 'completed', value: { ok: true, payload: output } });
  expect(ActionCompletionStateV1Schema.safeParse(retained).success).toBe(false);
  expect(ActionCompletionContractV1Schema.safeParse(input.completion).success).toBe(false);
  expect(await resumeActionCompletionV1({ ...input, state: { ...retained,
    awaitedRuns: [{ key: 'worker', runId: 'foreign', retired: true }] } }))
    .toEqual({ kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' });
});

it('reads retained walkthrough evidence without dropping the observation because of annotations', () => {
  const output = { success: true, sourceKey: 'comparison',
    metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' }, resultId: 'saved', revision: 2,
    comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
      endpoints: { before: 'a', after: 'b' }, inventory: { state: 'complete', reasons: [], files: [] } },
    requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'partial',
      value: { title: 'Changes', intro: '', stops: [], otherChangeRefs: [] }, reason: 'cancelled' } },
    analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } };
  const observation = { kind: 'review_walkthrough' as const, comparisonId: 'comparison' };
  const native = { run: { status: 'running' as const },
    structuredMeta: { kind: 'scm_diff_summary.v1', payload: output } };
  expect(readActionCompletionRunObservationV1(native, observation)).toMatchObject({ kind: 'completed' });
  const retained = { ...output, retired: true,
    comparison: { ...output.comparison, retired: true,
      repository: { ...output.comparison.repository, retired: true } } };
  expect(readActionCompletionRunObservationV1({ ...native,
    structuredMeta: { ...native.structuredMeta, payload: retained } }, observation))
    .toMatchObject({ kind: 'completed', result: output });
  expect(readActionCompletionRunObservationV1({ ...native,
    structuredMeta: { ...native.structuredMeta, payload: { ...retained, resultId: 'other' } } },
    { ...observation, resultId: 'saved' })).toMatchObject({ kind: 'outcome_uncertain' });
});
