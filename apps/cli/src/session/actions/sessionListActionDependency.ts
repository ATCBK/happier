import { buildSessionAwarenessListResultV1, markSessionListQueryResultV1 } from '@happier-dev/protocol/sessions/awareness/action';
import type { AccountSettings, ActionExecutorDeps } from '@happier-dev/protocol';

import {
  resolveExternalActionServerRequestHeaders,
  type ExternalActionHomeBinding,
} from '@/api/externalActionExecutionAuthorization';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import {
  listSessions,
  resolveAdmittedSessionListQueryAdmission,
  SessionListAdmittedQueryUnsupportedError,
} from '@/session/services/listSessions';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { buildCliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { summarizeSessionRecord } from '@/cli/output/session/sessionSummary';
import { projectCliSessionAwarenessFromMaterialV1 } from '@/cli/output/session/sessionAwareness';
import type { SessionTransportEncryptionMaterial } from '@/session/transport/encryption/sessionEncryptionContext';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { evaluateFollowRulePreviewV1, type FollowRulePreviewCandidateV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRulePreviewV1';
import { projectSessionListFilterAfterHomeQueryV1, projectSessionListFilterHomeQueriesV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterQueryV1';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readRequesterHomeWithinActionLifetime } from '@/daemon/sessionEncryption/requesterCurrentness';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';

/** The one typed answer for a query arm an admitted one-Session corpus cannot serve. */
function unsupportedSessionListQueryArmsResult(arms: readonly string[]) {
  return {
    ok: false as const,
    errorCode: 'unsupported_action' as const,
    error: 'unsupported_action:session.list',
    details: { unsupportedQueryArms: arms },
  };
}

/**
 * The restricted runtime's exact current-Session list reader. It deliberately
 * uses only the detail route admitted by the restricted server token; Account
 * listing, query, settings and encryption-currentness remain unreachable.
 */
export function createRestrictedCurrentSessionListActionDependency(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  serverId: string;
  serverHttpBaseUrl: string;
  material: SessionTransportEncryptionMaterial;
}>): ActionExecutorDeps['sessionList'] {
  return async (input) => {
    if (input.project) return { ok: false, errorCode: 'session_list_project_filter_unsupported', error: 'session_list_project_filter_unsupported' };
    if (input.query?.underSessionId !== undefined) {
      return unsupportedSessionListQueryArmsResult(['underSessionId']);
    }
    if (
      input.context.serverId !== undefined
      && !await isServerProfileHomeIdentity(params.serverId, input.context.serverId)
    ) {
      return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
    }
    if (
      input.context.sessionListAccess !== 'current_session'
      || input.context.defaultSessionId !== params.sessionId
    ) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' };
    }
    if (input.activeOnly === true && input.archivedOnly === true) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    if (input.cursor != null && input.cursor.length > 0) {
      if (input.view === 'awareness') {
        return buildSessionAwarenessListResultV1({
          sessions: [],
          nextCursor: null,
          hasNext: false,
        });
      }
      return {
        sessions: [],
        nextCursor: null,
        hasNext: false,
        ...(input.includeRows === true ? { rows: [] } : {}),
      };
    }

    const rawSession = await fetchSessionById({
      token: params.credentials.token,
      sessionId: params.sessionId,
      serverUrl: params.serverHttpBaseUrl,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const admission = input.query && rawSession
      ? resolveAdmittedSessionListQueryAdmission(input.query, rawSession)
      : null;
    if (admission?.kind === 'unsupported') {
      return unsupportedSessionListQueryArmsResult(admission.arms);
    }
    const queryMatches = admission === null || admission.kind === 'match';
    const accountEncryptionMode = params.material.mode;
    const row = rawSession && queryMatches
      ? buildCliSessionRowModel({
          credentials: params.credentials,
          rawSession,
          accountEncryptionMode,
          accountSettings: null,
        })
      : null;
    const presentationMatches = row !== null
      && (input.includeSystem === true || row.isSystem !== true)
      && (input.activeOnly !== true || row.active === true)
      && (input.archivedOnly !== true || row.archivedAt !== null)
      && (input.resumableOnly !== true || (
        row.vendorResume.eligible === true
        && row.archivedAt === null
        && row.active !== true
      ));

    if (input.view === 'awareness') {
      const page = {
        sessions: rawSession && presentationMatches
          ? [projectCliSessionAwarenessFromMaterialV1({
              row: rawSession,
              material: params.material,
              nowMs: Date.now(),
            })]
          : [],
        nextCursor: null,
        hasNext: false,
      };
      return input.query
        ? buildSessionAwarenessListResultV1({
            ...page,
            attentionNextCursor: null,
            attentionHasNext: false,
          })
        : buildSessionAwarenessListResultV1(page);
    }

    const result = {
      sessions: rawSession && row && presentationMatches
        ? [{
            ...summarizeSessionRecord({
              credentials: params.credentials,
              accountEncryptionMode,
              session: rawSession,
            }),
            agentId: row.agentId,
            vendorResumeEligible: row.vendorResume.eligible,
            ...(row.vendorResume.eligible
              ? {}
              : { vendorResumeReasonCode: row.vendorResume.reasonCode }),
          }]
        : [],
      nextCursor: null,
      hasNext: false,
      ...(input.includeRows === true ? { rows: row && presentationMatches ? [row] : [] } : {}),
    };
    return input.query
      ? markSessionListQueryResultV1({
          ...result,
          attentionNextCursor: null,
          attentionHasNext: false,
        })
      : result;
  };
}

/** One CLI/daemon adapter from the shared Action contract to Session listing. */
export function createSessionListActionDeps(params: Readonly<{
  readWorkspaceRefs?: (input: Parameters<ActionExecutorDeps['sessionList']>[0]) => Promise<readonly WorkspaceRefV1[]>;
  credentials: StoredCredentials;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  resolveAccountSettings?: () => AccountSettings | null;
  serverHttpBaseUrl?: string;
}> & ExternalActionHomeBinding): Pick<ActionExecutorDeps, 'sessionList' | 'sessionFollowPreview'> {
  const serverId = params.serverId ?? configuration.activeServerId;
  const read = async ({
    project,
    context,
    serverId: requestedServerId,
    query,
    view,
    limit,
    cursor,
    activeOnly,
    archivedOnly,
    includeSystem,
    resumableOnly,
    includeRows,
    includeLastMessagePreview,
    signal,
  }: Parameters<ActionExecutorDeps['sessionList']>[0], filterCandidates?: Parameters<typeof listSessions>[0]['filterCandidates'],
  workspaceRefs?: readonly WorkspaceRefV1[]) => {
    const normalizedActiveOnly = activeOnly === true;
    const normalizedArchivedOnly = archivedOnly === true;
    if ((requestedServerId && !await isServerProfileHomeIdentity(serverId, requestedServerId))
      || (context?.serverId && !await isServerProfileHomeIdentity(serverId, context.serverId))) {
      return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
    }
    if (project && !await isServerProfileHomeIdentity(serverId, project.serverId)) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    const qualifiedProject = project ? { ...project, serverId: await resolveServerProfileHomeIdentityId(serverId) ?? serverId } : undefined;
    if (normalizedActiveOnly && normalizedArchivedOnly) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    const allowedSessionIds = context?.sessionListAccess === 'current_session'
      && typeof context?.defaultSessionId === 'string'
      && context.defaultSessionId.trim().length > 0
      ? [context.defaultSessionId.trim()]
      : undefined;
    const resolveAuthorizationHeaders = (request: Readonly<{
      method: 'GET' | 'POST';
      path: string;
      body?: unknown;
    }>) => {
      const resolved = resolveExternalActionServerRequestHeaders({
        context,
        // Scope/start admission observes the caller's subtree under the
        // original Action. It does not originate a second session.list root.
        effectActionId: context?.externalActionExecutionAuthorization?.binding.actionId ?? 'session.list',
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
        daemonToken: params.credentials.token,
        serverIdentityId: params.serverIdentityId,
        ...(params.externalActionMachineRequestPrivateKey
          ? { privateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { installationId: params.externalActionMachineInstallationId }
          : {}),
      });
      return resolved.ok ? resolved.headers : null;
    };
    if (!resolveAuthorizationHeaders({
      method: 'GET',
      path: '/v1/account/encryption/currentness',
    })) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    const externalActionAccountSettings = context?.externalActionExecutionAuthorization
      && params.resolveAccountSettings
      ? params.resolveAccountSettings()
      : undefined;
    const requester = filterCandidates ? readRequesterAccountActionContext(context.externalActionExecutionAuthorization) : null;
    if (filterCandidates && context.externalActionExecutionAuthorization && (!requester || !await requester.isCurrent())) {
      return { ok: false as const, errorCode: 'follow_rule_account_scope_unavailable', error: 'follow_rule_account_scope_unavailable' };
    }
    const run = async () => await listSessions({
      ...(qualifiedProject ? { project: qualifiedProject, workspaceRefs: await params.readWorkspaceRefs?.({ context, project: qualifiedProject, signal }) } : {}),
      ...(filterCandidates ? { filterCandidates, workspaceRefs, accountSettings: params.resolveAccountSettings?.() ?? null } : {}),
      credentials: requester?.credentials ?? params.credentials,
      resolveAuthorizationHeaders,
      ...(externalActionAccountSettings !== undefined
        ? { accountSettings: externalActionAccountSettings }
        : {}),
      ...(view ? { view } : {}),
      ...(query ? { query } : {}),
      ...(!query
        ? {
            activeOnly: normalizedActiveOnly,
            archivedOnly: normalizedArchivedOnly,
            ...(typeof limit === 'number' ? { limit } : {}),
            ...(typeof cursor === 'string' && cursor.trim().length > 0 ? { cursor: cursor.trim() } : {}),
          }
        : {}),
      includeSystem: includeSystem === true,
      resumableOnly: resumableOnly === true,
      includeRows: includeRows === true,
      includeLastMessagePreview: includeLastMessagePreview === true,
      ...(signal ? { signal } : {}),
      ...(allowedSessionIds ? { allowedSessionIds } : {}),
    });
    try {
      // Scope observation is a preparation read, not the Action effect. Retain
      // its admitted lifetime through transient Home failures before the scope
      // guard classifies an unavailable observation as an unsupported corpus.
      return await readRequesterHomeWithinActionLifetime(() => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, run)
        : run(), signal);
    } catch (error) {
      // The admitted one-Session corpus cannot answer every query arm; that is a
      // typed contract answer, not a transport failure.
      if (error instanceof SessionListAdmittedQueryUnsupportedError) {
        return unsupportedSessionListQueryArmsResult(error.arms);
      }
      throw error;
    }
  };
  return {
    sessionList: read,
    sessionFollowPreview: async ({ context, input, serverId: requestedServerId, signal }) => {
      if ((requestedServerId && !await isServerProfileHomeIdentity(serverId, requestedServerId))
        || (context.serverId && !await isServerProfileHomeIdentity(serverId, context.serverId))) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      const homeServerId = await resolveServerProfileHomeIdentityId(serverId) ?? serverId;
      // Qualifiers are portable identities; local profile ids select credentials.
      // Resolve every supplied qualifier at the existing exact Home owner before
      // structural queries or the shared Project predicate compare identities.
      const identifiers = new Set([...input.filter.homeServerIds, ...input.filter.audiences.map(row => row.serverId),
        ...input.filter.tagIds.map(row => row.serverId),
        ...(input.filter.projects ? [...input.filter.projects.include, ...input.filter.projects.exclude].map(row => row.serverId) : [])]);
      const homes = new Map(await Promise.all([...identifiers].map(async identifier =>
        [identifier, await resolveServerProfileHomeIdentityId(identifier) ?? identifier] as const)));
      const filter = { ...input.filter,
        homeServerIds: input.filter.homeServerIds.map(id => homes.get(id)!),
        audiences: input.filter.audiences.map(row => ({ ...row, serverId: homes.get(row.serverId)! })),
        tagIds: input.filter.tagIds.map(row => ({ ...row, serverId: homes.get(row.serverId)! })),
        ...(input.filter.projects ? { projects: {
          include: input.filter.projects.include.map(row => ({ ...row, serverId: homes.get(row.serverId)! })),
          exclude: input.filter.projects.exclude.map(row => ({ ...row, serverId: homes.get(row.serverId)! })),
        } } : {}),
      };
      const candidates: FollowRulePreviewCandidateV1[] = [];
      const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
      const isAccountCurrent = () => requester ? requester.isCurrent() : params.isCredentialCurrent?.() ?? true;
      if (!await isAccountCurrent()) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      const credentials = requester?.credentials ?? params.credentials;
      const viewerAccountId = readAccountIdFromToken(credentials.token) ?? undefined;
      const queries = projectSessionListFilterHomeQueriesV1(filter, { storage: 'active', includeInactive: true,
        mountedHomeServerIds: [homeServerId] });
      const unservedHome = filter.homeServerIds.some(home => home !== homeServerId);
      let coverage: 'complete' | 'partial' | 'unavailable' = unservedHome || filter.show !== 'sessions'
        || context.sessionListAccess === 'current_session' ? 'partial' : 'complete';
      if (filter.show === 'runs') return evaluateFollowRulePreviewV1({ filter, candidates, coverage: 'unavailable' });
      let workspaceRefs: readonly WorkspaceRefV1[] | undefined;
      if (filter.projects && params.readWorkspaceRefs) {
        try { workspaceRefs = await params.readWorkspaceRefs({ context, signal }); }
        catch (error) { signal?.throwIfAborted(); coverage = 'partial'; }
      }
      for (const home of queries) {
        const page = await read({ context, query: home.query, includeSystem: false, signal },
          { serverId: home.serverId, viewerAccountId, filters: [filter], collect: candidate => candidates.push(candidate) }, workspaceRefs);
        if ('ok' in page && page.ok === false) return page;
        if ('hasNext' in page && (page.hasNext || 'attentionHasNext' in page && page.attentionHasNext)
          || 'metadataUpgradeRequiredCount' in page && Number(page.metadataUpgradeRequiredCount) > 0) coverage = 'partial';
      }
      if (!await isAccountCurrent()) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      signal?.throwIfAborted();
      return evaluateFollowRulePreviewV1({ filter: projectSessionListFilterAfterHomeQueryV1(filter, homeServerId), candidates,
        coverage: queries.length === 0 && unservedHome ? 'unavailable' : coverage });
    },
  };
}
