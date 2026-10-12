import { expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { TrackedSession } from '@/daemon/types';
import { isAgentInstallTargetInUse } from './managedAgentInstalls';

it('uses tracked definition identity across admitted and adopted sessions while keeping neighboring definitions independent', () => {
  const target = { agentId: 'custom-acp', definitionId: 'alpha' };
  const selected: TrackedSession = { pid: process.pid, startedBy: 'daemon', spawnOptions: { directory: tmpdir(),
    agentTarget: { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'alpha' } } };
  expect(isAgentInstallTargetInUse(target, [selected])).toBe(true);
  expect(isAgentInstallTargetInUse({ ...target, definitionId: 'beta' }, [selected])).toBe(false);
  const adopted: TrackedSession = { pid: process.pid, startedBy: 'terminal', spawnOptions: { directory: tmpdir(),
    runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: { definitionId: 'alpha' } } } };
  expect(isAgentInstallTargetInUse(target, [adopted])).toBe(true);
  const unknownDefinition: TrackedSession = { pid: process.pid, startedBy: 'daemon', spawnOptions: { directory: tmpdir(),
    runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: {} } } };
  expect(isAgentInstallTargetInUse(target, [unknownDefinition])).toBe(true);
  const otherAgent: TrackedSession = { pid: process.pid, startedBy: 'daemon', spawnOptions: { directory: tmpdir(),
    runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } } };
  expect(isAgentInstallTargetInUse(target, [otherAgent])).toBe(false);
});
