import { describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { ActionPolicyInputSchemas } from './actionPolicyActionFamily.js';
import { readActionAudiencePolicy, setActionAudiencePolicy } from './actionAudiencePolicy.js';
import { getActionSpec } from './actionSpecs.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';

describe('exact Action audience policy', () => {
  it('preserves a contributed Action and opaque neighbour while resetting only the requested audience', () => {
    const actionId = 'example.sources/actions/merge-v1';
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      [actionId]: { enabled: false, disabledSurfaces: ['cli', 'agent'], approvalRequiredSurfaces: ['mcp'],
        futurePolicy: { retained: true } },
      'future.action': { enabled: false, futurePreference: 'retained' },
    } });
    expect(ActionPolicyInputSchemas['actions.policy.set'].parse({ actionId, audience: 'agent', mode: 'allowed' }))
      .toEqual({ actionId, audience: 'agent', mode: 'allowed' });
    const allowed = setActionAudiencePolicy(settings, actionId, 'agent', 'allowed');
    expect(readActionAudiencePolicy(allowed, actionId, 'agent')).toEqual({ actionId, audience: 'agent', mode: 'allowed',
      actionEnabled: false, enabled: false });
    const reset = setActionAudiencePolicy(allowed, actionId, 'agent', 'default');
    expect(reset.actions[actionId]).toMatchObject({ enabled: false, disabledSurfaces: ['cli'], approvalRequiredSurfaces: ['mcp'],
      futurePolicy: { retained: true } });
    expect(reset.actions['future.action']).toEqual(settings.actions['future.action']);
    expect(reset.approvalWaivedSurfaces?.[actionId]).toBeUndefined();
  });

  it('publishes strict discoverable schemas without admitting raw policy or an unknown host Action', () => {
    const input = { actionId: 'prompt_doc.update', audience: 'agent', mode: 'allowed' };
    const schema = getActionSpec('actions.policy.set').inputSchema;
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, actionId: 'unknown.action' }).success).toBe(false);
    expect(schema.safeParse({ ...input, confirmed: true }).success).toBe(false);
    expect(schema.safeParse({ ...input, actionsSettingsV1: { v: 1, actions: {} } }).success).toBe(false);
    expect(zodSchemaToJsonSchemaObject(schema)).toMatchObject({ type: 'object', additionalProperties: false,
      properties: { actionId: { type: 'string' }, audience: { type: 'string' }, mode: { type: 'string' } } });
  });
});
