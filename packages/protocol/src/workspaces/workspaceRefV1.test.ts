import { describe, expect, it } from 'vitest';

import { ProjectKeyV1Schema, WorkspaceRefV1Schema } from './workspaceRefV1.js';
import { matchSessionProjectFilterV1 } from '../sessions/listFilter/sessionListFilterV1.js';
import { resolveWorkspaceRefV1, enrichWorkspaceRefV1, projectWorkspaceRefV1, resolveSessionProjectKeyV1, createSessionProjectKeyResolverV1 } from './workspaceRefResolutionV1.js';

describe('workspaceRefV1', () => {
  it('resolves accepted Session Project identity without private refs and qualifies it by Home', () => {
    for (const serverId of ['a', 'b']) {
      expect(resolveSessionProjectKeyV1(null, serverId, undefined, { projectKey: 'anchor' }))
        .toEqual({ kind: 'resolved', projectKey: { serverId, projectKey: 'anchor' } });
    }
    expect(resolveSessionProjectKeyV1({ projectId: 'anchor' }, 'a', [])).toEqual({ kind: 'unavailable' });
    expect(resolveSessionProjectKeyV1({}, 'a')).toEqual({ kind: 'unavailable' });
    expect(resolveSessionProjectKeyV1({}, 'a', [])).toEqual({ kind: 'none' });
    expect(resolveSessionProjectKeyV1({}, 'a', [], { censusComplete: false })).toEqual({ kind: 'unavailable' });
  });

  it('uses a qualified explicit checkout regardless of subdirectory or sandbox machine, checking legacy Project markers', () => {
    const ref = { id: 'checkout', serverId: 'a', projectKey: 'anchor', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    const metadata = { workspaceId: 'checkout', projectId: 'anchor', machineId: 'sandbox', path: '/repo/child' };
    expect(resolveSessionProjectKeyV1(metadata, 'a', [ref]))
      .toEqual({ kind: 'resolved', projectKey: { serverId: 'a', projectKey: 'anchor' }, ref });
    expect(resolveSessionProjectKeyV1({ ...metadata, projectId: 'other' }, 'a', [ref])).toEqual({ kind: 'unavailable' });
    expect(resolveSessionProjectKeyV1(metadata, 'b', [ref])).toEqual({ kind: 'unavailable' });
    expect(resolveSessionProjectKeyV1(metadata, 'a', [ref, { ...ref, projectKey: 'other' }])).toEqual({ kind: 'unavailable' });
  });

  it('keeps keyless managed Chats outside private path inference while honoring an accepted public Project key', () => {
    const ref = { id: 'checkout', serverId: 'home', projectKey: 'anchor', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    const metadata = { workspaceId: 'checkout', machineId: 'machine', path: '/repo', sessionDirectoryV1: { v: 1, kind: 'managed' } };
    const resolve = createSessionProjectKeyResolverV1([ref]);
    expect(resolveSessionProjectKeyV1(metadata, 'home', [ref])).toEqual({ kind: 'none' });
    expect(resolve(metadata, 'home')).toEqual({ kind: 'none' });
    expect(resolve(metadata, 'home', 'published')).toEqual({ kind: 'resolved', projectKey: { serverId: 'home', projectKey: 'published' } });
    expect(matchSessionProjectFilterV1(metadata, 'home', { serverId: 'home', projectKey: 'anchor' }, [ref])).toBe('miss');
  });

  it('uses exact normalized host machinePath, never container paths or containment, for unmarked Sessions', () => {
    const ref = { id: 'checkout', serverId: 'a', projectKey: 'anchor', machineId: 'machine', rootPath: 'C:\\Work\\Repo', createdAtMs: 1 };
    const metadata = { machineId: 'machine', path: '/sandbox/repo', sessionWorkspaceLocationV1: {
      v: 1, machineId: 'machine', agentPath: '/sandbox/repo', machinePath: 'c:/work/repo/',
    } };
    expect(resolveSessionProjectKeyV1(metadata, 'a', [ref])).toMatchObject({ kind: 'resolved', ref });
    for (const path of ['c:/work/repo/child', 'c:/work/repo2']) {
      expect(resolveSessionProjectKeyV1({ machineId: 'machine', path }, 'a', [ref])).toEqual({ kind: 'none' });
    }
    expect(resolveSessionProjectKeyV1({ machineId: 'foreign', path: 'c:/work/repo' }, 'a', [ref])).toEqual({ kind: 'none' });
  });

  it('indexes one admitted census once so a thousand keyless rows do not scan unrelated refs', () => {
    let rootReads = 0;
    const refs = Array.from({ length: 1_000 }, (_, index) => ({ id: `checkout-${index}`, serverId: 'a',
      machineId: 'machine', get rootPath() { rootReads += 1; return `/repo-${index}`; }, createdAtMs: index }));
    const resolve = createSessionProjectKeyResolverV1(refs);
    rootReads = 0;
    for (let index = 0; index < 1_000; index += 1) {
      const metadata = { machineId: 'machine', path: `/repo-${index}` };
      expect(resolve(metadata, 'a'))
        .toMatchObject({ kind: 'resolved', projectKey: { serverId: 'a', projectKey: `checkout-${index}` } });
      expect(matchSessionProjectFilterV1(metadata, 'a', { serverId: 'a', projectKey: `checkout-${index}` }, refs,
        { sessionProjectKeyResolver: resolve })).toBe('match');
    }
    expect(rootReads).toBe(2_000);
    expect(resolve(null, 'b', 'published')).toEqual({ kind: 'resolved', projectKey: { serverId: 'b', projectKey: 'published' } });
  });
  it('resolves exact Home addresses and preserves ambiguity across Homes and duplicate scopes', () => {
    const refs = ['a', 'b'].map(serverId => ({ id: 'same', serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }));
    expect(resolveWorkspaceRefV1(refs, { id: 'same' })).toEqual({ kind: 'ambiguous', candidates: refs });
    expect(resolveWorkspaceRefV1(refs, { serverId: 'b', workspaceId: 'same', machineId: 'machine', rootPath: '/repo/' })).toEqual({ kind: 'resolved', ref: refs[1] });
    expect(resolveWorkspaceRefV1(refs, { serverId: 'b', workspaceId: 'same', machineId: 'machine', rootPath: '/other' }).kind).toBe('missing');
    const duplicate = { ...refs[0]!, id: 'other' };
    expect(resolveWorkspaceRefV1([...refs, duplicate], { serverId: 'a', machineId: 'machine', rootPath: '/repo' })).toEqual({ kind: 'ambiguous', candidates: [refs[0], duplicate] });
    expect(resolveWorkspaceRefV1(refs, { serverId: 'a', projectKey: 'same' }).kind).toBe('invalid');
  });

  it('compares mixed Windows paths exactly without aliasing sibling homes or folding POSIX case', () => {
    const ref = { id: 'ref', serverId: 'home', machineId: 'machine', rootPath: 'C:\\Users\\alice\\Repo\\', createdAtMs: 1 };
    expect(resolveWorkspaceRefV1([ref], { serverId: 'home', machineId: 'machine', rootPath: 'c:/users/alice/repo' }).kind).toBe('resolved');
    expect(resolveWorkspaceRefV1([ref], { serverId: 'home', machineId: 'machine', rootPath: 'C:/Users/alice2/Repo' }).kind).toBe('missing');
    expect(resolveWorkspaceRefV1([{ ...ref, rootPath: 'C:\\' }], { serverId: 'home', machineId: 'machine', rootPath: 'c:/' }).kind).toBe('resolved');
    expect(resolveWorkspaceRefV1([{ ...ref, rootPath: '/Repo' }], { serverId: 'home', machineId: 'machine', rootPath: '/repo' }).kind).toBe('missing');
  });

  it('retains fallback anchors through enrichment and Source provenance', () => {
    const ref = { id: 'anchor', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    const enriched = enrichWorkspaceRefV1(ref, { source: { sourceId: 'source', revision: 1 } });
    expect(projectWorkspaceRefV1(enriched)).toEqual(projectWorkspaceRefV1(ref));
    expect(projectWorkspaceRefV1(enrichWorkspaceRefV1({ ...ref, projectKey: 'existing' }, { projectKey: 'replacement' }))).toEqual({ serverId: 'home', projectKey: 'existing' });
  });
  it('parses WorkspaceRefV1 as a forward-compatible workspace reference', () => {
    const parsed = WorkspaceRefV1Schema.parse({
      id: 'workspace_1',
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
      label: 'Repo',
      createdAtMs: 1,
      lastOpenedAtMs: null,
      futureField: { keep: true },
    });
    expect(parsed).not.toHaveProperty('futureField');

    expect(parsed).toMatchObject({
      id: 'workspace_1',
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
      label: 'Repo',
      createdAtMs: 1,
      lastOpenedAtMs: null,
    });
  });

  it('preserves stored workspace reference string fields without normalization', () => {
    const parsed = WorkspaceRefV1Schema.parse({
      id: ' workspace_1 ',
      serverId: ' server_1 ',
      machineId: ' machine_1 ',
      rootPath: ' /repo with spaces ',
      label: ' Repo ',
      createdAtMs: 1,
      lastOpenedAtMs: null,
    });

    expect(parsed).toMatchObject({
      id: ' workspace_1 ',
      serverId: ' server_1 ',
      machineId: ' machine_1 ',
      rootPath: ' /repo with spaces ',
      label: ' Repo ',
    });
  });

  it('accepts only id or scope tuple project lookup keys', () => {
    expect(ProjectKeyV1Schema.parse({ id: 'workspace_1' })).toEqual({ id: 'workspace_1' });
    expect(ProjectKeyV1Schema.parse({
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
    })).toEqual({
      serverId: 'server_1',
      machineId: 'machine_1',
      rootPath: '/repo',
    });
    expect(ProjectKeyV1Schema.safeParse({ serverId: 'server_1', machineId: 'machine_1' }).success).toBe(false);
  });

  it('admits a Home-qualified presentation anchor separately from an exact checkout', () => {
    expect(ProjectKeyV1Schema.safeParse({ serverId: 'home', projectKey: 'anchor' }).success).toBe(true);
    expect(ProjectKeyV1Schema.safeParse({ serverId: 'home', id: 'checkout' }).success).toBe(true);
    expect(ProjectKeyV1Schema.safeParse({ projectKey: 'anchor' }).success).toBe(false);
  });

  it('drops unknown stored facts recursively while refusing malformed known identity', () => {
    const ref = { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
      projectKey: 'anchor', repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo', extra: true },
      source: { sourceId: 'source', revision: 2, extra: true }, extra: true };
    const { extra: _extra, ...known } = ref;
    expect(WorkspaceRefV1Schema.parse(ref)).toEqual({ ...known,
      repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' },
      source: { sourceId: 'source', revision: 2 } });
    expect(WorkspaceRefV1Schema.safeParse({ ...ref, source: { sourceId: 'source', revision: -1 } }).success).toBe(false);
  });
});
