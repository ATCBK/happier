import type { SessionListFilterFactsV1, SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { readSessionListStartedByV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { readSessionAwarenessPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { tryDecryptSessionOwnerMetadataView, tryDecryptSessionPresentationMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { projectCliSessionAwarenessV1, type CliSessionAwarenessParams } from './sessionAwareness';
import { fetchSessionOrganizationPlacementBatches } from '@/session/transport/http/sessionsHttp';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';

type PreparedSessionListFilterFacts = Readonly<{ workspaceRefs?: readonly WorkspaceRefV1[]; tagIds?: readonly string[] }>;

/** Exact assignment-only reads, shared by preview batches and one-source rule evaluation. */
export async function readCliSessionListTagAssignmentsV1(input: Readonly<{
  credentials: StoredCredentials; serverId: string; sessionIds: readonly string[];
  filters: readonly SessionListFilterV1[]; serverHttpBaseUrl?: string; signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<ReadonlyMap<string, readonly string[]> | undefined> {
  const homes = [...new Set(input.filters.flatMap(filter => filter.tagIds.map(tag => tag.serverId)))];
  if (!(await Promise.all(homes.map(home => isServerProfileHomeIdentity(input.serverId, home)))).some(admitted => admitted)) return undefined;
  const assignments = new Map<string, readonly string[]>();
  for await (const batch of fetchSessionOrganizationPlacementBatches({
    ...input, token: input.credentials.token,
  })) {
    if (!batch.ok) continue;
    for (const [sessionId, placement] of batch.placements) assignments.set(sessionId, placement.tagIds);
  }
  return assignments;
}

/** Private supplemental facts belong to the captured evaluator, never the installed Account projection. */
export async function readCliSessionListFilterFactsV1(input: CliSessionAwarenessParams & Readonly<{
  serverId: string; accountId: string; serverHttpBaseUrl: string; signal: AbortSignal;
  isCurrent: () => Promise<boolean>; filters: readonly SessionListFilterV1[];
}>): Promise<SessionListFilterFactsV1 | null> {
  if (input.signal.aborted || readAccountIdFromToken(input.credentials.token) !== input.accountId || !await input.isCurrent()) return null;
  const serverId = await resolveServerProfileHomeIdentityId(input.serverId) ?? input.serverId;
  const projectHomes = [...new Set(input.filters.flatMap(filter => filter.projects
    ? [...filter.projects.include, ...filter.projects.exclude].map(project => project.serverId) : []))];
  const projectsRequired = (await Promise.all(projectHomes.map(home => isServerProfileHomeIdentity(input.serverId, home))))
    .some(admitted => admitted);
  const [projects, tags] = await Promise.allSettled([
    projectsRequired ? readProjectAccountRows({ credentials: input.credentials, serverId, signal: input.signal,
      sessionCustody: { accountId: input.accountId, serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl,
        isCurrent: input.isCurrent } }) : Promise.resolve(undefined),
    readCliSessionListTagAssignmentsV1({ ...input, serverId, sessionIds: [input.row.id] }),
  ]);
  if (input.signal.aborted || !await input.isCurrent()) return null;
  // Profile aliases qualify caller filters, never stored Workspace identities.
  const workspaceRefs = projects.status === 'fulfilled' ? projects.value?.workspaceRefs.filter(ref => ref.serverId === serverId) : undefined;
  const tagIds = tags.status === 'fulfilled' ? tags.value?.get(input.row.id) : undefined;
  return projectCliSessionListFilterFactsV1({ ...input, serverId, viewerAccountId: input.accountId,
    preparedFacts: { workspaceRefs, tagIds },
    workspaceContext: { normalizeServerId: id => id === input.serverId ? serverId : id } });
}

/** Current authorized facts shared by list/preview and occurrence evaluation; never persisted. */
export function projectCliSessionListFilterFactsV1(input: CliSessionAwarenessParams & Readonly<{
  serverId: string; viewerAccountId?: string; workspaceRefs?: readonly WorkspaceRefV1[];
  workspaceContext?: SessionListFilterFactsV1['workspaceContext'];
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
    ...(input.workspaceContext ? { workspaceContext: input.workspaceContext } : {}),
    ...(input.preparedFacts?.tagIds === undefined ? {} : { tagIds: input.preparedFacts.tagIds }),
  };
}
