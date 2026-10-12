import { describe, expect, it } from 'vitest';
import { groupReachRulesV1 } from './reachRulesChangeV1.js';
import type { ReachRuleV1 } from './reachRuleV1.js';
import { resolveReachV1 } from './resolveReachV1.js';

const rule = (id: string, target: ReachRuleV1['target'], enabled: boolean, agentId?: string): ReachRuleV1 => ({ id, target, enabled, ...(agentId ? { agentId } : {}), createdAt: 1, updatedAt: 1 });

describe('groupReachRulesV1', () => {
  it('keeps project and workspace rules that restore an Off ancestor, omitting a redundant On', () => {
    const grouped = groupReachRulesV1([rule('all', { t: 'allMachines' }, true), rule('machine', { t: 'machine', machineId: 'a' }, false), rule('project', { t: 'project', projectKey: 'p' }, true), rule('workspace', { t: 'workspace', machineId: 'a', workspaceRoot: '/repo' }, true), rule('redundant', { t: 'machine', machineId: 'b' }, true)]);
    expect(grouped.base).toBe('on');
    expect(grouped.turnedOnIn.map(item => item.id).sort()).toEqual(['project', 'workspace']);
    expect(grouped.except.map(item => item.id)).toEqual(['machine']);
  });

  it('groups every effective Agent override chain separately', () => {
    const grouped = groupReachRulesV1([rule('all', { t: 'allMachines' }, true), rule('except', { t: 'allMachines' }, false, 'gemini'), rule('restored', { t: 'project', projectKey: 'p' }, true, 'gemini')]);
    expect(grouped.agents).toMatchObject([{ agentId: 'gemini', everywhere: 'off', turnedOnIn: [{ id: 'restored' }], except: [] }]);
  });

  it('preserves resolver outcomes in the sentence structure for generated override chains', () => {
    const places: ReadonlyArray<Readonly<{ target: ReachRuleV1['target']; agentId?: string }>> = [
      { target: { t: 'allMachines' } },
      { target: { t: 'machine', machineId: 'a' } },
      { target: { t: 'project', projectKey: 'p' } },
      { target: { t: 'workspace', machineId: 'a', workspaceRoot: '/repo' } },
      { target: { t: 'allMachines' }, agentId: 'gemini' },
      { target: { t: 'project', projectKey: 'p' }, agentId: 'gemini' },
      { target: { t: 'workspace', machineId: 'a', workspaceRoot: '/repo/nested' }, agentId: 'gemini' },
    ];
    // Each slot is absent, On or Off. This includes every restoring/except combination,
    // rather than sampling only monotone Everywhere-plus-exception rule sets.
    for (let value = 0; value < 3 ** places.length; value++) {
      let encoding = value;
      const rules = places.flatMap((place, index) => {
        const state = encoding % 3;
        encoding = Math.floor(encoding / 3);
        return state ? [rule(String(index), place.target, state === 1, place.agentId)] : [];
      });
      const grouped = groupReachRulesV1(rules);
      const structure = [
        ...(grouped.base === 'none' ? [] : [rule('base', { t: 'allMachines' }, grouped.base === 'on')]),
        ...grouped.turnedOnIn, ...grouped.except,
        ...grouped.agents.flatMap(agent => [
          ...(agent.everywhere === null ? [] : [rule(`agent:${agent.agentId}`, { t: 'allMachines' }, agent.everywhere === 'on', agent.agentId)]),
          ...agent.turnedOnIn, ...agent.except,
        ]),
      ];
      for (const machineId of ['a', 'b']) for (const projectKey of ['p', 'q', null]) {
        for (const directory of ['/repo/nested/child', '/repo/other', '/outside', null]) for (const agentId of ['gemini', 'codex']) {
          const context = { machineId, projectKey, directory, agentId, machinePlatform: 'posix' as const };
          expect(resolveReachV1(structure, context).enabled, `rules=${value}, context=${JSON.stringify(context)}`)
            .toBe(resolveReachV1(rules, context).enabled);
        }
      }
    }
  });
});
