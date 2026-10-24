import { decodeGithubJsonResponse } from '../observations/githubApiClient.js';
import { GITHUB_API_ORIGIN } from '../observations/githubProviderContracts.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure } from './errors.js';
import { readGithubCheckOutcomeV1 } from './checkOutcome.js';
import { projectGithubChecksSurface, type GithubCheckObservationV1, type GithubChecksDependenciesV1, type GithubChecksSurfaceV1 } from './checks.js';
import type { GithubRepositoryRouteV1 } from './locator.js';
import type { GithubResponseFailureV1 } from '../observations/githubResponseFailure.js';
import { decodeGithubReviewDecision } from './feedback.js';
import type { GithubReviewDecisionV1 } from './mapping/facts.js';

export type GithubChecksConditionSnapshotV1 = Readonly<{
  pullRequestNumber: number;
  headSha: string;
  currentHeadSha: string | null;
  selection: 'all' | 'required';
  state: 'passed' | 'failed' | 'pending' | 'neutral' | 'none' | 'unknown' | 'superseded';
  complete: boolean;
  passed: boolean;
  failure?: GithubResponseFailureV1;
}>;

// GitHub GraphQL Checks/Commits schema, checked 2026-10-02. Both concrete
// context types expose isRequired(pullRequestNumber:). 100 is GitHub's page
// maximum, not a suite-size cap; traverse the entire connection.
const query = `query Checks($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    headRefOid reviewDecision commits(last: 1) { nodes { commit { oid statusCheckRollup {
      contexts(first: 100, after: $cursor) { nodes {
        __typename
        ... on CheckRun { id name status conclusion detailsUrl startedAt completedAt checkSuite { createdAt } isRequired(pullRequestNumber: $number) }
        ... on StatusContext { id context state targetUrl createdAt updatedAt isRequired(pullRequestNumber: $number) }
      } pageInfo { hasNextPage endCursor } }
    } } } }
  } }
}`;
function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}
function time(value: unknown): number | null {
  const epoch = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(epoch) ? epoch : null;
}
function decode(raw: unknown): Readonly<{ required: boolean; row: GithubCheckObservationV1 }> | null {
  const node = record(raw);
  if (!node || typeof node.id !== 'string' || !node.id || typeof node.isRequired !== 'boolean') return null;
  if (node.__typename === 'CheckRun' && typeof node.name === 'string' && typeof node.status === 'string'
    && (node.conclusion === null || typeof node.conclusion === 'string')) {
    const startedAtMs = time(node.startedAt);
    const completedAtMs = time(node.completedAt);
    const checkSuiteCreatedAtMs = time(record(node.checkSuite)?.createdAt);
    // Run times are nullable; the suite creation time is non-null in GitHub's
    // schema. A malformed fallback makes the canonical surface unknown.
    if (startedAtMs === null && completedAtMs === null && checkSuiteCreatedAtMs === null) return null;
    return { required: node.isRequired, row: {
      key: `github-check-run:${node.id}`, resourceKind: 'check-run', name: node.name,
      status: node.status.toLowerCase(), conclusion: node.conclusion?.toLowerCase() ?? null,
      detailsUrl: typeof node.detailsUrl === 'string' ? node.detailsUrl : null,
      startedAtMs, completedAtMs,
      ...(checkSuiteCreatedAtMs === null ? {} : { checkSuiteCreatedAtMs }),
    } };
  }
  if (node.__typename === 'StatusContext' && typeof node.context === 'string' && typeof node.state === 'string') {
    const state = node.state.toLowerCase();
    const pending = state === 'pending' || state === 'expected';
    return { required: node.isRequired, row: {
      key: `github-commit-status:${node.id}`, resourceKind: 'commit-status', name: node.context,
      status: pending ? 'in_progress' : 'completed',
      conclusion: pending ? null : state === 'success' ? 'success'
        : state === 'failure' || state === 'error' ? 'failure' : null,
      detailsUrl: typeof node.targetUrl === 'string' ? node.targetUrl : null,
      startedAtMs: time(node.createdAt), completedAtMs: pending ? null : time(node.updatedAt),
    } };
  }
  return null;
}

/** Current PR rollup, distinct from the detail reader's historical REST rows. */
export async function readGithubChecksConditionSurface(
  input: Readonly<{ route: GithubRepositoryRouteV1; headSha: string;
    observation: Readonly<{ pullRequestNumber: number; selection: 'all' | 'required' }> }>,
  dependencies: GithubChecksDependenciesV1,
): Promise<GithubChecksSurfaceV1> {
  const rows: GithubCheckObservationV1[] = [];
  let currentHeadSha: string | null = null;
  let reviewDecision: GithubReviewDecisionV1 | null = null;
  const finish = (state?: GithubChecksConditionSnapshotV1['state'], failure: GithubChecksSurfaceV1['checkRunsFailure'] = null) => {
    const surface = projectGithubChecksSurface({
      checkRuns: { observations: rows, totalCount: rows.length, truncated: false, failure },
      commitStatuses: { observations: [], totalCount: 0, truncated: false, failure: null },
    });
    const outcomes = rows.map(readGithubCheckOutcomeV1);
    const selectedState = state ?? (rows.length === 0 ? 'none' : outcomes.includes('unknown') ? 'unknown'
      : outcomes.includes('failed') ? 'failed' : outcomes.includes('pending') ? 'pending'
        : outcomes.every((outcome) => outcome === 'passed') ? 'passed' : 'neutral');
    const complete = !['none', 'unknown', 'superseded'].includes(selectedState) && !outcomes.includes('pending');
    return { ...surface, reviewDecision: selectedState === 'superseded' ? null : reviewDecision, observation: {
      ...input.observation, headSha: input.headSha, currentHeadSha,
      state: selectedState, complete, passed: selectedState === 'passed',
      ...(failure ? { failure } : {}),
    } } satisfies GithubChecksSurfaceV1;
  };
  let cursor: string | null = null;
  const seen = new Set<string>();
  const seenRows = new Set<string>();
  while (true) {
    dependencies.signal.throwIfAborted();
    let response: Awaited<ReturnType<GithubChecksDependenciesV1['client']['request']>>;
    try {
      response = await dependencies.client.request({ url: `${GITHUB_API_ORIGIN}/graphql`, method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ query,
          variables: { owner: input.route.owner, name: input.route.name, number: input.observation.pullRequestNumber, cursor },
        })) });
    } catch (error) {
      dependencies.signal.throwIfAborted();
      return finish('unknown', classifyGithubTransportFailure(error));
    }
    dependencies.signal.throwIfAborted();
    if (response.status !== 200) return finish('unknown', classifyGithubResponseFailure(response, dependencies.now()));
    let body: Readonly<Record<string, unknown>> | null;
    try { body = record(decodeGithubJsonResponse(response)); }
    catch (error) { return finish('unknown', classifyGithubTransportFailure(error)); }
    if (!body || body.errors !== undefined) return finish('unknown');
    const pr = record(record(record(body.data)?.repository)?.pullRequest);
    if (!pr || typeof pr.headRefOid !== 'string') return finish('unknown');
    currentHeadSha = pr.headRefOid;
    if (currentHeadSha !== input.headSha) return finish('superseded');
    reviewDecision = decodeGithubReviewDecision(pr.reviewDecision) ?? null;
    const commits = record(pr.commits);
    const commit = record(record(Array.isArray(commits?.nodes) ? commits.nodes[0] : null)?.commit);
    if (!commit || commit.oid !== input.headSha) return finish('unknown');
    if (commit.statusCheckRollup === null) return finish(cursor === null ? 'none' : 'unknown');
    const contexts = record(record(commit.statusCheckRollup)?.contexts);
    const pageInfo = record(contexts?.pageInfo);
    if (!contexts || !Array.isArray(contexts.nodes) || !pageInfo || typeof pageInfo.hasNextPage !== 'boolean') return finish('unknown');
    for (const raw of contexts.nodes) {
      const decoded = decode(raw);
      if (!decoded || seenRows.has(decoded.row.key)) return finish('unknown');
      seenRows.add(decoded.row.key);
      if (input.observation.selection === 'all' || decoded.required) rows.push(decoded.row);
    }
    if (!pageInfo.hasNextPage) return finish();
    if (typeof pageInfo.endCursor !== 'string' || !pageInfo.endCursor || seen.has(pageInfo.endCursor)) return finish('unknown');
    cursor = pageInfo.endCursor;
    seen.add(cursor);
  }
}
