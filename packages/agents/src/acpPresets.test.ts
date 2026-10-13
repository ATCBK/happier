import { describe, expect, it } from 'vitest';
import { listHappierToolAutoApprovedNamesV1, listHappierToolAutoApprovedNameSpellingsV1 } from '@happier-dev/protocol/tools/happierToolAutoApprovalV1';

import {
  ACP_AGENT_CLI_TRANSPORT_TIMEOUTS,
  ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES,
  ACP_WRITE_LIKE_PERMISSION_KINDS,
  createAcpToolNameInferencePreset,
  normalizeAcpPermissionIntent,
  resolveAcpToolPermissionPolicy,
} from './acpPresets.js';
import * as acpPresetExports from './acpPresets.js';

describe('native Agent ACP presets', () => {
  it('provides the shared timeout and tool-name inference policy', () => {
    expect(ACP_AGENT_CLI_TRANSPORT_TIMEOUTS).toMatchObject({
      initMs: 90_000,
      toolCallMs: 120_000,
      investigationToolCallMs: 300_000,
      toolKindTimeouts: { think: 30_000 },
      idleMs: 500,
    });
    expect(createAcpToolNameInferencePreset({ shellBridgeHint: true })).toMatchObject({
      preferLongestPattern: true,
      shellBridgeHint: true,
      investigationToolIdPatterns: ['task'],
      investigationToolKinds: ['task'],
      patterns: expect.arrayContaining([
        expect.objectContaining({ name: 'change_title', inputFields: ['title'] }),
        expect.objectContaining({ name: 'write' }),
        expect.objectContaining({ name: 'task' }),
      ]),
    });
  });

  it('normalizes permission aliases and emits the shared tool policy', () => {
    expect(normalizeAcpPermissionIntent('workspace_write')).toBe('safe-yolo');
    expect(normalizeAcpPermissionIntent('danger-full-access')).toBe('yolo');
    expect(ACP_WRITE_LIKE_PERMISSION_KINDS).toEqual(['external_directory', 'doom_loop']);

    const policy = resolveAcpToolPermissionPolicy('read_only');
    const value = policy.read;
    expect(value).toBe('allow');
    expect(policy).toMatchObject({
      '*': 'deny',
      read: 'allow',
      edit: 'deny',
      happier_change_title: 'allow',
    });
  });

  it('keeps the static approval list narrow and provider-neutral', () => {
    expect(ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES).toEqual(listHappierToolAutoApprovedNamesV1());
    const policy = resolveAcpToolPermissionPolicy('plan');
    for (const prefix of ['happier_', 'happy_']) {
      for (const name of listHappierToolAutoApprovedNameSpellingsV1(prefix)) expect(policy[name], name).toBe('allow');
    }
    expect(policy.mcp__happier__action_execute).toBeUndefined();
    expect(policy['change-title']).toBeUndefined();
    expect(policy.action_execute).toBeUndefined();
    expect(acpPresetExports).not.toHaveProperty('resolveOpenCodeStylePermissionPolicy');
  });
});
