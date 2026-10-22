import { describe, expect, it } from 'vitest';

import type { SkillAgentFact, SkillMachineTruth } from './useSkillMachineTruth';
import { summarizeMachines } from './skillMachineSummary';

const names: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const agentName = (agentId: string) => names[agentId] ?? agentId;

function entry(name: string, offline: boolean, delivered: string[] = [], pending: string[] = []): SkillMachineTruth {
  const facts = new Map<string, SkillAgentFact>();
  for (const agentId of delivered) facts.set(agentId, { kind: 'delivered' });
  for (const agentId of pending) facts.set(agentId, { kind: 'pending' });
  return {
    machine: { machineId: name, platform: 'posix', agentIds: [...delivered, ...pending], name, online: !offline, offline, lastSeenAt: null },
    skillAgents: [...delivered, ...pending], cannotLoad: [], facts, projectedAgents: [],
  };
}

describe('summarizeMachines', () => {
  it('names the Agents once per group of machines, never repeating a machine name, and keeps the offline count apart', () => {
    expect(summarizeMachines([entry('NLDW6', false, ['claude', 'codex']), entry('away-1', true), entry('away-2', true)], agentName))
      .toEqual({ summary: 'Claude, Codex on NLDW6', note: '2 offline' });
    expect(summarizeMachines([
      entry('a', false, ['claude', 'codex']), entry('b', false, ['claude', 'codex']), entry('c', false, ['claude']),
    ], agentName).summary).toBe('Claude, Codex on 2 machines · Claude on c');
  });

  it('says it is checking while previews are pending, and nothing was delivered otherwise', () => {
    expect(summarizeMachines([entry('a', false, [], ['claude'])], agentName)).toEqual({ summary: 'Checking…', note: undefined });
    expect(summarizeMachines([entry('a', false)], agentName).summary).toBe('It isn’t on for any machine yet.');
  });
});
