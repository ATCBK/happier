import { describe, expect, it } from 'vitest';
import { resolveReachV1 } from './resolveReachV1.js';
import type { ReachRuleV1 } from './reachRuleV1.js';

const context = { machineId: 'a', machinePlatform: 'posix' as const, directory: '/repo/sub', projectKey: 'p', agentId: 'gemini' };
const rule = (id: string, target: ReachRuleV1['target'], enabled: boolean, agentId?: string): ReachRuleV1 => ({ id, target, enabled, ...(agentId ? { agentId } : {}), createdAt: 1, updatedAt: 1 });

describe('resolveReachV1', () => {
  it('keeps an Agent exception at every place and permits a narrower exception for the same Agent', () => {
    const rules = [rule('project', { t: 'project', projectKey: 'p' }, true), rule('except', { t: 'allMachines' }, false, 'gemini')];
    expect(resolveReachV1(rules, context)).toEqual({ enabled: false, decidedBy: { ruleId: 'except', target: 'allMachines', agentQualified: true } });
    expect(resolveReachV1(rules, { ...context, agentId: 'codex' }).enabled).toBe(true);
    const restored = [...rules, rule('gemini-project', { t: 'project', projectKey: 'p' }, true, 'gemini')];
    expect(resolveReachV1(restored, context).enabled).toBe(true);
    expect(resolveReachV1(restored, { ...context, projectKey: 'other' }).enabled).toBe(false);
  });

  it('orders places within one Agent scope and retains the predecessor tie break', () => {
    const rules = [rule('all', { t: 'allMachines' }, true), rule('machine', { t: 'machine', machineId: 'a' }, false), rule('project', { t: 'project', projectKey: 'p' }, true), rule('workspace', { t: 'workspace', machineId: 'a', workspaceRoot: '/repo' }, false)];
    expect(resolveReachV1(rules, context).decidedBy?.ruleId).toBe('workspace');
    expect(resolveReachV1(rules, { ...context, directory: '/else' }).decidedBy?.ruleId).toBe('project');
    expect(resolveReachV1(rules, { ...context, directory: '/else', projectKey: null }).decidedBy?.ruleId).toBe('machine');
    expect(resolveReachV1(rules, { ...context, machineId: 'b', directory: null, projectKey: null }).decidedBy?.ruleId).toBe('all');
    expect(resolveReachV1([rule('z', { t: 'allMachines' }, true), rule('a', { t: 'allMachines' }, false)], context).decidedBy?.ruleId).toBe('a');
    expect(resolveReachV1([rule('general', { t: 'machine', machineId: 'a' }, true), rule('qualified', { t: 'machine', machineId: 'a' }, false, 'gemini')], context).enabled).toBe(false);
  });

  it('keeps Windows and POSIX comparisons at the canonical path owner', () => {
    const rules = [rule('folder', { t: 'workspace', machineId: 'a', workspaceRoot: 'C:\\Repo' }, true)];
    expect(resolveReachV1(rules, { ...context, directory: 'c:\\repo\\x', machinePlatform: 'win32' }).enabled).toBe(true);
    expect(resolveReachV1(rules, { ...context, directory: 'c:\\repo-other', machinePlatform: 'win32' }).enabled).toBe(false);
    expect(resolveReachV1([rule('folder', { t: 'workspace', machineId: 'a', workspaceRoot: '/Repo' }, true)], { ...context, directory: '/repo', machinePlatform: 'posix' }).enabled).toBe(false);
  });
});
