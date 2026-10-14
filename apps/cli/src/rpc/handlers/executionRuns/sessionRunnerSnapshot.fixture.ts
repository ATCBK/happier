import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';

/** Native Agent is the external boundary; source custody, activation and leases stay real. */
export async function createSessionRunSnapshotFixture(happyHomeDir: string) {
  const pluginId = 'acme.snapshot';
  const controller = createPluginReloadController({ happyHomeDir });
  const declaration = (id: string) => ({ id, title: id, runtime: { kind: 'custom' }, primary: 'sessions',
    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } });
  return await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir, controller,
    plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId,
      contributes: { agents: [declaration('parent'), declaration('child')],
        resources: [{ id: 'delegate-text', kind: 'prompt', path: './delegate.md', contentType: 'text/markdown' }],
        promptAssets: [{ id: 'delegate-prompt', kind: 'systemPrompt', resource: 'delegate-text',
          target: { kind: 'agent', agent: 'parent' } }],
        executionRunProfiles: [{ id: 'captured-delegate', intent: 'delegate', title: 'Captured delegate',
          promptAsset: 'delegate-prompt', compatibleAgents: ['parent'],
          defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'requestResponse' } }],
      } }),
      files: { 'delegate.md': 'Use the daemon-admitted profile instructions.', 'factory.mjs': `
        import { appendFile } from 'node:fs/promises';
        import { join } from 'node:path';
        export function createRuntime({ agent }) {
          return { sessions: { async open(request) {
            await appendFile(join(request.cwd, 'native-opens.jsonl'), JSON.stringify({
              agentId: agent.id, modelId: request.configuration?.model?.value ?? null,
              sessionId: request.sessionId,
            }) + '\\n');
            return { send: async input => {
              await appendFile(join(request.cwd, 'native-inputs.jsonl'), JSON.stringify({
                agentId: agent.id, text: input.input.text,
              }) + '\\n');
              return { status: 'admitted' };
            },
              cancel: async request => ({ status: 'requested', turnId: request.turnId }),
              watch: () => ({ dispose() {} }), dispose: async () => {} };
          } } };
        }
      `, 'daemon.mjs': `
        import { createRuntime } from './factory.mjs';
        export function activate(api) {
          for (const id of ['parent', 'child']) api.agents.register(id, createRuntime, {
            sessionRunnerFactory: { module: './factory.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
          });
        }
      ` } }],
    runtimeOptions: { pluginIds: [pluginId] },
  });
}
