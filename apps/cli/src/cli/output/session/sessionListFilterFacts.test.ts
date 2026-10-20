import { describe, expect, it } from 'vitest';
import { matchSessionListFilterV1, normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { projectCliSessionListFilterFactsV1 } from './sessionListFilterFacts';

const credentials = { token: 'bob-token', encryption: null };
const workspaceRef = { id: 'checkout', serverId: 'home', machineId: 'alice-machine', rootPath: '/work/project',
  projectKey: 'current-project', createdAtMs: 1 };
const row = createSessionRecordFixture({ id: 'source', encryptionMode: 'plain', ownerAccountId: 'bob', origin: { kind: 'none' },
  metadata: JSON.stringify({ workspaceId: 'checkout', machineId: 'alice-machine', path: '/work/project' }),
  effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
    capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
const projectFilter = normalizeSessionListFilterV1({ homeServerIds: ['home'],
  projects: { include: [{ serverId: 'home', projectKey: 'current-project' }], exclude: [] } });
const tagFilter = normalizeSessionListFilterV1({ homeServerIds: ['home'], tagIds: [{ serverId: 'home', tagId: 'bob-tag' }] });

describe('current CLI Session filter facts', () => {
  it('uses prepared current Project and tag assignments in the shared list/preview/evaluator projector', () => {
    const input = { credentials, accountEncryption: createAccountEncryptionCurrentnessFixture(), row,
      nowMs: Date.now(), serverId: 'home', viewerAccountId: 'bob',
      preparedFacts: { workspaceRefs: [workspaceRef], tagIds: ['bob-tag'] } };
    const facts = projectCliSessionListFilterFactsV1(input);
    expect(matchSessionListFilterV1(projectFilter, facts)).toBe('match');
    expect(matchSessionListFilterV1(tagFilter, facts)).toBe('match');
    expect(facts.tagIds).toEqual(['bob-tag']);
  });
});
