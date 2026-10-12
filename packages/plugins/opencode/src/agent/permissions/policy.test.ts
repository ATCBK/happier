import { describe, expect, it } from 'vitest';
import { listHappierToolAutoApprovedNamesV1 } from '@happier-dev/protocol/tools/happierToolAutoApprovalV1';

import {
  buildOpenCodePermissionEnv,
  buildOpenCodeSessionPermissionRuleset,
  buildOpenCodeSessionScopedPermissionRuleset,
  resolveOpenCodePermissionConfig,
} from './policy.js';

describe('OpenCode permission policy', () => {
  it('keeps read-only intent fail-closed while preserving safe aliases', () => {
    const config = resolveOpenCodePermissionConfig('read-only');

    expect(config['*']).toBe('deny');
    expect(config.read).toBe('allow');
    expect(config.edit).toBe('deny');
    expect(config.write).toBe('deny');
    expect(config.change_title).toBe('allow');
    expect(config.session_title_set).toBe('allow');
    expect(config.happier_action_execute).toBe('allow');
  });

  it('promotes safe-yolo intent to allow edit aliases in the emitted session ruleset', () => {
    const ruleset = buildOpenCodeSessionPermissionRuleset('safe-yolo');
    const byPermission = new Map(ruleset.map((entry) => [entry.permission, entry.action] as const));

    expect(byPermission.get('*')).toBe('ask');
    expect(byPermission.get('read')).toBe('allow');
    expect(byPermission.get('edit')).toBe('allow');
    expect(byPermission.get('write')).toBe('allow');
    expect(byPermission.get('mcp__happier__action_execute')).toBe('allow');
  });

  it('serializes OpenCode permission env from the canonical policy', () => {
    expect(JSON.parse(buildOpenCodePermissionEnv('plan').OPENCODE_PERMISSION)).toMatchObject({
      '*': 'deny',
      read: 'allow',
      write: 'deny',
    });
  });

  it('denies other session namespaces and then restores the current mode plus exact built-in safe tools', () => {
    const rules = buildOpenCodeSessionScopedPermissionRuleset('default', {
      registrations: [
        { projectedName: 'happier-session-session-a--happier' },
        { projectedName: 'happier-session-session-a--custom' },
      ],
      requiredHappierServerName: 'happier-session-session-a--happier',
    });

    const names = listHappierToolAutoApprovedNamesV1();
    expect(rules.slice(-(3 + names.length))).toEqual([
      { permission: 'happier-session-*', pattern: '*', action: 'deny' },
      { permission: 'happier-session-session-a--happier_*', pattern: '*', action: 'ask' },
      { permission: 'happier-session-session-a--custom_*', pattern: '*', action: 'ask' },
      ...names.map((name) => ({ permission: `happier-session-session-a--happier_${name}`, pattern: '*', action: 'allow' })),
    ]);
    expect(rules).not.toContainEqual({ permission: 'happier-session-session-a--happier_daemon_filesystem_delete', pattern: '*', action: 'allow' });
  });
});
