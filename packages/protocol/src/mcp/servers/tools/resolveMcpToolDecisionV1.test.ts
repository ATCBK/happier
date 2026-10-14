import { describe, expect, it } from 'vitest';
import type { AgentPermissionIntentV1 } from '../../../runtime/permissionIntentV1.js';
import type { McpServerToolPolicyV1 } from '../settingsV1.js';
import { projectMcpToolLaunchPolicyV1, resolveMcpToolDecisionV1 } from './resolveMcpToolDecisionV1.js';
import { McpToolSettingsV1Schema, McpServerToolSettingsPatchV1Schema } from '../settingsV1.js';
import { rehydrateCanonicalProtocolComposableSchema } from '../../../plugins/actions/protocolComposableSchema.js';
import { z } from 'zod/mini';

describe('MCP tool policy decision', () => {
  const modes: readonly AgentPermissionIntentV1[] = ['default', 'safe-yolo', 'read-only', 'plan', 'yolo'];
  const cases: readonly Readonly<{ policy: McpServerToolPolicyV1 | undefined; readOnlyHint?: boolean; approvals: readonly string[]; exposed?: boolean }>[] = [
    { policy: { default: 'allow_all', overrides: { tool: 'off' } }, approvals: ['deny', 'deny', 'deny', 'deny', 'deny'], exposed: false },
    { policy: { default: 'ask', overrides: { tool: 'allow' } }, readOnlyHint: true, approvals: ['allow', 'allow', 'deny', 'deny', 'allow'] },
    { policy: { default: 'allow_all', overrides: {} }, approvals: ['allow', 'allow', 'deny', 'deny', 'allow'] },
    { policy: { default: 'allow_read_only', overrides: {} }, readOnlyHint: true, approvals: ['allow', 'allow', 'allow', 'allow', 'allow'] },
    { policy: { default: 'allow_read_only', overrides: {} }, approvals: ['ask', 'ask', 'deny', 'deny', 'allow'] },
    { policy: { default: 'allow_read_only', overrides: { tool: 'ask' } }, readOnlyHint: true, approvals: ['ask', 'ask', 'allow', 'allow', 'allow'] },
    { policy: { default: 'allow_read_only', overrides: { tool: 'allow' } }, readOnlyHint: true, approvals: ['allow', 'allow', 'allow', 'allow', 'allow'] },
    { policy: { default: 'ask', overrides: {} }, readOnlyHint: true, approvals: ['ask', 'ask', 'deny', 'deny', 'allow'] },
    { policy: undefined, readOnlyHint: true, approvals: ['ask', 'ask', 'deny', 'deny', 'allow'] },
  ];
  for (const [row, input] of cases.entries()) {
    it.each(modes)(`honors T4 row ${row + 1} in %s`, permissionMode => {
      const result = resolveMcpToolDecisionV1({ policy: input.policy, toolName: 'tool', annotations: { readOnlyHint: input.readOnlyHint }, permissionMode });
      expect(result.approval).toBe(input.approvals[modes.indexOf(permissionMode)]);
      expect(result.exposed).toBe(input.exposed ?? true);
      expect(result.effectClass).toBe(input.policy?.default === 'allow_read_only' && input.readOnlyHint === true ? 'read' : 'unknown');
    });
  }
  it('uses only own tool overrides, including JavaScript object property names', () => {
    const policy: McpServerToolPolicyV1 = { default: 'ask', overrides: Object.create({ constructor: 'allow', tool: 'off' }) };
    for (const toolName of ['constructor', '__proto__', 'tool']) expect(resolveMcpToolDecisionV1({ policy, toolName, permissionMode: 'default' })).toMatchObject({ approval: 'ask', source: 'server_default' });
    const own = JSON.parse('{"__proto__":"off","constructor":"allow"}') as McpServerToolPolicyV1['overrides'];
    expect(resolveMcpToolDecisionV1({ policy: { default: 'ask', overrides: own }, toolName: '__proto__', permissionMode: 'yolo' })).toMatchObject({ exposed: false, approval: 'deny', source: 'tool' });
  });
  it('keeps executable and generated JSON Schema admission identical for opaque tool dictionary keys', () => {
    // JSON export owns serialization; Zod's non-enumerable ~standard metadata
    // is not part of the emitted schema consumed by the portable reader.
    const schema = rehydrateCanonicalProtocolComposableSchema(JSON.parse(JSON.stringify(z.toJSONSchema(McpToolSettingsV1Schema, { target: 'draft-07' }))));
    expect(schema).not.toBeNull();
    if (!schema) throw new Error('Tool dictionary schema could not be reconstructed');
    const tools = JSON.parse('{"__proto__":"off","constructor":"allow"}');
    expect(schema.parse(tools)).toEqual(McpToolSettingsV1Schema.parse(tools));
    expect(schema.safeParse(JSON.parse('{"__proto__":"allow_all"}')).success).toBe(false);
    expect(McpToolSettingsV1Schema.safeParse(JSON.parse('{"__proto__":"allow_all"}')).success).toBe(false);
    expect(McpServerToolSettingsPatchV1Schema.safeParse({ tools: JSON.parse('{"__proto__":"inherit"}') }).success).toBe(true);
    expect(McpServerToolSettingsPatchV1Schema.safeParse({ tools: JSON.parse('{"__proto__":true}') }).success).toBe(false);
  });
  it('reports the owning setting and a permission ceiling separately', () => {
    expect(resolveMcpToolDecisionV1({ policy: { default: 'ask', overrides: { tool: 'allow' } }, toolName: 'tool', permissionMode: 'default' }).source).toBe('tool');
    expect(resolveMcpToolDecisionV1({ policy: { default: 'allow_all', overrides: {} }, toolName: 'tool', permissionMode: 'read-only' }).source).toBe('permission_mode');
  });
  it('projects snapshot and unsnapshotted overrides while limiting unknown tools by mode', () => {
    const policy: McpServerToolPolicyV1 = { default: 'allow_read_only', overrides: { removed: 'off', newly_named: 'allow' } };
    const snapshot = { checkedAt: 1, machineId: 'machine', tools: [{ name: 'read', annotations: { readOnlyHint: true }, tokens: 1 }, { name: 'write', tokens: 1 }] };
    expect(projectMcpToolLaunchPolicyV1({ policy, snapshot, permissionMode: 'read-only' })).toEqual({ unlisted: 'deny', tools: { read: 'allow', write: 'deny', removed: 'off', newly_named: 'deny' } });
    expect(projectMcpToolLaunchPolicyV1({ policy: { default: 'allow_all', overrides: {} }, snapshot: undefined, permissionMode: 'default' })).toEqual({ unlisted: 'allow', tools: {} });
  });
});
