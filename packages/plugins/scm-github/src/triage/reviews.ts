import {
  decodeGithubJsonResponse,
  type GithubApiClientV1,
} from '../observations/githubApiClient.js';

import {
  classifyGithubResponseFailure,
  classifyGithubTransportFailure,
  isGithubSuccessStatus,
} from './errors.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from './locator.js';
import { readValidatedGithubFollowUpPage } from './scan/link.js';
import {
  GITHUB_MAX_PAGE_SIZE_V1,
  type GithubTriageFailureV1,
} from './types.js';

/**
 * The retained REST walks used only to reconcile publication markers.
 *
 * Live review history, review requests and review-decision presentation come
 * from the Feedback GraphQL connections. These narrower walks remain because
 * publication reconciliation needs every raw marker-bearing body and immutable
 * provider id, including records whose author or future state the live detail
 * projector cannot otherwise understand.
 */

export type GithubReviewsDependenciesV1 = Readonly<{
  client: GithubApiClientV1;
  now: () => number;
  signal: AbortSignal;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readProviderId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return readTrimmedString(value);
}

async function readPaginated<T, TPageRow = unknown>(
  dependencies: GithubReviewsDependenciesV1,
  input: Readonly<{
    initialUrl: string;
    repositoryId?: string | null;
    readPage: (body: unknown) => readonly TPageRow[] | null;
    decodeRow: (raw: TPageRow) => T | null;
  }>,
): Promise<Readonly<{
  rows: readonly T[];
  failure: GithubTriageFailureV1 | null;
  incomplete: boolean;
}>> {
  const rows: T[] = [];
  let url: string | null = input.initialUrl;
  const visitedUrls = new Set<string>();

  while (url !== null) {
    if (dependencies.signal.aborted) {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: Object.freeze({ class: 'transient', code: 'github_request_cancelled' }),
        incomplete: false,
      });
    }
    if (visitedUrls.has(url)) {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: Object.freeze({
          class: 'unsupportedContract',
          code: 'github_reviews_link_invalid',
        }),
        incomplete: false,
      });
    }
    visitedUrls.add(url);
    const requestedUrl: string = url;
    let response;
    try {
      response = await dependencies.client.request({ url: requestedUrl });
    } catch (error) {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: classifyGithubTransportFailure(error),
        incomplete: false,
      });
    }
    if (!isGithubSuccessStatus(response.status)) {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: classifyGithubResponseFailure(response, dependencies.now()),
        incomplete: false,
      });
    }
    let page: readonly TPageRow[] | null;
    try {
      page = input.readPage(decodeGithubJsonResponse(response));
    } catch (error) {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: classifyGithubTransportFailure(error),
        incomplete: false,
      });
    }
    if (page === null) {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: Object.freeze({
          class: 'unsupportedContract',
          code: 'github_reviews_envelope_invalid',
        }),
        incomplete: false,
      });
    }
    for (const raw of page) {
      const decoded = input.decodeRow(raw);
      if (decoded !== null) rows.push(decoded);
    }

    const next = readValidatedGithubFollowUpPage(response.headers, requestedUrl, input.repositoryId);
    if (next.kind === 'next') {
      url = next.url;
    } else if (next.kind === 'invalid') {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: Object.freeze({
          class: 'unsupportedContract',
          code: 'github_reviews_link_invalid',
        }),
        incomplete: false,
      });
    } else {
      url = null;
    }
  }

  return Object.freeze({
    rows: Object.freeze([...rows]),
    failure: null,
    incomplete: false,
  });
}

export type GithubPullRequestReviewCommentRecordV1 = Readonly<{
  providerId: string;
  body: string;
}>;

export type GithubPullRequestReviewPublicationRecordV1 = Readonly<{
  providerId: string;
  body: string;
}>;

function decodeGithubPullRequestReviewPublicationRecord(
  raw: unknown,
): GithubPullRequestReviewPublicationRecordV1 | null {
  if (!isRecord(raw)) return null;
  const providerId = readProviderId(raw.id);
  return providerId === null || typeof raw.body !== 'string'
    ? null
    : Object.freeze({ providerId, body: raw.body });
}

function decodeGithubPullRequestReviewCommentRecord(
  raw: unknown,
): GithubPullRequestReviewCommentRecordV1 | null {
  if (!isRecord(raw)) return null;
  const providerId = readProviderId(raw.id);
  if (providerId === null || typeof raw.body !== 'string') return null;
  return Object.freeze({ providerId, body: raw.body });
}

/**
 * Minimal full walk for publication markers.
 *
 * Reconciliation needs only GitHub's immutable native id and raw body. It must
 * not discard a marker because an author was deleted or GitHub introduced a
 * review state the richer reviewer-detail decoder does not yet understand.
 */
export async function readGithubPullRequestReviewPublicationRecords(
  input: Readonly<{ route: GithubRepositoryRouteV1; number: string; repositoryId?: string | null }>,
  dependencies: GithubReviewsDependenciesV1,
): Promise<Readonly<{
  reviews: readonly GithubPullRequestReviewPublicationRecordV1[];
  failure: GithubTriageFailureV1 | null;
  incomplete: boolean;
}>> {
  const base = buildGithubApiUrl([
    'repos', input.route.owner, input.route.name, 'pulls', input.number,
  ]);
  const read = await readPaginated<GithubPullRequestReviewPublicationRecordV1>(dependencies, {
    initialUrl: `${base}/reviews?per_page=${GITHUB_MAX_PAGE_SIZE_V1}`,
    repositoryId: input.repositoryId ?? null,
    decodeRow: decodeGithubPullRequestReviewPublicationRecord,
    readPage: (body) => (Array.isArray(body) ? Object.freeze([...body]) : null),
  });
  return Object.freeze({
    reviews: read.rows,
    failure: read.failure,
    incomplete: read.incomplete,
  });
}

/** Canonical full walk used only for exact publication-marker reconciliation. */
export async function readGithubPullRequestReviewCommentRecords(
  input: Readonly<{ route: GithubRepositoryRouteV1; number: string; repositoryId?: string | null }>,
  dependencies: GithubReviewsDependenciesV1,
): Promise<Readonly<{
  comments: readonly GithubPullRequestReviewCommentRecordV1[];
  failure: GithubTriageFailureV1 | null;
  incomplete: boolean;
}>> {
  const base = buildGithubApiUrl([
    'repos',
    input.route.owner,
    input.route.name,
    'pulls',
    input.number,
    'comments',
  ]);
  const read = await readPaginated<GithubPullRequestReviewCommentRecordV1>(dependencies, {
    initialUrl: `${base}?per_page=${GITHUB_MAX_PAGE_SIZE_V1}`,
    repositoryId: input.repositoryId ?? null,
    decodeRow: decodeGithubPullRequestReviewCommentRecord,
    readPage: (body) => (Array.isArray(body) ? Object.freeze([...body]) : null),
  });
  return Object.freeze({
    comments: read.rows,
    failure: read.failure,
    incomplete: read.incomplete,
  });
}

/** Canonical full issue-conversation walk for exact publication markers. */
export async function readGithubIssueCommentPublicationRecords(
  input: Readonly<{ route: GithubRepositoryRouteV1; number: string; repositoryId?: string | null }>,
  dependencies: GithubReviewsDependenciesV1,
): Promise<Readonly<{
  comments: readonly GithubPullRequestReviewCommentRecordV1[];
  failure: GithubTriageFailureV1 | null;
  incomplete: boolean;
}>> {
  const base = buildGithubApiUrl([
    'repos', input.route.owner, input.route.name, 'issues', input.number, 'comments',
  ]);
  const read = await readPaginated<GithubPullRequestReviewCommentRecordV1>(dependencies, {
    initialUrl: `${base}?per_page=${GITHUB_MAX_PAGE_SIZE_V1}`,
    repositoryId: input.repositoryId ?? null,
    decodeRow: decodeGithubPullRequestReviewCommentRecord,
    readPage: (body) => (Array.isArray(body) ? Object.freeze([...body]) : null),
  });
  return Object.freeze({ comments: read.rows, failure: read.failure, incomplete: read.incomplete });
}
