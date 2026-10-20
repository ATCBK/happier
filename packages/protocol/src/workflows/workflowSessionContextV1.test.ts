import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import { WorkflowSessionContextV1Schema } from './workflowSessionContextV1.js';

const step = { kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] },
  execution: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } };
const context = { kind: 'session_context', recentTurns: 2 };
const field = { kind: 'session_context_field', field: 'usage.tokensUsed' };
const when = { kind: 'exists', value: field };

describe('workflow session context contract', () => {
  it('accepts Discussion context in leaf inputs and rejects it as a condition or loop source', () => {
    for (const scope of ['addressing_message', 'so_far']) {
      const discussion = { kind: 'discussion_context', scope };
      expect(validateWorkflowDefinition({ version: 1, blocks: [{ ...step, input: [discussion] }] }).valid).toBe(true);
      expect(validateWorkflowDefinition({ version: 1, blocks: [{ kind: 'action', id: 'act', actionId: 'notify_me', input: { context: discussion } }] }).valid).toBe(true);
      expect(validateWorkflowDefinition({ version: 1, blocks: [{ kind: 'if', id: 'if',
        when: { kind: 'exists', value: discussion }, then: [step], otherwise: [] }] }).valid).toBe(false);
      expect(validateWorkflowDefinition({ version: 1, blocks: [{ kind: 'loop', id: 'loop', body: [step],
        repetition: { kind: 'items', items: discussion, execution: 'sequential', failurePolicy: 'fail_stop' } }] }).valid).toBe(false);
    }
  });
  it('admits context only as Agent or Action input and number fields only at the specified condition positions', () => {
    expect(validateWorkflowDefinition({ version: 1, blocks: [{ ...step, input: [context] }] }).valid).toBe(true);
    expect(validateWorkflowDefinition({ version: 1, blocks: [{ kind: 'action', id: 'act', actionId: 'notify_me', input: { context } }] }).valid).toBe(true);
    expect(validateWorkflowDefinition({ version: 1, blocks: [{ kind: 'workflow', id: 'child', workflowRef: 'builtin:child', input: { context } }] }).valid).toBe(false);
    expect(validateWorkflowDefinition({ version: 1, blocks: [{ ...step, input: [field] }] }).valid).toBe(false);
    expect(validateWorkflowDefinition({ version: 1, blocks: [{ ...step, onlyWhen: when }] }).valid).toBe(false);
    expect(validateWorkflowDefinition({ version: 1, blocks: [{ kind: 'if', id: 'if', when, then: [step], otherwise: [] }] }).valid).toBe(true);
    expect(validateWorkflowDefinition({ version: 1, blocks: [{ kind: 'loop', id: 'loop', body: [step],
      repetition: { kind: 'until', maxIterations: 2, stopWhen: when } }] }).valid).toBe(true);
  });

  it('keeps unavailable usage distinct from accounted zero and rejects native usage or unknown content', () => {
    expect(WorkflowSessionContextV1Schema.parse({ usage: { kind: 'unavailable' }, turns: [], truncated: false }).usage).toEqual({ kind: 'unavailable' });
    expect(WorkflowSessionContextV1Schema.parse({ usage: { kind: 'accounted', tokensUsed: 0 }, turns: [], truncated: false }).usage).toEqual({ kind: 'accounted', tokensUsed: 0 });
    expect(WorkflowSessionContextV1Schema.safeParse({ usage: { kind: 'unavailable', tokensUsed: 0 }, turns: [], truncated: false }).success).toBe(false);
    expect(WorkflowSessionContextV1Schema.safeParse({ usage: { kind: 'unavailable' }, turns: [], truncated: false, diffFingerprint: 'x' }).success).toBe(false);
  });
});
