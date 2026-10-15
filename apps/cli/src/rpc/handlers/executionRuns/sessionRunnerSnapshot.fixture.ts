import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { UserMessageSchema } from '@/api/types';
import { SessionInputAdmissionResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { ExecutionRunAdmittedPendingInputV1, ExecutionRunPendingInputBinding } from '@/api/session/client/transport/sessionClientInteractionApi';

/** Substitute only the parent Session's persisted Pending transport. Host drain,
 * exact-input acceptance, native delivery and snapshot custody remain real. */
export function createSnapshotSessionPendingTransport(): Pick<ApiSessionClient,
  'enqueueSessionUserMessageWithDisposition' | 'bindExecutionRunPendingInput'> {
  const queued = new Map<string, ExecutionRunAdmittedPendingInputV1[]>();
  const bindings = new Map<string, ExecutionRunPendingInputBinding>();
  const accepted = new Map<string, Set<string>>();
  const offer = (binding: ExecutionRunPendingInputBinding) => {
    if (!binding.isCurrent()) return;
    const inputs = queued.get(binding.recipient.runId) ?? [];
    while (inputs.length) {
      if (!binding.consume(inputs[0]!)) break;
      inputs.shift();
    }
    binding.wake?.();
  };
  return {
    enqueueSessionUserMessageWithDisposition: async input => {
      if (input.recipient?.kind !== 'execution_run') throw new Error('Snapshot Pending fixture requires an exact Run recipient');
      const runId = input.recipient.runId;
      const inputs = queued.get(runId) ?? [];
      inputs.push({ ...UserMessageSchema.parse({ role: 'user', content: { type: 'text', text: input.text },
        localId: input.localId, ...(input.meta ? { meta: input.meta } : {}) }),
        authorAccountId: 'snapshot-account', inputAdmissionReceipt: null, pendingProviderAction: 'send' });
      queued.set(runId, inputs);
      const binding = bindings.get(runId);
      if (binding) offer(binding);
      return SessionInputAdmissionResultV1Schema.parse({ status: 'accepted', localId: input.localId });
    },
    bindExecutionRunPendingInput: binding => {
      const runId = binding.recipient.runId;
      bindings.set(runId, binding);
      const acceptedIds = new Set<string>();
      accepted.set(runId, acceptedIds);
      offer(binding);
      return {
        getMetadataSnapshot: binding.getMetadataSnapshot,
        waitForMetadataUpdate: async () => false,
        shouldAttemptPendingMaterialization: () => false,
        reconcilePendingProviderInputCustodyBeforeMaterialization: async () => binding.isCurrent(),
        materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' }),
        observeProviderInputSettlement: async outcome => {
          if (!binding.isCurrent()) return false;
          if (outcome.kind === 'accepted') acceptedIds.add(outcome.localId);
          return true;
        },
        readDurableProviderInputAcceptanceV1: async localId => binding.isCurrent() && accepted.get(runId)?.has(localId) ? 'accepted' : 'unknown',
        dispose: () => { if (bindings.get(runId) === binding) bindings.delete(runId); },
      };
    },
  };
}

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
            let emit;
            let sequence = 0;
            await appendFile(join(request.cwd, 'native-opens.jsonl'), JSON.stringify({
              agentId: agent.id, modelId: request.configuration?.model?.value ?? null,
              sessionId: request.sessionId,
            }) + '\\n');
            return { send: async input => {
              await appendFile(join(request.cwd, 'native-inputs.jsonl'), JSON.stringify({
                agentId: agent.id, text: input.input.text,
              }) + '\\n');
              if (input.input.text.includes('retained-snapshot-turn') && input.delivery.kind === 'newTurn') {
                const event = body => emit({ sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: Date.now(), ...body });
                event({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                event({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                event({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text: 'Retained reply' });
                event({ kind: 'turn-complete', turnId: input.delivery.turnId });
              }
              return { status: 'admitted' };
            },
              cancel: async request => ({ status: 'requested', turnId: request.turnId }),
              watch: listener => { emit = listener; return { dispose() {} }; }, dispose: async () => {} };
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
