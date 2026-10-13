import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { getActionSpec, listActionCliCommandDeclarations } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { SKILL_ACTION_INPUT_SCHEMAS_V1 } from '../prompts/library/skills/skillActionSchemasV1.js';

const specFor = (id: string) => getActionSpec(ActionIdSchema.parse(id));

describe('machine skill Action contracts', () => {
  it('keeps Found reads and adoption at the Account operation with strict reviewable contracts', () => {
    const read = specFor('skills.found.read'), adopt = specFor('skills.found.adopt');
    const identity = { machineId: 'machine', path: '/native/example' };
    const adoption = { machineId: 'machine', items: [{ name: 'example', path: identity.path }], where: { kind: 'replace', rules: [] } };
    expect(read.inputSchema.parse(identity)).toEqual(identity);
    expect(read.outputSchema?.safeParse({ name: 'example', files: [{ path: 'SKILL.md', contentBase64: 'eA==', contentKind: 'utf8', unixMode: 0o755 }] }).success).toBe(true);
    expect(adopt.inputSchema.parse(adoption)).toEqual(adoption);
    expect(adopt.outputSchema?.safeParse({ skillIds: ['skill'], includedInSessionId: null,
      incomplete: [{ skillId: 'skill', step: 'rules' }] }).success).toBe(true);
    expect(read.inputSchema.safeParse({ ...identity, assetTypeId: 'claude.skill' }).success).toBe(false);
    expect(adopt.inputSchema.safeParse({ ...adoption, items: [{ ...adoption.items[0], agentIds: ['codex'] }] }).success).toBe(false);
    for (const spec of [read, adopt]) {
      expect(spec.executionPlacement).toBe('account');
      const settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
      for (const surface of ['ui', 'cli', 'agent', 'mcp'] as const) {
        expect(resolveActionApprovalRouting({ actionId: spec.id, spec, settings,
          context: { surface, authority: 'present_user', actionCaller: { kind: 'host' } } }).required)
          .toBe(spec.id === adopt.id && surface !== 'ui');
      }
    }
  });
  it('reads partial Found scans through the strict canonical machine contract', () => {
    const spec = specFor('skills.found.list');
    const input = { machineId: 'machine', directory: '/repo' };
    const output = {
      scannedAt: 12,
      roots: [
        { path: '/home/alice/.agents/skills', scope: 'user', agents: ['codex'], status: 'ok' },
        { path: '/repo/.claude/skills', scope: 'project', agents: ['claude'], status: 'failed' },
      ],
      items: [{ name: 'example', description: null, path: '/home/alice/.agents/skills/example',
        digest: 'sha256:' + 'a'.repeat(64), agents: ['codex'], scope: 'user', inLibrary: 'skill',
        masksLibrary: true, happierInstalled: true, pluginOwned: null }],
    };
    expect(spec.executionPlacement).toBe('machine');
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.outputSchema?.parse(output)).toEqual(output);
    expect(spec.inputSchema.safeParse({ ...input, assetTypeId: 'codex.skill' }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ ...output, items: [{ ...output.items[0], extra: true }] }).success).toBe(false);
    const plugin = { ...output.items[0], scope: 'plugin', masksLibrary: false, pluginOwned: { pluginName: 'example-plugin' } };
    expect(spec.outputSchema?.safeParse({ ...output, items: [plugin] }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ ...output, items: [{ ...plugin, pluginOwned: { ...plugin.pluginOwned, extra: true } }] }).success).toBe(false);
    expect(ActionIdSchema.safeParse('daemon.promptAssets.discover').success).toBe(false);
    for (const surface of ['ui', 'cli', 'agent', 'mcp'] as const) {
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec,
        settings: normalizeActionsSettingsV1({ v: 1, actions: {} }),
        context: { surface, authority: 'present_user', actionCaller: { kind: 'host' } } }).required).toBe(false);
    }
  });

  it('keeps machine writes separate from the library contract and confirms only present-user removal', () => {
    const install = specFor('skills.machine.install');
    const uninstall = specFor('skills.machine.uninstall');
    expect(install.inputSchema.parse({ skillId: 'skill', machineId: 'machine' })).toEqual({ skillId: 'skill', machineId: 'machine' });
    expect(install.inputSchema.parse({ skillId: 'skill', machineId: 'machine', agents: ['third.party/agent'] })).toMatchObject({ agents: ['third.party/agent'] });
    expect(install.inputSchema.safeParse({ skillId: 'skill', machineId: 'machine', agents: [' codex'] }).success).toBe(false);
    expect(uninstall.inputSchema.parse({ skillId: 'skill', machineId: 'machine', force: true })).toEqual({ skillId: 'skill', machineId: 'machine', force: true });
    expect(install.outputSchema?.parse({ receipts: [{ root: '/skills', path: '/skills/example', digest: 'sha256:' + 'a'.repeat(64) }] }))
      .toEqual({ receipts: [{ root: '/skills', path: '/skills/example', digest: 'sha256:' + 'a'.repeat(64) }] });
    expect(uninstall.outputSchema?.parse({ removed: ['/skills/example'] })).toEqual({ removed: ['/skills/example'] });
    for (const spec of [install, uninstall]) {
      expect(Object.hasOwn(SKILL_ACTION_INPUT_SCHEMAS_V1, spec.id)).toBe(false);
      expect(spec.executionPlacement).toBe('machine');
      expect(spec.inputSchema.safeParse({ skillId: 'skill', machineId: 'machine', root: '/arbitrary' }).success).toBe(false);
      for (const surface of ['ui', 'cli', 'agent', 'mcp'] as const) {
        const context = { surface, authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        const settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
        expect(resolveActionApprovalRouting({ actionId: spec.id, spec, settings, context }).required)
          .toBe(surface !== 'ui' || spec.id === uninstall.id);
        const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [spec.id]: [surface] } });
        expect(resolveActionApprovalRouting({ actionId: spec.id, spec, settings: waived, context }).required).toBe(false);
      }
    }
  });

  it('compiles the friendly Found leaf from its canonical spec', () => {
    const entry = listActionCliCommandDeclarations().find(command => String(command.spec.id) === 'skills.found.list'
      && command.binding.path.join(' ') === 'skills found list');
    expect(entry).toBeDefined();
    expect(entry?.spec.cli?.flagAliases).toContainEqual({ path: 'machineId', aliases: ['--machine'] });
    expect(entry?.spec.cli?.flagAliases).toContainEqual({ path: 'directory', aliases: ['--dir'] });
  });

  it('compiles friendly machine installation leaves from the same specs', () => {
    const commands = listActionCliCommandDeclarations();
    for (const [id, path] of [
      ['skills.machine.install', ['skills', 'machine-install']],
      ['skills.machine.uninstall', ['skills', 'machine-uninstall']],
    ] as const) {
      const entry = commands.find(command => command.spec.id === id && command.binding.path.join(' ') === path.join(' '));
      expect(entry, id).toBeDefined();
      const cli = entry?.spec.cli;
      expect(cli?.flagAliases).toContainEqual({ path: 'machineId', aliases: ['--machine'] });
      expect(entry?.binding.positionals).toEqual(['itemId']);
      const input = id === 'skills.machine.install'
        ? { itemId: 'skill', machineId: 'machine', agents: ['codex'] }
        : { itemId: 'skill', machineId: 'machine', force: true };
      expect(cli?.bindInput?.(input, { actionId: specFor(id).id, invocationId: 'invocation' }))
        .toEqual(id === 'skills.machine.install'
          ? { skillId: 'skill', machineId: 'machine', agents: ['codex'] }
          : { skillId: 'skill', machineId: 'machine', force: true });
      if (id === 'skills.machine.install') {
        expect(cli?.flagAliases).toContainEqual({ path: 'agents', aliases: ['--agent'] });
      }
    }
  });
});
