import { describe, expect, it } from 'vitest';
import { resolveSessionCapabilitiesV1 } from './resolveSessionCapabilitiesV1.js';
import type { ReachContextV1 } from './resolveReachV1.js';
import type { ReachRuleV1 } from './reachRuleV1.js';

const rules: ReachRuleV1[] = [
  { id: 'project-on', target: { t: 'project', projectKey: 'project' }, enabled: true, createdAt: 1, updatedAt: 1 },
  { id: 'agent-off', target: { t: 'allMachines' }, agentId: 'gemini', enabled: false, createdAt: 1, updatedAt: 1 },
];
const contexts: ReachContextV1[] = [
  { machineId: 'unix', machinePlatform: 'posix', directory: '/work/checkout', projectKey: 'project', agentId: 'codex' },
  { machineId: 'windows', machinePlatform: 'win32', directory: 'D:\\Other\\checkout', projectKey: 'project', agentId: 'codex' },
];
const input = {
  mcp: { v: 1 as const, strictMode: false, servers: [{ id: 'mcp', name: 'mcp', transport: 'stdio' as const,
    stdio: { command: 'mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
    bindings: rules.map(rule => ({ ...rule, serverId: 'mcp' })) },
  skills: { items: [{ skillId: 'skill', name: 'skill' }], rules: rules.map(rule => ({ ...rule, skillId: 'skill' })) },
  selection: {}, agentAcceptsUserMcp: true,
};

describe('Account Project reach through the shared capability resolver', () => {
  it('follows the Project across different machines and roots, with D33 exceptions and session precedence', () => {
    for (const context of contexts) {
      const on = resolveSessionCapabilitiesV1({ ...input, context });
      expect(on.mcp.items[0]).toMatchObject({ selected: true, reason: 'rule_on', decidedBy: { ruleId: 'project-on' } });
      expect(on.skills.items[0]).toMatchObject({ selected: true, reason: 'rule_on', decidedBy: { ruleId: 'project-on' } });
      for (const projectKey of ['other', null]) {
        const off = resolveSessionCapabilitiesV1({ ...input, context: { ...context, projectKey } });
        expect(off.mcp.items[0]).toMatchObject({ selected: false, reason: 'no_rule' });
        expect(off.skills.items[0]).toMatchObject({ selected: false, reason: 'no_rule' });
      }
      const except = resolveSessionCapabilitiesV1({ ...input, context: { ...context, agentId: 'gemini' } });
      expect(except.mcp.items[0]).toMatchObject({ selected: false, decidedBy: { ruleId: 'agent-off', agentQualified: true } });
      expect(except.skills.items[0]).toMatchObject({ selected: false, decidedBy: { ruleId: 'agent-off', agentQualified: true } });
      const included = resolveSessionCapabilitiesV1({ ...input, context: { ...context, agentId: 'gemini' }, selection: {
        mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['mcp'], forceExcludeServerIds: [] },
        skills: { v: 1, forceIncludeSkillIds: ['skill'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] },
      } });
      expect(included.mcp.items[0]).toMatchObject({ selected: true, reason: 'session_added' });
      expect(included.skills.items[0]).toMatchObject({ selected: true, reason: 'session_added' });
    }
  });
});
