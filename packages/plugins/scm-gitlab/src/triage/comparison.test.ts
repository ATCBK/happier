import { describe, expect, it } from 'vitest';
import { readPullRequestComparison } from '../../../../../apps/cli/src/scm/comparisons/readPullRequestComparisonPage';
import { getGitlabSourceEntryAction } from './operations.js';
import { listGitlabChanges } from './detailOperations.js';
import { GitlabChangesResultV1Schema } from './detail/contracts.js';
import {
  createStubGitlabTransport, gitlabTestConfiguredInstance, gitlabNextLinkHeader,
  GITLAB_TEST_COLLISION_SCOPE, GITLAB_TEST_ORIGIN,
  type RecordedGitlabRequest, type StubGitlabResponse,
} from './testkit/gitlabTriage.test-support.js';

const repository = 'group/subgroup/project';
const localRef = { kindId: 'merge-request', collisionScope: GITLAB_TEST_COLLISION_SCOPE, entryId: '7' };
const input = { v: 1, instance: gitlabTestConfiguredInstance(), localRef, routingToken: repository, limit: 1, comparison: true };
const beforeOid = 'a'.repeat(40), baseOid = 'b'.repeat(40), headOid = 'c'.repeat(40);
const metadata = { id: 700, project_id: 3, iid: 7, references: { full: `${repository}!7` },
  title: 'Change behavior', state: 'opened', sha: headOid, changes_count: '2',
  diff_refs: { base_sha: beforeOid, start_sha: baseOid, head_sha: headOid } };
const patch = '@@ -1 +1 @@\n-old\n+new\n';
const file = (path: string, overrides: Record<string, unknown> = {}) => ({ old_path: path, new_path: path,
  new_file: false, renamed_file: false, deleted_file: false, collapsed: false, too_large: false, diff: patch, ...overrides });
const ok = (body: unknown, headers = {}): StubGitlabResponse => ({ status: 200, headers, body });
const nextUrl = `${GITLAB_TEST_ORIGIN}/api/v4/projects/${encodeURIComponent(repository)}/merge_requests/7/diffs?page=2&per_page=1`;

function transport(options: { metadata?: (read: number) => unknown; page?: (request: RecordedGitlabRequest) => StubGitlabResponse } = {}) {
  let read = 0;
  return createStubGitlabTransport({ respond: request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/merge_requests/7')) return ok(options.metadata?.(++read) ?? metadata);
    if (url.pathname.endsWith('/user')) return ok({ id: 41, username: 'viewer' });
    if (url.pathname.endsWith('/diffs')) return options.page?.(request) ?? (url.searchParams.get('page') === '2'
      ? ok([file('second.ts')]) : ok([file('first.ts')], gitlabNextLinkHeader(nextUrl)));
    return undefined;
  } });
}

describe('merge request comparison evidence', () => {
  it('opens the shared host comparison through the source Get and paged Changes Actions', async () => {
    const stub = transport();
    const entry = await getGitlabSourceEntryAction({ v: 1, instance: input.instance, localRef,
      lastKnownLocator: { v: 1, routingToken: repository } }, stub.context);
    expect(entry.kind).toBe('present');
    if (entry.kind !== 'present' || entry.comparisonSource?.kind !== 'pullRequest') throw new Error('comparison source missing');
    const source = entry.comparisonSource;
    expect(source.locator).toMatchObject({ providerId: 'gitlab', repository, number: 7, baseOid, headOid });
    const captured = await readPullRequestComparison({ source, readPage: async ({ sourceAction, continuation }) => {
      const result = await listGitlabChanges({ ...sourceAction.input, limit: 1, ...(continuation ? { continuation } : {}) }, stub.context);
      return GitlabChangesResultV1Schema.parse(result);
    } });
    expect(captured).toMatchObject({ state: 'complete', freshness: 'current', before: beforeOid, after: headOid });
    expect(captured.files.map(row => row.path)).toEqual(['first.ts', 'second.ts']);
    expect(captured.files[1]?.unifiedDiff).toContain(patch);
  });

  it.each(['base_sha', 'start_sha', 'head_sha'] as const)('refuses a changed %s without mixing pages', async endpoint => {
    const stub = transport({ metadata: read => read > 2
      ? { ...metadata, ...(endpoint === 'head_sha' ? { sha: 'd'.repeat(40) } : {}),
        diff_refs: { ...metadata.diff_refs, [endpoint]: 'd'.repeat(40) } } : metadata });
    const first = await listGitlabChanges(input, stub.context);
    expect(first.kind).toBe('changedFiles');
    if (first.kind !== 'changedFiles') throw new Error('comparison missing');
    const next = await listGitlabChanges({ ...input, continuation: first.continuation }, stub.context);
    expect(next).toMatchObject({ kind: 'changedFiles', rows: [], comparison: { freshness: 'stale', inventory: 'incomplete' } });
  });

  it('detects a head change during a single page read', async () => {
    const stub = transport({ metadata: read => read > 1 ? { ...metadata, sha: 'd'.repeat(40),
      diff_refs: { ...metadata.diff_refs, head_sha: 'd'.repeat(40) } } : metadata });
    expect(await listGitlabChanges(input, stub.context)).toMatchObject({ kind: 'changedFiles',
      comparison: { freshness: 'stale', inventory: 'incomplete' } });
  });

  it.each([
    { flags: { diff: undefined }, state: 'unavailable' },
    { flags: { diff: '' }, state: 'unavailable' },
    { flags: { collapsed: true }, state: 'truncated' },
    { flags: { too_large: true }, state: 'truncated' },
    { flags: { collapsed: undefined, too_large: undefined }, state: 'truncated' },
  ])('keeps a file with unavailable or unproven patch evidence: %j', async ({ flags, state }) => {
    const stub = transport({ metadata: () => ({ ...metadata, changes_count: '1' }), page: () => ok([file('retained.ts', flags)]) });
    const result = GitlabChangesResultV1Schema.parse(await listGitlabChanges(input, stub.context));
    expect(result).toMatchObject({ kind: 'changedFiles', rows: [{ path: 'retained.ts', evidence: { state } }],
      comparison: { inventory: 'complete', content: 'incomplete' } });
  });

  it('preserves exact paths and cannot follow a continuation into another resource', async () => {
    const path = 'space\tand\nnewline.ts';
    const stub = transport({ page: () => ok([file(path)], gitlabNextLinkHeader(
      `${GITLAB_TEST_ORIGIN}/api/v4/projects/other/merge_requests/7/diffs?page=2&per_page=1`)) });
    expect(await listGitlabChanges(input, stub.context)).toMatchObject({ kind: 'changedFiles',
      rows: [{ path }], incomplete: 'pagination', comparison: { inventory: 'incomplete' } });
  });

  it('retains all rows but never calls a capped provider count complete', async () => {
    const stub = transport({ metadata: () => ({ ...metadata, changes_count: '1000+' }), page: () => ok([file('retained.ts')]) });
    expect(await listGitlabChanges(input, stub.context)).toMatchObject({ kind: 'changedFiles', rows: [{ path: 'retained.ts' }],
      comparison: { totalFileCount: null, inventory: 'incomplete', reasons: expect.arrayContaining(['file_count_unavailable']) } });
  });

  it('does not claim clean evidence when the provider stops before the reported file count', async () => {
    const stub = transport({ page: () => ok([file('retained.ts')]) });
    expect(await listGitlabChanges(input, stub.context)).toMatchObject({ kind: 'changedFiles',
      comparison: { inventory: 'incomplete', reasons: expect.arrayContaining(['file_count_mismatch']) } });
  });

  it('refuses an unpopulated or internally inconsistent endpoint tuple', async () => {
    for (const diff_refs of [{}, { ...metadata.diff_refs, head_sha: 'd'.repeat(40) }]) {
      const stub = transport({ metadata: () => ({ ...metadata, diff_refs }) });
      expect(await listGitlabChanges(input, stub.context)).toMatchObject({ kind: 'unavailable' });
      expect(stub.requests.some(request => new URL(request.url).pathname.endsWith('/diffs'))).toBe(false);
    }
  });

  it('keeps the existing display Changes contract when evidence was not requested', async () => {
    const stub = transport();
    const { comparison: _comparison, ...displayInput } = input;
    expect(GitlabChangesResultV1Schema.parse(await listGitlabChanges(displayInput, stub.context)))
      .toMatchObject({ kind: 'changes', rows: [{ path: 'first.ts' }] });
    expect(stub.requests.some(request => new URL(request.url).pathname.endsWith('/merge_requests/7'))).toBe(false);
  });

  it('keeps the first page readable when a later page is rate limited', async () => {
    const stub = transport({ page: request => new URL(request.url).searchParams.get('page') === '2'
      ? { status: 429, headers: { 'retry-after': '60' } } : ok([file('first.ts')], gitlabNextLinkHeader(nextUrl)) });
    const first = await listGitlabChanges(input, stub.context);
    if (first.kind !== 'changedFiles') throw new Error('comparison missing');
    expect(await listGitlabChanges({ ...input, continuation: first.continuation }, stub.context)).toMatchObject({
      kind: 'changedFiles', rows: [], comparison: { inventory: 'incomplete', content: 'incomplete', failure: { class: 'rateLimit' } },
    });
  });
});
