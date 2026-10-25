import { describe, expect, it } from 'vitest';
import { listActionSpecsForSurface, searchSerializedActionSpecsForSurface } from '@happier-dev/protocol';

import { findCompiledActionCliCommand, listCompiledActionCliCommands } from './compiledCommands';
import { composeActionCliInput, parseActionCliCommandInput } from './parseCommandInput';
import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { renderActionCliRootHelp } from './rootCommand';

const WORKFLOW_ACTION_IDS = [
  'workflow.validate',
  'workflow.run.start',
  'workflow.run.list',
  'workflow.run.get',
  'workflow.run.wait',
  'workflow.run.pause',
  'workflow.run.resume',
  'workflow.run.cancel',
  'workflow.run.invocations.list',
  'workflow.run.invocations.get',
  'workflow.run.invocations.retry',
  'workflow.run.delete',
  'workflow.definition.list',
  'workflow.definition.get',
  'workflow.definition.create',
  'workflow.definition.update',
  'workflow.definition.delete',
] as const;

describe('workflow Action projections', () => {
  it('derives every friendly workflow command from the canonical Action catalog', () => {
    const projected = new Set(
      listCompiledActionCliCommands().map((command) => String(command.actionId)),
    );

    expect(WORKFLOW_ACTION_IDS.filter((actionId) => !projected.has(actionId))).toEqual([]);
  });

  it('publishes portable document commands alongside the generated workflow Actions', () => {
    const help = renderActionCliRootHelp('workflow');
    expect(help).toContain('workflow definition import <file|->');
    expect(help).toContain('workflow definition export <definition-id>');
  });

  it('projects retry input without colliding with the compiler-owned whole-Action JSON flag', () => {
    const command = findCompiledActionCliCommand(['workflow', 'run', 'invocations', 'retry']);
    expect(command?.actionId).toBe('workflow.run.invocations.retry');
    expect(command?.fields.find((field) => field.path === 'retryInput')).toMatchObject({
      flag: '--retry-input',
      kind: 'json',
    });

    const parsed = parseActionCliCommandInput(command!, [
      ...command!.path,
      '--run-id', 'workflow_run_1',
      '--expected-revision', '3',
      '--invocation-json', '{"recordId":"workflow_invocation_1"}',
      '--causal-invocation-ids', 'workflow_invocation_1',
      '--conversation', 'same_conversation',
      '--retry-input-json', '{"kind":"original"}',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(composeActionCliInput({
      parsed,
      canonicalSchema: command!.spec.inputSchema,
      callerSchema: command!.callerSchema,
      bindInput: command!.binding ? command!.spec.cli?.bindInput : undefined,
      context: { actionId: command!.actionId, invocationId: 'invocation-1' },
    })).toMatchObject({
      ok: true,
      input: {
        runId: 'workflow_run_1',
        expectedRevision: 3,
        invocation: { recordId: 'workflow_invocation_1' },
        causalInvocationIds: ['workflow_invocation_1'],
        conversation: 'same_conversation',
        input: { kind: 'original' },
      },
    });
  });

  it('derives the direct MCP workflow tools from Action bindings without a workflow tool registry', () => {
    const tools = listBuiltInHappierTools({
      surface: 'mcp',
      registry: createResolvedContributionRegistry({ agents: [] }),
    });
    const workflowActionIds = tools
      .map((tool) => String(tool.actionId))
      .filter((actionId) => actionId.startsWith('workflow.'))
      .sort();

    expect(workflowActionIds).toEqual([
      'workflow.authoring.conversation.bind',
      'workflow.authoring.draft.discard',
      'workflow.authoring.draft.edit',
      'workflow.authoring.draft.get',
      'workflow.authoring.draft.redo',
      'workflow.authoring.draft.save',
      'workflow.authoring.draft.undo',
      'workflow.discussion.round.project',
      'workflow.run.cancel',
      'workflow.run.get',
      'workflow.run.review.draft.set',
      'workflow.run.start',
      'workflow.run.wait',
    ]);
  });

  it('keeps every agent-exposed workflow Action discoverable', () => {
    const discoveredWorkflowIds = searchSerializedActionSpecsForSurface({
      surface: 'agent',
      query: 'workflow',
      limit: 100,
      isActionEnabled: () => true,
    })
      .map((spec) => String(spec.id))
      .filter((actionId) => actionId.startsWith('workflow.'));
    const exposedWorkflowIds = listActionSpecsForSurface('agent')
      .map((spec) => String(spec.id))
      .filter((actionId) => actionId.startsWith('workflow.'));
    expect(new Set(discoveredWorkflowIds)).toEqual(new Set(exposedWorkflowIds));
  });
});
