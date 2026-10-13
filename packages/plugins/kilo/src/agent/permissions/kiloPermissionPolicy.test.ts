import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { listHappierToolAutoApprovedNamesV1 } from '@happier-dev/protocol/tools/happierToolAutoApprovalV1';

import {
  buildKiloOpenCodePermissionEnv,
  resolveKiloOpenCodePermissionPolicy,
} from './kiloPermissionPolicy.js';

describe('Kilo OpenCode permission policy', () => {
  it('spawns with the default composed environment and preserves native safe-tool approval beside MCP policy', () => {
    const env = buildKiloOpenCodePermissionEnv({ permissionIntent: 'default', mcpToolPolicy: {
      docs: { unlisted: 'ask', tools: { mutate: 'off', inspect: 'allow' } },
    } });
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.KILO_PERMISSION)'], { env, encoding: 'utf8' });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const policy = JSON.parse(child.stdout);
    for (const name of listHappierToolAutoApprovedNamesV1()) expect(policy[`happier_${name}`], name).toBe('allow');
    expect(policy.docs_mutate).toBe('deny');
    expect(policy.docs_inspect).toBe('ask');
    expect(policy.mcp__happier__action_execute).toBeUndefined();
  });
  it('preserves caller-owned native policy without injecting mode grants when adding MCP rules', () => {
    const env = buildKiloOpenCodePermissionEnv({
      permissionIntent: 'yolo', env: { KILO_PERMISSION: '{"*":"deny"}' },
      mcpToolPolicy: { docs: { unlisted: 'ask', tools: { mutate: 'ask' } } },
    });
    expect(JSON.parse(env.KILO_PERMISSION)).toEqual({ '*': 'deny', 'docs_*': 'ask', docs_mutate: 'ask' });
  });
  it('denies native aliases shared by distinct MCP tool names', () => {
    const env = buildKiloOpenCodePermissionEnv({ permissionIntent: 'yolo', mcpToolPolicy: {
      docs: { unlisted: 'ask', tools: { 'file.read': 'off', 'file/read': 'allow' } },
    } });
    expect(JSON.parse(env.KILO_PERMISSION).docs_file_read).toBe('deny');
  });
  it('merges MCP rules through the canonical env writer after caller permissions', () => {
    const env = buildKiloOpenCodePermissionEnv({
      permissionIntent: 'yolo',
      env: { KILO_PERMISSION: '{"docs_delete":"allow","docs_*":"allow","custom":"ask"}' },
      mcpToolPolicy: { docs: { unlisted: 'allow', tools: { search: 'allow', delete: 'off' } } },
    });
    expect(JSON.parse(env.KILO_PERMISSION)).toMatchObject({
      custom: 'ask',
      'docs_*': 'ask', docs_search: 'ask', docs_delete: 'deny',
    });
    const keys = Object.keys(JSON.parse(env.KILO_PERMISSION));
    expect(keys.indexOf('docs_*')).toBeLessThan(keys.indexOf('docs_delete'));
  });
  it('delivers read-only permissions through the Kilo permission environment key', () => {
    const env = buildKiloOpenCodePermissionEnv({ permissionIntent: 'read-only' });

    expect(env).toHaveProperty('KILO_PERMISSION');
    expect(JSON.parse(env.KILO_PERMISSION)).toMatchObject({
      '*': 'deny',
      read: 'allow',
      edit: 'deny',
      write: 'deny',
      bash: 'deny',
    });
  });

  it.each([
    { mode: 'default', wildcard: 'ask', read: 'allow', edit: 'ask', bash: 'ask', external: 'ask' },
    { mode: 'read-only', wildcard: 'deny', read: 'allow', edit: 'deny', bash: 'deny', external: 'deny' },
    { mode: 'plan', wildcard: 'deny', read: 'allow', edit: 'deny', bash: 'deny', external: 'deny' },
    { mode: 'safe-yolo', wildcard: 'ask', read: 'allow', edit: 'allow', bash: 'ask', external: 'ask' },
    { mode: 'yolo', wildcard: 'allow', read: 'allow', edit: 'allow', bash: 'allow', external: 'allow' },
  ] as const)('maps permissionIntent="$mode" to the source-equivalent KILO_PERMISSION policy', ({
    mode,
    wildcard,
    read,
    edit,
    bash,
    external,
  }) => {
    const parsed = resolveKiloOpenCodePermissionPolicy(mode);
    expect(parsed['*']).toBe(wildcard);
    expect(parsed.read).toBe(read);
    expect(parsed.edit).toBe(edit);
    expect(parsed.bash).toBe(bash);
    expect(parsed.external_directory).toBe(external);
    expect(parsed.happier_change_title).toBe('allow');
  });

  it('does not overwrite caller-provided KILO_PERMISSION', () => {
    expect(buildKiloOpenCodePermissionEnv({
      env: { KILO_PERMISSION: '{"custom":"allow"}' },
      permissionIntent: 'read-only',
    })).toEqual({});
  });

  it('uses the richer shared OpenCode-style policy vocabulary', () => {
    expect(resolveKiloOpenCodePermissionPolicy('read-only')).toMatchObject({
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      ls: 'allow',
      edit: 'deny',
      write: 'deny',
      task: 'deny',
      external_directory: 'deny',
      doom_loop: 'deny',
      happier_change_title: 'allow',
      happier_session_title_set: 'allow',
      happier_action_execute: 'allow',
    });
  });
});
