import { expect, it } from 'vitest';
import { WorkflowRunAcceptedContextV1Schema, WorkflowRunStartRequestV1Schema } from './actionsV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import { prepareWorkflowRunStartV1, resolveWorkflowContextInputsV1 } from './workflowStartPreparationV1.js';

it('requires distinct admitted participants when the authored comparison declares a minimum', async () => {
  const definition = { inputs: [{ name: 'participants', valueType: 'json' as const, required: true, multiple: true,
    inputType: { hostType: 'agentParticipant' as const }, minItems: 2, uniqueItems: true }] };
  const participant = { kind: 'session', session: { serverId: 'home', sessionId: 'one' } };
  for (const participants of [[participant], [participant, participant]]) {
    await expect(resolveWorkflowContextInputsV1({ definition, inputs: { participants } })).rejects.toMatchObject({ code: 'invalid_input' });
  }
  await expect(resolveWorkflowContextInputsV1({ definition, inputs: { participants: [participant,
    { kind: 'session', session: { serverId: 'home', sessionId: 'two' } }] } })).resolves.toHaveProperty('participants');
});

it('prepares an accepted repeat with its concrete target and inputs through the strict start consumer', () => {
  const checked = validateWorkflowDefinition({ version: 1, defaults: {
    agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'answerer' } },
  }, inputs: [
    { name: 'question', valueType: 'string', required: true },
  ], blocks: [{ kind: 'step', id: 'work', document: { text: 'Answer', references: [], attachments: [] }, result: { kind: 'text' } }] });
  if (!checked.valid || !checked.normalizedDefinition) throw new Error('invalid_definition_fixture');
  const definition = checked.normalizedDefinition;
  const acceptedContext = WorkflowRunAcceptedContextV1Schema.parse({ startedBy: 'user', source: { kind: 'inline' },
    inputs: { question: 'Retained question' }, machineId: 'machine-a', executionTarget: { kind: 'session' },
    materializedLeaves: [{ sourceKey: '$root', blockId: 'work', kind: 'step', selection: {},
      authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'detached_run' } }], frozenChildren: {},
    workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
    origin: { kind: 'direct', originSessionId: 'origin-session' },
  });
  const replay = { runId: '11111111-1111-4111-8111-111111111111', intent: 'another_round' as const };
  const prepared = prepareWorkflowRunStartV1({ definition, acceptedContext, replay });
  const request = WorkflowRunStartRequestV1Schema.parse({ runId: '22222222-2222-4222-8222-222222222222',
    source: prepared.source, inputs: prepared.inputs, executionTarget: prepared.executionTarget });
  expect(request).toMatchObject({ inputs: { question: 'Retained question' }, source: { replay,
    definition: { blocks: [{ execution: { executionTarget: { kind: 'detached_run' } } }] } } });
  expect(prepared).toMatchObject({ project: acceptedContext.workspaceTarget.project, originSessionId: 'origin-session' });
  expect(definition.blocks[0]).not.toHaveProperty('execution');
  expect(WorkflowRunStartRequestV1Schema.safeParse({ ...request, source: { ...request.source,
    replay: { ...replay, agentOverride: { sourceKey: '$root', blockId: 'work', engine: { role: 'planner' } } } } }).success).toBe(false);
});
