import axios from 'axios';
import type { SessionListFilterFactsV1, SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { readSessionListStartedByV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { readSessionAwarenessPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { tryDecryptSessionOwnerMetadataView, tryDecryptSessionPresentationMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { projectCliSessionAwarenessV1, type CliSessionAwarenessParams } from './sessionAwareness';
import { buildSessionOrganizationAssignmentSnapshotHttpRequestV1, SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS } from '@happier-dev/protocol/sessions/organization/constants';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';

type PreparedSessionListFilterFacts = Readonly<{ workspaceRefs?: readonly WorkspaceRefV1[]; tagIds?: readonly string[] }>;

/** Exact assignment-only reads, shared by preview batches and one-source rule evaluation. */
export async function readCliSessionListTagAssignmentsV1(input: Readonly<{
  credentials: StoredCredentials; serverId: string; sessionIds: readonly string[];
  filters: readonly SessionListFilterV1[]; serverHttpBaseUrl?: string; signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<ReadonlyMap<string, readonly string[]> | undefined> {
  if (!input.filters.some(filter => filter.tagIds.some(tag => tag.serverId === input.serverId))) return undefined;
  const ids = [...new Set(input.sessionIds)];
  const assignments = new Map<string, readonly string[]>();
  for (let offset = 0; offset < ids.length; offset += SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS) {
    const chunk = ids.slice(offset, offset + SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS);
    const request = buildSessionOrganizationAssignmentSnapshotHttpRequestV1(chunk);
    const headers = input.resolveAuthorizationHeaders
      ? input.resolveAuthorizationHeaders(request) : { Authorization: `Bearer ${input.credentials.token}` };
    if (!headers) continue;
    try {
      const response = await axios.get<unknown>(`${input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}${request.path}`, {
        headers, signal: input.signal, timeout: configuration.sessionControlHttpTimeoutMs, validateStatus: () => true,
      });
      const parsed = response.status === 200 ? SessionOrganizationSnapshotResponseSchema.safeParse(response.data) : null;
      if (!parsed?.success) continue;
      const rows = new Map(parsed.data.snapshot.tagAssignments.map(row => [row.sessionId, row.tagIds]));
      for (const id of chunk) assignments.set(id, rows.get(id) ?? []);
    } catch { input.signal?.throwIfAborted(); }
  }
  return assignments;
}

/** Private supplemental facts belong to the captured evaluator, never the installed Account projection. */
export async function readCliSessionListFilterFactsV1(input: CliSessionAwarenessParams & Readonly<{
  serverId: string; accountId: string; serverHttpBaseUrl: string; signal: AbortSignal;
  isCurrent: () => Promise<boolean>; filters: readonly SessionListFilterV1[];
}>): Promise<SessionListFilterFactsV1 | null> {
  if (input.signal.aborted || readAccountIdFromToken(input.credentials.token) !== input.accountId || !await input.isCurrent()) return null;
  const projectsRequired = input.filters.some(filter => filter.projects
    && [...filter.projects.include, ...filter.projects.exclude].some(project => project.serverId === input.serverId));
  const [projects, tags] = await Promise.allSettled([
    projectsRequired ? readProjectAccountRows({ credentials: input.credentials, serverId: input.serverId, signal: input.signal,
      sessionCustody: { accountId: input.accountId, serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl,
        isCurrent: input.isCurrent } }) : Promise.resolve(undefined),
    readCliSessionListTagAssignmentsV1({ ...input, sessionIds: [input.row.id] }),
  ]);
  if (input.signal.aborted || !await input.isCurrent()) return null;
  const workspaceRefs = projects.status === 'fulfilled' ? projects.value?.workspaceRefs : undefined;
  const tagIds = tags.status === 'fulfilled' ? tags.value?.get(input.row.id) : undefined;
  return projectCliSessionListFilterFactsV1({ ...input, viewerAccountId: input.accountId,
    preparedFacts: { workspaceRefs, tagIds } });
}

/** Current authorized facts shared by list/preview and occurrence evaluation; never persisted. */
export function projectCliSessionListFilterFactsV1(input: CliSessionAwarenessParams & Readonly<{
  serverId: string; viewerAccountId?: string; workspaceRefs?: readonly WorkspaceRefV1[];
  preparedFacts?: PreparedSessionListFilterFacts;
}>): SessionListFilterFactsV1 {
  const row = input.row;
  const metadata = tryDecryptSessionPresentationMetadataView({ credentials: input.credentials,
    accountEncryptionMode: input.accountEncryption.mode, rawSession: row });
  const ownerMetadata = readSessionAccessProjectionRoleV1(row) === 'owner'
    ? tryDecryptSessionOwnerMetadataView({ credentials: input.credentials,
      accountEncryptionMode: input.accountEncryption.mode, rawSession: row }) : null;
  const linked = ownerMetadata ? resolveLinkedExternalSessionAuthorityV1(ownerMetadata) : null;
  const relevance = row.viewer?.relevance;
  const ownedByViewer = input.viewerAccountId !== undefined && row.ownerAccountId === input.viewerAccountId;
  return {
    serverId: input.serverId, kind: 'session', managedSessions: row.managedSessions, receivedRuleCount: row.receivedRuleCount,
    startedBy: readSessionListStartedByV1({ origin: row.origin, ownerAccountId: row.ownerAccountId,
      viewerAccountId: input.viewerAccountId }),
    scopeMatches: {
      ...(relevance ? { my_work: relevance.relevant,
        involving_me: relevance.reasons.some(reason => reason === 'owned_by_me' || reason === 'responsible_for_me'
          || reason === 'shared_directly_with_me' || reason === 'authored_by_me'),
        assigned_to_me: relevance.reasons.includes('responsible_for_me') }
        : ownedByViewer ? { my_work: true, involving_me: true } : {}),
      ...(row.viewer?.follow ? { following: row.viewer.follow.follows } : {}),
    },
    ...(row.viewer?.attention ? { attentionRequired: row.viewer.attention.needsAttention } : {}),
    metadata, projectMetadata: ownerMetadata,
    status: readSessionAwarenessPresentationV1(projectCliSessionAwarenessV1(input)),
    ...(ownerMetadata ? { source: linked?.ok ? linked.transcriptStorage : 'persisted' } : {}),
    workspaceRefs: input.preparedFacts?.workspaceRefs ?? input.workspaceRefs,
    ...(input.preparedFacts?.tagIds === undefined ? {} : { tagIds: input.preparedFacts.tagIds }),
  };
}
