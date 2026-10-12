import { describe, expect, it } from 'vitest';
import { groupReachRulesV1 } from './reachRulesChangeV1.js';
import type { ReachRuleV1 } from './reachRuleV1.js';

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
});
