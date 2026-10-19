import * as z from 'zod/mini';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutomationDefinitionCreateRequestSchema,
  AutomationDefinitionDetailSchema,
  AutomationDefinitionReconcileRequestSchema,
  AutomationStoredWorkflowDefinitionV2Schema,
  AutomationTriggerDefinitionBindingV1Schema,
  AutomationTriggerIdSchema,
  WorkflowDefinitionV1Schema,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  openAutomationTriggerDefinitionStoredEnvelopeV1,
  sealAccountScopedBlobCiphertext,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
  type AutomationDefinitionDetail,
  type AutomationTriggerDefinitionBindingV1,
} from '@happier-dev/protocol';
import { getRandomBytes } from '@/api/encryption';
import { createCliWorkflowTriggerActions } from './workflowTriggers';

const network = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn() }));
// HTTP is the external boundary; authoring and crypto remain real.
vi.mock('axios', () => ({ default: { get: network.get, request: network.request } }));

const secret = new Uint8Array(32).fill(9);
const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret } };
const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
  blocks: [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
});
const event = {
  kind: 'pluginEvent' as const, enabled: true,
  eventRef: { pluginId: 'happier.scm.github', localId: 'issue-opened-v1' },
  sourceInstanceId: 'github:repository:1234', sourceContractVersion: 1,
  sourceConfig: { repository: 'private/repository' }, displayLabel: 'Private repository',
  observationTransport: { kind: 'checkpointedPull' as const,
    watcherMaterializationRef: { machineId: 'machine', materializationId: 'materialization', pluginId: 'happier.scm.github' } },
  filter: null, maximumObservationAgeMs: 60_000,
};
const privateDefinition = { v: 1 as const, sourceInstanceId: event.sourceInstanceId,
  sourceConfig: event.sourceConfig, displayLabel: event.displayLabel, filter: event.filter,
  maximumObservationAgeMs: event.maximumObservationAgeMs };
const binding: Extract<AutomationTriggerDefinitionBindingV1, { triggerKind: 'pluginEvent' }> = AutomationTriggerDefinitionBindingV1Schema._zod.def.options[0].parse({ v: 1, automationId: 'automation', triggerId: 'trigger',
  triggerRevision: 3, triggerKind: 'pluginEvent', eventRef: event.eventRef,
  sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631' });
const resolveUnusedWorkflow = async (): Promise<typeof definition> => {
  throw new Error('Inline triggers must not resolve a saved Workflow');
};

function detail(automationId: string, triggerId: string, sourceSelectorId: string, envelope: unknown, revision: number,
  executionRecipe: AutomationDefinitionDetail['executionRecipe']): AutomationDefinitionDetail {
  return AutomationDefinitionDetailSchema.parse({ id: automationId, name: 'Triggers', description: null,
    enabled: true, targetType: null, existingSessionId: null, templateVersion: 1,
    lastRunAt: null, createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null,
    executionRecipe, assignments: [{ machineId: 'machine', enabled: true, priority: 0, updatedAt: 1 }],
    triggers: [{ id: triggerId, revision, enabled: true, createdAt: 1, updatedAt: 1,
      kind: 'pluginEvent', eventRef: event.eventRef, sourceSelectorId, sourceContractVersion: 1,
      observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null,
      triggerDefinitionEnvelope: JSON.stringify(envelope) }],
  });
}

describe('Workflow trigger encrypted Event HTTP authoring', () => {
  let stored: AutomationDefinitionDetail;
  beforeEach(() => {
    for (const adapter of Object.values(network)) adapter.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected_capability_probe')));
    network.get.mockResolvedValue({ status: 200, data: { mode: 'e2ee', version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint),
      updatedAt: 1 } });
    network.request.mockImplementation(async ({ method, data }: { method: string; data?: unknown }) => {
      if (method === 'GET') return { status: 200, data: stored };
      if (method === 'POST') {
        const input = AutomationDefinitionCreateRequestSchema.parse(data);
        const trigger = input.triggers[0]!;
        if (trigger.trigger.kind !== 'pluginEvent' || !('triggerDefinitionEnvelope' in trigger.trigger)) {
          // The canonical E2EE server does not accept caller private Event facts in the plain arm.
          return { status: 400, data: { error: 'invalid_request' } };
        }
        stored = detail(input.automationId, trigger.triggerId, trigger.trigger.sourceSelectorId,
          trigger.trigger.triggerDefinitionEnvelope, 0, input.executionRecipe);
        return { status: 200, data: stored };
      }
      const input = AutomationDefinitionReconcileRequestSchema.parse(data);
      const trigger = input.triggers[0]!;
      if (trigger.kind !== 'existing' || !trigger.triggerDefinitionEnvelope) {
        // Enable-only E2EE Event mutation requires the exact next-revision envelope.
        return { status: 400, data: { error: 'invalid_request' } };
      }
      stored = AutomationDefinitionDetailSchema.parse({ ...stored, templateVersion: 2, executionRecipe: input.executionRecipe!,
        triggers: stored.triggers.map((item) => item.kind === 'pluginEvent' && item.id === trigger.triggerId
          ? { ...item, enabled: trigger.enabled!, revision: item.revision + 1,
              triggerDefinitionEnvelope: JSON.stringify(trigger.triggerDefinitionEnvelope) }
          : item) });
      return { status: 200, data: stored };
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('seals caller-visible Event facts before POST using actual Automation and trigger identities', async () => {
    const actions = createCliWorkflowTriggerActions({ credentials, serverHttpBaseUrl: 'https://source.example', resolveWorkflow: resolveUnusedWorkflow });
    const result = await actions.add({ target: { kind: 'inline', definition }, project: { machineId: 'machine', directory: '/work' }, trigger: event });
    expect(result.set.health).toBe('available');
    const body = AutomationDefinitionCreateRequestSchema.parse(network.request.mock.calls.find(([request]) => request.method === 'POST')?.[0].data);
    const trigger = body.triggers[0]!;
    expect(trigger.trigger).not.toHaveProperty('sourceInstanceId');
    expect(trigger.trigger).not.toHaveProperty('sourceConfig');
    expect(trigger.trigger).not.toHaveProperty('displayLabel');
    expect(trigger.trigger.kind === 'pluginEvent' && 'sourceSelectorId' in trigger.trigger).toBe(true);
    if (trigger.trigger.kind !== 'pluginEvent' || !('triggerDefinitionEnvelope' in trigger.trigger)) throw new Error('sealed Event missing');
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: snapshot.material,
      binding: { ...binding, automationId: body.automationId, triggerId: AutomationTriggerIdSchema.parse(trigger.triggerId), triggerRevision: 0,
        sourceSelectorId: trigger.trigger.sourceSelectorId }, envelope: trigger.trigger.triggerDefinitionEnvelope }))
      .toEqual({ kind: 'available', definition: privateDefinition });
  });
  it('reseals an enable-only Event patch to the next trigger revision without changing source identity', async () => {
    const context = AutomationStoredWorkflowDefinitionV2Schema.parse({ workspace: { directory: '/work' },
      executionTarget: { kind: 'session' }, inlineDefinition: definition });
    stored = detail(binding.automationId, binding.triggerId, binding.sourceSelectorId,
      sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: snapshot.material,
        randomBytes: getRandomBytes, binding, definition: privateDefinition }), 3,
      { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
        kind: 'automation_template_payload', material: snapshot.material, payload: context, randomBytes: getRandomBytes }) } });
    const actions = createCliWorkflowTriggerActions({ credentials, serverHttpBaseUrl: 'https://source.example', resolveWorkflow: resolveUnusedWorkflow });
    const result = await actions.update({ automationId: binding.automationId, triggerId: binding.triggerId, expectedRevision: 1, patch: { enabled: false } });
    expect(result.triggerRevision).toBe(4);
    expect(result.set.triggers[0]?.enabled).toBe(false);
    const body = AutomationDefinitionReconcileRequestSchema.parse(network.request.mock.calls.find(([request]) => request.method === 'PUT')?.[0].data);
    const trigger = body.triggers[0]!;
    if (trigger.kind !== 'existing') throw new Error('existing Event missing');
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: snapshot.material,
      binding: { ...binding, triggerRevision: 4 }, envelope: trigger.triggerDefinitionEnvelope }))
      .toEqual({ kind: 'available', definition: privateDefinition });
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee', material: snapshot.material,
      binding, envelope: trigger.triggerDefinitionEnvelope }).kind).toBe('bindingMismatch');
  });
});
