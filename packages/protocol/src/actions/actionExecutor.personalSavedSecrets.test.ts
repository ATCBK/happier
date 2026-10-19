import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';

describe('personal Saved Secret Action boundary', () => {
  it('keeps plaintext in live input custody and reuses exact UI confirmation while automated writes require approval', () => {
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
    for (const id of ['secrets.create', 'secrets.update', 'secrets.delete'] as const) {
      const spec = getActionSpec(id);
      const input = id === 'secrets.create' ? { name: 'Private token', value: 'private-test-value' }
        : id === 'secrets.update' ? { secretId: 'resource-id', value: 'private-test-value', expectedUpdatedAt: 1 }
          : { secretId: 'resource-id', expectedUpdatedAt: 1 };
      expect(spec.safety).toBe('danger');
      expect(resolveActionApprovalRouting({ actionId: id, spec, settings,
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } }).required).toBe(id === 'secrets.delete');
      for (const surface of ['ui', 'agent', 'cli', 'mcp'] as const) {
        expect(resolveActionApprovalRouting({ actionId: id, spec, settings,
          context: { surface, authority: 'present_user', actionCaller: { kind: 'host' },
            ...(surface === 'ui' ? { presentUserConfirmation: { actionId: id } } : {}) } }).required).toBe(surface !== 'ui');
      }
      if (id !== 'secrets.delete') {
        expect(spec.approvalInputCustody).toBe('live_only');
        expect(JSON.stringify(spec.projectObservationInput?.(input))).not.toContain('private-test-value');
      }
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
    }
    expect(getActionSpec('secrets.list').outputSchema?.safeParse({ secrets: [{ secretId: 'resource-id',
      name: 'Private token', kind: 'token', updatedAt: 1, value: 'must never be listed' }] }).success).toBe(false);
  });
});
