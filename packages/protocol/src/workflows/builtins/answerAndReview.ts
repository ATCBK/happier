import type { WorkflowDefinitionV1 } from '../workflowV1.js';
import { document, input, literal, result } from './definitionParts.js';

export const ANSWER_AND_REVIEW_WORKFLOW_V1: WorkflowDefinitionV1 = {
  version: 1, defaults: {}, inputs: [
    { name: 'question', valueType: 'string', required: true },
    { name: 'answerer', valueType: 'json', required: true, inputType: { hostType: 'agentParticipant' } },
    { name: 'reviewer', valueType: 'json', required: true, inputType: { hostType: 'agentParticipant' } },
  ], blocks: [
    { kind: 'step', id: 'answer', name: 'Answer the question', document: document('Answer the supplied question.'),
      execution: { participant: { kind: 'input', name: 'answerer' } }, input: [input('question')], result: { kind: 'text' } },
    { kind: 'if', id: 'reviewed', name: 'Review the answer', when: { kind: 'compare', operator: 'neq', left: result('answer'), right: literal('') },
      then: [{ kind: 'step', id: 'review', name: 'Review the exact answer',
        document: document('Review the exact supplied answer to the question. Explain corrections, missing evidence and disagreements.'),
        execution: { participant: { kind: 'input', name: 'reviewer' } }, input: [input('question'), result('answer', [], { kind: 'outer', levels: 1 })], result: { kind: 'text' } }],
      otherwise: [] },
  ],
};
