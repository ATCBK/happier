import { describe, expect, it } from 'vitest';
import type { ActionId } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';

describe('registry Agent admission Action', () => {
  it('requires its own confirmation for both first-use and Install Now, with caller waivers owned by policy', () => {
    const actionId = 'agents.acp.backends.installFromRegistry' as ActionId;
    const spec = getActionSpec(actionId);
    for (const installOn of [undefined, ['machine-a', 'machine-b']]) {
      const parsed = spec.inputSchema.parse({ fromRegistry: { sourceId: 'builtin:acp-registry', itemId: 'goose', version: '1.0.0' },
        ...(installOn ? { installOn } : {}) });
      expect(parsed).toHaveProperty('fromRegistry.version', '1.0.0');
      for (const surface of ['ui', 'cli', 'agent', 'mcp'] as const) {
        const context = { surface, authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        expect(resolveActionApprovalRouting({ actionId, spec, context,
          settings: normalizeActionsSettingsV1({ v: 1, actions: {} }) }).required).toBe(true);
        expect(resolveActionApprovalRouting({ actionId, spec, context,
          settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } }) }).required).toBe(false);
      }
    }
    expect(spec.inputSchema.safeParse({ fromRegistry: { sourceId: 'builtin:acp-registry', itemId: 'goose' } }).success).toBe(false);
    expect(getActionSpec('agents.acp.backends.upsert').inputSchema.safeParse({ fromRegistry: {
      sourceId: 'builtin:acp-registry', itemId: 'goose', version: '1.0.0',
    } }).success).toBe(false);
    const upsert = getActionSpec('agents.acp.backends.upsert');
    expect(resolveActionApprovalRouting({ actionId: upsert.id, spec: upsert,
      context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } },
      settings: normalizeActionsSettingsV1({ v: 1, actions: {} }) }).required).toBe(false);
  });
});
