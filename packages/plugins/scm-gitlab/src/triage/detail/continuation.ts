/**
 * The paging position of one mounted GitLab detail panel.
 *
 * There is exactly one cursor kind in this vertical, because GitLab offers
 * exactly one: the `Link rel="next"` URL of the collection just read. GitLab
 * documents keyset pagination as *use only the given link*, so this source
 * carries that URL rather than a page number — the opposite custody choice from
 * the GitHub vertical, and the right one for this provider.
 *
 * A URL is untrusted input in both directions. It is admitted against the exact
 * origin THIS invocation was authorized against on the way in and on the way
 * out, so a token cannot aim the binding's credential at another host, and a
 * response cannot redirect the walk off the configured deployment.
 *
 * `limit` travels with it because a cursor is only meaningful under the geometry
 * it was minted with: a panel that changed its window mid-walk would otherwise
 * resume at a position naming different rows. The operation compares it with the
 * requested limit and restarts rather than guessing which rows the reader has.
 *
 * Like the scan continuation, this token is invocation-local, is never
 * persisted, and is never a watermark.
 */

import { admitForgeRequestUrl } from '@happier-dev/triage-sources/runtime';

import type { GitlabConfiguredOrigin } from '../origin.js';
import { GitlabComparisonContinuationV1Schema, type GitlabComparisonContinuationV1 } from './contracts.js';

const CONTINUATION_VERSION = 1;
const ROOT_KEYS = Object.freeze(['v', 'nextUrl', 'limit', 'provenance'] as const);
const PROVENANCE_KEYS = Object.freeze([
  'plane', 'sourceInstanceId', 'configuredBaseUrl', 'routingToken', 'kindId', 'collisionScope', 'entryId',
] as const);

export type GitlabDetailContinuationPlaneV1 =
  | 'notes'
  | 'activity:state'
  | 'activity:label'
  | 'activity:milestone'
  | 'discussions'
  | 'pipelines'
  | 'changes';

export type GitlabDetailContinuationProvenanceV1 = Readonly<{
  plane: GitlabDetailContinuationPlaneV1;
  sourceInstanceId: string;
  configuredBaseUrl: string;
  routingToken: string;
  kindId: string;
  collisionScope: string;
  entryId: string;
}>;

export type GitlabDetailFrontierV1 = Readonly<{
  v: 1;
  /** GitLab's own next-page URL, verbatim, already admitted to the invoked origin. */
  nextUrl: string;
  /** The window this cursor was minted under. */
  limit: number;
  provenance: GitlabDetailContinuationProvenanceV1;
  comparison?: GitlabComparisonContinuationV1;
}>;

export function encodeGitlabDetailContinuation(
  frontier: Omit<GitlabDetailFrontierV1, 'v'>,
): string | null {
  if (!Number.isSafeInteger(frontier.limit) || frontier.limit < 1) return null;
  return JSON.stringify({
    v: CONTINUATION_VERSION,
    nextUrl: frontier.nextUrl,
    limit: frontier.limit,
    provenance: frontier.provenance,
    ...(frontier.comparison === undefined ? {} : { comparison: GitlabComparisonContinuationV1Schema.parse(frontier.comparison) }),
  });
}

/**
 * Decodes a continuation this source minted, for this origin, at this window.
 *
 * Anything else — another version, another window, or a URL on another host — is
 * refused whole rather than partially adopted, and the caller restarts the walk
 * rather than requesting a position nobody can vouch for.
 */
export function decodeGitlabDetailContinuation(input: Readonly<{
  token: string;
  origin: GitlabConfiguredOrigin;
  limit: number;
  provenance: GitlabDetailContinuationProvenanceV1;
}>): GitlabDetailFrontierV1 | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.token);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
  const raw = decoded as Readonly<Record<string, unknown>>;
  if (!hasExactKeys(raw, raw['comparison'] === undefined ? ROOT_KEYS : [...ROOT_KEYS, 'comparison'])) return null;
  if (raw['v'] !== CONTINUATION_VERSION) return null;
  const nextUrl = raw['nextUrl'];
  const limit = raw['limit'];
  if (typeof nextUrl !== 'string' || typeof limit !== 'number') return null;
  if (limit !== input.limit) return null;
  const provenance = readRecord(raw['provenance']);
  if (provenance === null || !hasExactKeys(provenance, PROVENANCE_KEYS)) return null;
  for (const key of PROVENANCE_KEYS) {
    if (provenance[key] !== input.provenance[key]) return null;
  }
  const admitted = admitForgeRequestUrl(nextUrl, input.origin.normalized);
  if (admitted === null) return null;
  const comparison = raw['comparison'] === undefined ? undefined : GitlabComparisonContinuationV1Schema.safeParse(raw['comparison']);
  if (comparison !== undefined && !comparison.success) return null;
  return Object.freeze({ v: 1 as const, nextUrl: admitted, limit, provenance: input.provenance,
    ...(comparison?.success ? { comparison: comparison.data } : {}) });
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === expected.length && expected.every((key) => (
    Object.prototype.hasOwnProperty.call(record, key)
  ));
}
