import { describe, expect, it } from 'vitest';
import { listActionSpecs } from '@happier-dev/protocol/actions';
import { listHappierToolAutoApprovedNameSpellingsV1 } from '@happier-dev/protocol/tools/happierToolAutoApprovalV1';

import {
  isPermissionGuardToolName,
  isSharedHappierShellBridgeToolName,
  isSharedPermissionSafeToolName,
} from './permissionTaxonomy';

describe('permissionTaxonomy', () => {
  it('auto-approves every safe direct Action and policy-gated meta tool, never another server', () => {
    for (const spec of listActionSpecs()) {
      const name = spec.bindings?.mcpToolName;
      if (!name) continue;
      expect(isSharedPermissionSafeToolName(`mcp__happier__${name}`), spec.id).toBe(spec.safety === 'safe');
    }
    expect(isSharedPermissionSafeToolName('mcp__happier__action_execute')).toBe(true);
    expect(isSharedPermissionSafeToolName('mcp__other__session_title_set')).toBe(false);
    for (const prefix of ['', 'mcp__happier__', 'mcp__happy__', 'happier__', 'happy__', 'happier_', 'happy_']) {
      for (const name of listHappierToolAutoApprovedNameSpellingsV1(prefix)) expect(isSharedPermissionSafeToolName(name), name).toBe(true);
    }
  });
  it('recognizes shared safe tools without substring collisions', () => {
    expect(isSharedPermissionSafeToolName('think')).toBe(true);
    expect(isSharedPermissionSafeToolName('session_title_set')).toBe(true);
    expect(isSharedPermissionSafeToolName('save_memory')).toBe(true);
    expect(isSharedPermissionSafeToolName('mcp__happier__change_title')).toBe(true);
    expect(isSharedPermissionSafeToolName('think_malware')).toBe(false);
  });

  it('recognizes safer shell-bridge tool aliases through the shared owner', () => {
    expect(isSharedHappierShellBridgeToolName('change_title')).toBe(true);
    expect(isSharedHappierShellBridgeToolName('save_memory')).toBe(true);
    expect(isSharedHappierShellBridgeToolName('bash')).toBe(false);
  });

  it('recognizes guard tools independently from write-like heuristics', () => {
    expect(isPermissionGuardToolName('external_directory')).toBe(true);
    expect(isPermissionGuardToolName('doom_loop')).toBe(true);
    expect(isPermissionGuardToolName('bash')).toBe(false);
  });
});
