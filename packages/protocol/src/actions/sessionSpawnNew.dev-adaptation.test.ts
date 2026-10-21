import { describe, expect, it } from 'vitest';

import { getActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS } from './actionSpecs.js';
import { createActionExecutor } from './actionExecutor.js';
import { parseBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { validateWorkflowDefinition } from '../workflows/workflowValidationV1.js';
import {
  isActionDirectToolExposedOn,
  isActionDiscoverableOnToolSurface,
  resolveActionToolExposureMode,
} from './actionToolExposure.js';

describe('session.spawn_new dev adaptation', () => {
  const canonicalInput = {
    creationKey: 'manual:attempt-7',
    executionTarget: {
      serverId: 'server-1',
      machineId: 'machine-1',
    },
    directory: { kind: 'path', path: '/workspace/project' },
    organizationPlacement: {
      folderId: 'folder-1',
      tagIds: ['tag-1'],
    },
    agentTarget: {
      kind: 'agent',
      identity: {
        pluginId: 'happier.agent.codex',
        localId: 'codex',
      },
    },
  } as const;

  it('is discoverable but not direct by default on the agent surface', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.surfaces.agent).toBe(true);
    expect(resolveActionToolExposureMode(spec, 'agent')).toBe('discoverable_only');
    expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
    expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(false);
  });

  it('accepts the strict canonical create-or-rejoin request', () => {
    const spec = getActionSpec('session.spawn_new');

    const parsed = spec.inputSchema.safeParse(canonicalInput);

    expect(parsed.success).toBe(true);
  });

  it('maps resolved native choices into Session, execution Run, and Workflow start inputs', async () => {
    const targetKey = 'agent:happier.agent.codex/codex';
    // These inventory ports cross into the selected Machine's plugin runtime.
    const executor = createActionExecutor({
      agentsBackendsList: async () => ({ items: [{ targetKey, label: 'Agent' }] }),
      agentsModelsList: async () => ({ items: [{ id: 'native-model', label: 'Native model' }] }),
      agentsConfigOptionsList: async () => ({ items: [{ id: 'reasoning_effort', label: 'Effort' }] }),
    });
    const resolveValue = async (actionId: 'session.spawn_new' | 'execution.run.start', fieldPath: string, draftInput?: unknown) => {
      const result = await executor.execute('action.options.resolve', {
        actionId, fieldPath, ...(draftInput ? { draftInput } : {}),
      }, { surface: 'agent' });
      if (!result.ok) throw new Error(result.errorCode);
      const option = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result).options[0];
      if (!option || typeof option.value !== 'string') throw new Error('Missing native option');
      return option.value;
    };
    const agentTarget = parseBackendTargetKeyV2(await resolveValue('session.spawn_new', 'agentTarget'));
    if (!agentTarget || agentTarget.kind !== 'agent') throw new Error('Missing Agent target');
    const draft = { ...canonicalInput, agentTarget };
    const modelId = await resolveValue('execution.run.start', 'modelId', { backendTargetKey: targetKey });
    const optionId = await resolveValue('execution.run.start', 'configOptions', { backendTargetKey: targetKey });
    const modelSelection = { v: 1, ref: { agentTargetKey: targetKey, providerConnectionId: null, modelId }, updatedAt: 1 };
    const spawn = { ...draft, modelSelection, permissionMode: 'read-only', configuration: {
      mode: { value: null, updatedAtMs: 1 }, model: { value: modelId, updatedAtMs: 1 },
      permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: { [optionId]: { value: 'low', updatedAtMs: 1 } },
    } };
    expect(getActionSpec('session.spawn_new').inputSchema.safeParse(spawn).success).toBe(true);
    expect(getActionSpec('execution.run.start').inputSchema.safeParse({
      sessionId: 'parent', intent: 'task', backendTarget: agentTarget, modelId,
      configOptions: { [optionId]: 'low' }, permissionMode: 'read-only',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
      instructions: 'Inspect the workspace.',
    }).success).toBe(true);
    const definition = { version: 1, defaults: { engine: { agentTarget, modelSelection, effort: 'low' } },
      blocks: [{ kind: 'step', id: 'inspect', document: { text: 'Inspect the workspace.', references: [], attachments: [] } }] };
    expect(validateWorkflowDefinition(definition)).toMatchObject({ valid: true });
    expect(getActionSpec('workflow.run.start').inputSchema.safeParse({
      runId: '22222222-2222-4222-8222-222222222222', source: { kind: 'inline', definition },
    }).success).toBe(true);
  });

  it('publishes the public Action through its strict ActionSpec RPC binding', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.surfaces.rpc).toBe(true);
    expect(spec.bindings?.rpcMethod).toBe('session.spawnNew');
    expect(spec.surfaceBindings?.rpc?.inputSchema.safeParse(canonicalInput).success).toBe(true);
    const { creationKey: _creationKey, ...missingCreationKey } = canonicalInput;
    expect(spec.surfaceBindings?.rpc?.inputSchema.safeParse(missingCreationKey).success).toBe(false);
  });

  it('rejects predecessor flat ingress at every live public Action boundary', () => {
    const spec = getActionSpec('session.spawn_new');
    const predecessorFlatInput = {
      tag: 'remote-dev-metadata-label',
      agentId: 'codex',
      modelId: 'gpt-5',
      providerConnectionId: 'provider-connection-1',
      backendTargetKey: 'agent:codex',
      machineId: 'machine-1',
      serverId: 'server-1',
      path: '/workspace/project',
      host: 'target-host',
      initialMessage: 'Inspect this repository.',
    } as const;

    expect(spec.inputSchema.safeParse(predecessorFlatInput).success).toBe(false);
    expect(spec.surfaceBindings?.rpc?.inputSchema.safeParse(predecessorFlatInput).success).toBe(false);
  });

  it.each([
    ['untyped directory', { ...canonicalInput, directory: '/workspace/project' }],
    ['legacy metadata tag', { ...canonicalInput, tag: 'not-a-creation-key' }],
    ['flat machine target', { ...canonicalInput, machineId: 'machine-2' }],
    ['flat server target', { ...canonicalInput, serverId: 'server-2' }],
    ['legacy backend target', {
      ...canonicalInput,
      backendTarget: { kind: 'backend', backendId: 'codex' },
    }],
  ])('rejects %s at the canonical boundary', (_label, input) => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.safeParse(input).success).toBe(false);
  });

  it('requires exact target, directory, and Agent identity', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.safeParse({
      creationKey: canonicalInput.creationKey,
    }).success).toBe(false);
  });

  it('publishes only the strict canonical creation outcome', () => {
    const spec = getActionSpec('session.spawn_new');
    const result = {
      type: 'success',
      disposition: 'created',
      sessionId: 'session-1',
      executionTarget: {
        serverId: 'server-1',
        machineId: 'machine-1',
      },
      organizationPlacement: {
        folderId: null,
        tagIds: [],
      },
      initialInput: {
        status: 'notRequested',
      },
    };

    expect(spec.outputSchema.safeParse(result).success).toBe(true);
    expect(spec.outputSchema.safeParse({
      ...result,
      created: true,
    }).success).toBe(false);
    expect(spec.outputSchema.safeParse({
      ...result,
      initialInput: { status: 'accepted' },
    }).success).toBe(false);
    expect(spec.surfaceBindings?.rpc?.outputSchema.safeParse(result).success).toBe(true);
    expect(spec.surfaceBindings?.rpc?.outputSchema.safeParse({
      ...result,
      created: true,
    }).success).toBe(false);
  });
});
