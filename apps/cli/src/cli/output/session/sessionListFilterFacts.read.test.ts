import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchSessionListFilterV1, normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createPlainProjectAccountRefRow } from '@/workspaces/projectAccountRows.testkit';
import { readCliSessionListFilterFactsV1 } from './sessionListFilterFacts';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

const token = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
const bob = { token: token('bob'), encryption: null };
const alice = { token: token('alice'), encryption: null };
const ref = { id: 'checkout', serverId: 'home', machineId: 'alice-machine', rootPath: '/work/project', createdAtMs: 1 };
const row = createSessionRecordFixture({ id: 'source', encryptionMode: 'plain', ownerAccountId: 'bob', origin: { kind: 'none' },
  metadata: JSON.stringify({ workspaceId: ref.id, machineId: ref.machineId, path: ref.rootPath }),
  effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
    capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
const project = (projectKey: string) => normalizeSessionListFilterV1({ homeServerIds: ['home'],
  projects: { include: [{ serverId: 'home', projectKey }], exclude: [] } });
const tag = (tagId: string) => normalizeSessionListFilterV1({ homeServerIds: ['home'], tagIds: [{ serverId: 'home', tagId }] });
const all = normalizeSessionListFilterV1({ homeServerIds: ['home'], startedBy: ['you', 'agents', 'triggers'] });
afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });

function boundary(serverId = ref.serverId, extraRows: readonly ReturnType<typeof createPlainProjectAccountRefRow>[] = []) {
  const state = { projectKey: 'bob-project', tagIds: ['bob-tag'], folderId: 'section-a' as string | null, unavailable: false };
  // Only Account HTTP is substituted; row admission, snapshots and matching stay real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } } as never;
    expect(url).toMatch(/^https:\/\/bob-home\.test\/v2\/session-organization\?/);
    expect(config?.headers?.Authorization).toBe(`Bearer ${bob.token}`);
    if (state.unavailable) return { status: 503, data: { error: 'unavailable' } } as never;
    return { status: 200, data: { snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: state.folderId ? [{ sessionId: row.id, folderId: state.folderId }] : [],
      tags: [], tagAssignments: [{ sessionId: row.id, tagIds: state.tagIds }], orderEntries: [], labels: [] } } } as never;
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, _body, config) => {
    expect(url).toMatch(/\/v1\/account\/project-rows\/list$/);
    if (state.unavailable) return { status: 403, data: { error: 'forbidden' } } as never;
    const projectKey = config?.headers?.Authorization === `Bearer ${alice.token}` ? 'alice-project' : state.projectKey;
    return { status: 200, data: { status: 'listed', coverage: 'complete',
      rows: [createPlainProjectAccountRefRow({ ...ref, serverId, projectKey }), ...extraRows] } } as never;
  });
  return { state, get, post };
}
function input(filters = [project('bob-project'), tag('bob-tag')]) {
  return { credentials: bob, accountEncryption: createAccountEncryptionCurrentnessFixture(), row, nowMs: Date.now(),
    serverId: 'home', accountId: 'bob', serverHttpBaseUrl: 'https://bob-home.test', signal: new AbortController().signal,
    isCurrent: async () => true, filters };
}

describe('captured Account current filter facts', () => {
  it('uses the published Project relationship with zero private Project reads even when owner metadata is unavailable', async () => {
    const { get, post } = boundary();
    const facts = await readCliSessionListFilterFactsV1({ ...input([project('bob-project')]),
      row: { ...row, projectKey: 'bob-project', metadata: 'unavailable' } });
    expect(matchSessionListFilterV1(project('bob-project'), facts!)).toBe('match');
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
  it('reads Section-only demand from one existing placement batch, preserving missing versus known-empty', async () => {
    const { state, get, post } = boundary();
    const section = normalizeSessionListFilterV1({ ...all, sections: { include: [{ serverId: 'home', sectionId: 'section-a' }], exclude: [] } });
    const facts = await readCliSessionListFilterFactsV1(input([section]));
    expect(facts?.section).toEqual({ serverId: 'home', sectionId: 'section-a' });
    expect(matchSessionListFilterV1(section, facts!, 'daemonRule')).toBe('match');
    expect(get.mock.calls.filter(([url]) => new URL(url).pathname === '/v2/session-organization')).toHaveLength(1);
    expect(post).not.toHaveBeenCalled();
    state.folderId = null;
    const empty = await readCliSessionListFilterFactsV1(input([section]));
    expect(empty?.section).toBeNull();
    expect(matchSessionListFilterV1(section, empty!, 'daemonRule')).toBe('miss');
    state.unavailable = true;
    const unavailable = await readCliSessionListFilterFactsV1(input([section]));
    expect(unavailable?.section).toBeUndefined();
    expect(matchSessionListFilterV1(section, unavailable!, 'daemonRule')).toBe('unavailable');
  });
  it('does not read supplemental Project or tag facts for predicates already excluded by known Session facts', async () => {
    const { get, post } = boundary();
    const excluded = normalizeSessionListFilterV1({ ...project('bob-project'), show: 'runs',
      tagIds: [{ serverId: 'home', tagId: 'bob-tag' }] });
    const facts = await readCliSessionListFilterFactsV1(input([excluded]));
    expect(facts).not.toBeNull();
    expect(matchSessionListFilterV1(excluded, facts!)).toBe('miss');
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  it('still reads current supplemental facts for eligible predicates alongside known misses', async () => {
    const { get, post } = boundary();
    const excluded = normalizeSessionListFilterV1({ ...tag('bob-tag'), show: 'runs' });
    const eligible = project('bob-project');
    const facts = await readCliSessionListFilterFactsV1(input([excluded, eligible]));
    expect(matchSessionListFilterV1(excluded, facts!)).toBe('miss');
    expect(matchSessionListFilterV1(eligible, facts!)).toBe('match');
    expect(post).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/v1/account/encryption']);
  });
  it.each(['portable', 'local'] as const)('reads portable Project and tag facts from a captured local Home profile (%s filter)', async qualifier => {
    await withConfiguredDaemonTestHome({ prefix: 'follow-facts-portable-home-' }, async () => {
      const profileId = 'stack_agent-qa-coord-n1__id_default';
      const homeId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
      await seedTestServerProfile({ id: profileId, homeId, serverUrl: 'https://bob-home.test' });
      boundary(homeId, [createPlainProjectAccountRefRow({ ...ref, serverId: profileId, projectKey: 'old-local-project' })]);
      const filterHome = qualifier === 'local' ? profileId : homeId;
      const projectFilter = normalizeSessionListFilterV1({ homeServerIds: [filterHome],
        projects: { include: [{ serverId: filterHome, projectKey: 'bob-project' }], exclude: [] } });
      const tagFilter = normalizeSessionListFilterV1({ homeServerIds: [filterHome], tagIds: [{ serverId: filterHome, tagId: 'bob-tag' }] });
      const facts = await readCliSessionListFilterFactsV1({ ...input([projectFilter, tagFilter]), serverId: profileId });
      expect(facts?.serverId).toBe(homeId);
      expect(matchSessionListFilterV1(projectFilter, facts!)).toBe('match');
      expect(matchSessionListFilterV1(tagFilter, facts!)).toBe('match');
      expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
    });
  });
  it('reads Bob current Project and tags without borrowing or publishing Alice installed rows, then observes moves', async () => {
    const { state } = boundary();
    const installed = await readProjectAccountRows({ credentials: alice, serverId: 'home', publication: 'installed' });
    const facts = await readCliSessionListFilterFactsV1(input());
    expect(facts).not.toBeNull();
    expect(matchSessionListFilterV1(project('bob-project'), facts!)).toBe('match');
    expect(matchSessionListFilterV1(tag('bob-tag'), facts!)).toBe('match');
    expect(matchSessionListFilterV1(project('alice-project'), facts!)).toBe('miss');
    expect(getActiveProjectAccountRowsSnapshot()).toBe(installed);
    state.projectKey = 'moved-project';
    state.tagIds = ['new-tag'];
    const moved = await readCliSessionListFilterFactsV1(input());
    expect(matchSessionListFilterV1(project('bob-project'), moved!)).toBe('miss');
    expect(matchSessionListFilterV1(project('moved-project'), moved!)).toBe('match');
    expect(matchSessionListFilterV1(tag('bob-tag'), moved!)).toBe('miss');
    expect(matchSessionListFilterV1(tag('new-tag'), moved!)).toBe('match');
  });
  it('keeps denied supplemental facts unavailable without suppressing unrelated predicates or borrowing installed rows', async () => {
    const { state } = boundary();
    const installed = await readProjectAccountRows({ credentials: alice, serverId: 'home', publication: 'installed' });
    state.unavailable = true;
    const facts = await readCliSessionListFilterFactsV1(input());
    expect(matchSessionListFilterV1(project('bob-project'), facts!)).toBe('unavailable');
    expect(matchSessionListFilterV1(tag('bob-tag'), facts!)).toBe('unavailable');
    expect(matchSessionListFilterV1(all, facts!)).toBe('match');
    expect(getActiveProjectAccountRowsSnapshot()).toBe(installed);
  });
  it('distinguishes a complete empty tag assignment from unavailable and performs no supplemental read without demand', async () => {
    const { state, get, post } = boundary();
    state.tagIds = [];
    const facts = await readCliSessionListFilterFactsV1(input([tag('bob-tag')]));
    expect(facts?.tagIds).toEqual([]);
    expect(matchSessionListFilterV1(tag('bob-tag'), facts!)).toBe('miss');
    get.mockClear(); post.mockClear();
    expect(await readCliSessionListFilterFactsV1(input([all]))).not.toBeNull();
    expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it('does not accept another Account credential or a scope retired during private reads', async () => {
    const { get, post } = boundary();
    expect(await readCliSessionListFilterFactsV1({ ...input(), credentials: alice })).toBeNull();
    expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    let current = true;
    const implementation = post.getMockImplementation()!;
    post.mockImplementation(async (...args) => { const result = await implementation(...args); current = false; return result; });
    expect(await readCliSessionListFilterFactsV1({ ...input(), isCurrent: async () => current })).toBeNull();
  });
});
