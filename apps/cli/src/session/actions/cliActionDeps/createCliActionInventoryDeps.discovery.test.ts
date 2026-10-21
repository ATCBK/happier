import { describe, expect, it } from 'vitest';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createCliActionDeps } from '../createCliActionDeps';

describe('native Action configuration discovery', () => {
  it('discovers selected-model and session-wide declarations for an external Agent through the real catalog', async () => {
    const pluginId = 'acme.discovery';
    const identity = { pluginId, localId: 'assistant' };
    const agentId = buildQualifiedPluginContributionKey(identity);
    // This physically admitted external plugin is the native observation boundary.
    // Action admission, catalog activation, preflight probes and projection are real.
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, plugins: [{
      manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { agents: [{ id: identity.localId,
        title: 'Discovery Assistant', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      }] } }),
      files: { 'runtime.mjs': `export async function createRuntime() { return { sessions: {
        open: async () => ({ send: async () => ({ status: 'admitted' }), cancel: async () => ({ status: 'requested' }), watch: () => ({ dispose() {} }), dispose() {} })
      } }; }`, 'daemon.mjs': `
        import { createRuntime } from './runtime.mjs';
        const effort = values => ({ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'private-current',
          options: values.map(value => ({ value, name: value })) });
        export function activate(api) {
          api.agents.register('assistant', createRuntime, {
            sessionRunnerFactory: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            preflightSessionControls: {
            probeModels: async () => [
              { id: 'small', name: 'Small', modelOptions: [effort(['low', 'high'])] },
              { id: 'large', name: 'Large', modelOptions: [effort(['medium', 'ultra'])] }
            ],
            probeConfigOptions: async () => [effort(['session-only']),
              { id: 'format', name: 'Format', type: 'select', currentValue: 'private-format', options: [{ value: 'text', name: 'Text' }] }]
          } });
        }
      ` },
    }] });
    try {
      const activation = await fixture.registry.activateContributionsOnDemand([{ pluginId, family: 'agents', localId: identity.localId }]);
      expect(fixture.registry.agentRuntimesByAgentId.has(agentId), JSON.stringify(activation)).toBe(true);
      const inventory = createCliActionDeps({ token: 'fixture-token', sessionId: 'fixture-session', mode: 'plain', ctx: null,
        rawSession: { machineId: 'machine', host: 'host', path: fixture.happyHomeDir } });
      const executor = createActionExecutor(inventory);
      const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId: 'home' };
      const backendTargetKey = `agent:${agentId}`;
      const definitions = await executor.execute('agents.config_options.list', { agentId, backendTargetKey, modelId: 'small', machineId: 'machine' }, context);
      expect(definitions, JSON.stringify(definitions)).toMatchObject({ ok: true, result: { items: [
        { id: 'reasoning_effort', type: 'select', options: [{ value: 'low' }, { value: 'high' }] },
        { id: 'format', options: [{ value: 'text' }] },
      ] } });
      if (!definitions.ok) throw new Error('Config inventory refused');
      expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['agents.config_options.list'].safeParse(definitions.result).success).toBe(true);
      expect(JSON.stringify(definitions.result)).not.toContain('private-');
      for (const [actionId, fieldPath, draftInput] of [
        ['session.spawn_new', 'configuration', { agentTarget: { kind: 'agent', identity },
          executionTarget: { kind: 'machine', machineId: 'machine' },
          modelSelection: { v: 1, ref: { agentTargetKey: backendTargetKey, modelId: 'small', providerConnectionId: null }, updatedAt: 1 } }],
        ['execution.run.start', 'configOptions', { agentId, backendTargetKey, modelId: 'small', machineId: 'machine' }],
      ] as const) {
        const result = await executor.execute('action.options.resolve', { actionId, fieldPath, draftInput }, context);
        expect(result).toMatchObject({ ok: true, result: { options: [
          { value: 'reasoning_effort', label: 'Thinking' }, { value: 'format', label: 'Format' },
        ] } });
        if (result.ok) expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].safeParse(result.result).success).toBe(true);
      }
      const otherModel = await inventory.agentsConfigOptionsList!({ agentId, backendTargetKey, modelId: 'large', machineId: 'machine' });
      expect(otherModel).toMatchObject({ items: [{ id: 'reasoning_effort', options: [{ value: 'medium' }, { value: 'ultra' }] }, { id: 'format' }] });
      const unselected = await inventory.agentsConfigOptionsList!({ agentId, backendTargetKey, machineId: 'machine' });
      expect(unselected).toMatchObject({ items: [{ id: 'reasoning_effort', options: [{ value: 'session-only' }] }, { id: 'format' }] });
      const unavailable = await inventory.agentsConfigOptionsList!({ agentId, backendTargetKey, modelId: 'small', machineId: 'other-machine' });
      expect(unavailable).toMatchObject({ items: [], source: 'unavailable' });
    } finally { await fixture.dispose(); }
  });
});
