import { randomUUID } from 'node:crypto';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';

import type { Metadata } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { materializeWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { createProjectAccountSnapshotMutation, type ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';

export type AcceptedSessionWorkspaceCustody = Pick<AdmittedRequesterSessionBootstrap,
  'credentials' | 'attribution' | 'serverHttpBaseUrl' | 'getBoundSessionId' | 'isCurrent'> & Readonly<{ release(): Promise<void> }>;

/** Accepted Session facts enrich the private checkout library through its existing row writer. */
export function createAcceptedSessionWorkspaceRegistration(input: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  machineId: string;
  signal?: AbortSignal;
  inspectLocation?: typeof inspectWorkspaceLocationWithScmWorkspace;
  requesterSessionCustody?: Readonly<{
    resolve(sessionId: string): Promise<AcceptedSessionWorkspaceCustody | null>;
  }>;
}>): (metadata: Metadata, sessionId: string) => Promise<void> {
  return async (metadata, sessionId) => {
    // Session-private managed folders never become Account Projects, even if an Agent initializes SCM there.
    if (readSessionDirectoryKind(metadata) === 'managed') return;
    const serverId = await resolveServerProfileHomeIdentityId(input.serverId);
    if (!serverId) throw Object.assign(new Error('workspace_registration_home_unavailable'), { code: 'workspace_registration_home_unavailable' });
    const custody = await input.requesterSessionCustody?.resolve(sessionId) ?? null;
    try {
      if (custody && (custody.getBoundSessionId() !== sessionId || custody.attribution.serverId !== input.serverId
        || custody.attribution.machineId !== input.machineId || !await custody.isCurrent())) {
        throw Object.assign(new Error('workspace_registration_requester_channel_unavailable'), { code: 'workspace_registration_requester_channel_unavailable' });
      }
      const credentials = custody?.credentials ?? input.credentials;
      const session = await runWithServerHttpBaseUrl(custody?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), () => fetchSessionByIdCompat({
        token: credentials.token, sessionId, signal: input.signal,
      }));
      // Custodian credentials cannot register a foreign Session. Admitted
      // requester custody must still prove ownership on its own Account channel.
      const role = session?.id === sessionId && (session.effectiveAccess !== undefined || session.share !== undefined)
        ? readSessionAccessProjectionRoleV1(session) : 'unavailable';
      if (role !== 'owner' || custody && !await custody.isCurrent()) {
        const code = custody || role === 'recipient' ? 'workspace_registration_requester_channel_unavailable' : 'workspace_registration_owner_unavailable';
        throw Object.assign(new Error(code), { code });
      }
      const authority: ProjectAccountRowsInput = { credentials, serverId: input.serverId,
        ...(custody ? { sessionCustody: { serverId: custody.attribution.serverId, accountId: custody.attribution.accountId,
          serverHttpBaseUrl: custody.serverHttpBaseUrl, isCurrent: custody.isCurrent } } : {}) };
      const mutate = createProjectAccountSnapshotMutation(authority);
      const inspected = await (input.inspectLocation ?? inspectWorkspaceLocationWithScmWorkspace)({
        candidatePath: metadata.path, includeRepositoryIdentity: true, signal: input.signal,
      });
      // Automatic Projects come from positive SCM evidence, not arbitrary folders.
      if (!inspected) return;
      for (;;) {
        const result = await mutate(snapshot => {
          const accepted = materializeWorkspaceRefForMachineRoot(snapshot.workspaceRefs, {
            serverId,
            machineId: input.machineId,
            rootPath: inspected.inspection.rootPath,
            ...(inspected.repositoryIdentity ? { repositoryIdentity: inspected.repositoryIdentity } : {}),
            nowMs: Date.now(),
            createId: randomUUID,
          });
          return { ...snapshot, workspaceRefs: accepted.workspaceRefs };
        }, input.signal);
        if (result.status === 'applied' || result.status === 'unchanged') return;
        // Re-admit a conflicting acceptance against the mutator's next census.
        if (result.status === 'conflict') continue;
        const code = `workspace_registration_${result.status}`;
        throw Object.assign(new Error(code), { code });
      }
    } finally { await custody?.release(); }
  };
}
