import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { readSessionProjectWorkspaceAddressV1, resolveSessionProjectWorkspaceRefV1, projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { readProjectAccountRows } from './projectAccountRows';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { classifyHomeReadPreparationError } from '@/agent/prompts/library/homeReadPreparationError';

export type SessionProjectPromptStackInput = Readonly<{
  credentials: StoredCredentials; metadata: unknown; signal?: AbortSignal; machineId: string; directory?: string; serverId?: string;
  operationContext?: SavedSecretOperationContextV1;
}>;
export type SessionProjectKeyResolution = Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'resolved'; projectKey: string; workspaceRef: WorkspaceRefV1; promptStack: readonly PromptStackEntryV1[] }>
  | Readonly<{ kind: 'pending'; reason: 'project_association_unavailable' }>;

/** Account association selects an exact checkout; filesystem containment does not select a Project. */
export async function resolveSessionProjectKey(input: SessionProjectPromptStackInput,
  readRows: typeof readProjectAccountRows = readProjectAccountRows): Promise<SessionProjectKeyResolution> {
  input.signal?.throwIfAborted();
  const pending = { kind: 'pending', reason: 'project_association_unavailable' } as const;
  const prepared = readSessionProjectWorkspaceAddressV1(input);
  if (prepared.kind !== 'ready') return prepared;
  const serverId = input.serverId ?? input.credentials.requesterSessionCredentialScope?.serverId ?? configuration.activeServerId;
  let snapshot: Awaited<ReturnType<typeof readProjectAccountRows>>;
  try {
    const accountId = input.operationContext ? readAccountIdFromToken(input.credentials.token) : null;
    if (input.operationContext && (!accountId || input.operationContext.credentials.token !== input.credentials.token)) return pending;
    snapshot = await readRows({ credentials: input.credentials, serverId, signal: input.signal,
      ...(input.operationContext && accountId ? { sessionCustody: { serverId, accountId,
        serverHttpBaseUrl: input.operationContext.serverHttpBaseUrl, isCurrent: input.operationContext.isCurrent } } : {}) });
  }
  catch (error) {
    input.signal?.throwIfAborted();
    // A failed Home read says nothing about the association. Keep the shared
    // preparation disposition so startup respawn and pre-turn custody can recover.
    const preparationError = classifyHomeReadPreparationError(error);
    if (preparationError !== error) throw preparationError;
    return pending;
  }
  const homeId = await resolveServerProfileHomeIdentityId(serverId) ?? serverId;
  input.signal?.throwIfAborted();
  const resolved = resolveSessionProjectWorkspaceRefV1(snapshot.workspaceRefs, { serverId: homeId, address: prepared.address });
  if (resolved.kind !== 'resolved') return resolved;
  const project = projectWorkspaceRefV1(resolved.ref);
  return { kind: 'resolved', projectKey: project.projectKey, workspaceRef: resolved.ref,
    // The prompt consumer uses the same captured read, never a second association census.
    promptStack: snapshot.organizations.find(row => row.key.serverId === project.serverId
      && row.key.projectKey === project.projectKey)?.value.promptStack ?? [] };
}
