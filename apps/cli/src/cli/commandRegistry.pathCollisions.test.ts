import { describe, expect, it } from 'vitest';

import {
  assertComposedCommandPathsAreUnambiguous,
  listCollidingAgentCommandRoots,
  ensureMergedAgentCommandRegistryLoaded,
  resolveAdmittedActionCliCommand,
} from './commandRegistry';

describe('composed CLI command path ownership', () => {
  it('admits the real Action catalog alongside static commands at startup', async () => {
    await expect(ensureMergedAgentCommandRegistryLoaded()).resolves.toBeUndefined();
  });

  it('dispatches the Found list default and its read leaf from the real Action catalog', async () => {
    await ensureMergedAgentCommandRegistryLoaded();
    expect(await resolveAdmittedActionCliCommand(['skills', 'found', '--machine', 'machine_1']))
      .toMatchObject({ actionId: 'skills.found.list', path: ['skills', 'found'] });
    expect(await resolveAdmittedActionCliCommand(['skills', 'found', 'show', 'review', '--machine', 'machine_1']))
      .toMatchObject({ actionId: 'skills.found.read', path: ['skills', 'found', 'show'] });
    expect(await resolveAdmittedActionCliCommand(['skills', 'adopt', 'review', '--machine', 'machine_1']))
      .toMatchObject({ actionId: 'skills.found.adopt', path: ['skills', 'adopt'] });
  });

  it('rejects exact and subtree collisions across Action, static workflow, Agent, and plugin claims', () => {
    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'static', ownerId: 'session history', path: ['session', 'history'] },
      { source: 'action', ownerId: 'session.history.follow', path: ['session', 'history', 'follow'] },
    ])).toThrow(/session history.*session history follow/u);

    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'agent', ownerId: 'acme.agent', path: ['review'] },
      { source: 'plugin', ownerId: 'acme.plugin\/inspect', path: ['review', 'inspect'] },
    ])).toThrow(/review.*review inspect/u);

    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'action', ownerId: 'one', path: ['teams', 'members'] },
      { source: 'plugin', ownerId: 'two', path: ['teams', 'members'] },
    ])).toThrow(/teams members/u);
  });

  it('preserves an intentional namespace root while still rejecting terminal leaves below it', () => {
    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'static', ownerId: 'session', path: ['session'], allowsDescendants: true },
      { source: 'static', ownerId: 'session history', path: ['session', 'history'] },
      { source: 'action', ownerId: 'session.message.send', path: ['session', 'send'] },
    ])).not.toThrow();

    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'static', ownerId: 'session', path: ['session'], allowsDescendants: true },
      { source: 'static', ownerId: 'session history', path: ['session', 'history'] },
      { source: 'action', ownerId: 'session.history.follow', path: ['session', 'history', 'follow'] },
    ])).toThrow(/session history.*session history follow/u);
  });

  it('allows an explicitly composed Action family namespace without weakening unrelated leaves', () => {
    expect(() => assertComposedCommandPathsAreUnambiguous([
      {
        source: 'action',
        ownerId: 'teams.directory.sources.remove',
        path: ['teams', 'directory', 'sources', 'remove'],
        allowsDescendants: true,
      },
      {
        source: 'action',
        ownerId: 'teams.directory.sources.remove.preview',
        path: ['teams', 'directory', 'sources', 'remove', 'preview'],
      },
    ])).not.toThrow();

    expect(() => assertComposedCommandPathsAreUnambiguous([
      { source: 'action', ownerId: 'unrelated.remove', path: ['teams', 'members', 'remove'] },
      { source: 'action', ownerId: 'unrelated.preview', path: ['teams', 'members', 'remove', 'preview'] },
    ])).toThrow(/teams members remove/u);
  });

  it('fences every Agent declaration sharing a root instead of admitting the last one', () => {
    expect(listCollidingAgentCommandRoots([
      { cliSubcommand: 'review' },
      { cliSubcommand: 'codex' },
      { cliSubcommand: 'review' },
      { cliSubcommand: 'review' },
    ])).toEqual(['review']);
  });
});
