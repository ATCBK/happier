import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { RoleActionInputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { AgentStartSessionCallerV1Schema, readAgentStartCallerWorkDepthV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { createActionExecutor, ActionExecuteResult, ActionExecutorContext, ExternalActionExecutionAuthorizationV1, ExternalActionTargetV1 } from '@happier-dev/protocol';
import type { SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { resolveSessionRoleRpcOrigin } from '@/session/actions/sessionRoleRpcOrigin';
import { resolveActionOriginationPreferenceFailureV1 } from '@happier-dev/protocol/actions/executor/actionOriginationPreferences';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';

type SessionActionOperation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;
type SessionActionAuthority = Readonly<{ sessionId: string; isCurrent(): Promise<boolean>; signal?: AbortSignal }>;
type SessionAccountActionRefusalReason =
  | 'runtime_authority_unavailable'
  | 'caller_witness_invalid'
  | 'session_owner_missing'
  | 'session_not_owner'
  | 'session_owner_read_failed'
  | 'session_action_origin_invalid'
  | 'external_authorization_refused'
  | 'external_authorization_missing'
  | 'external_authorization_binding_mismatch'
  | 'external_authorization_preparation_failed'
  | 'action_executor_refused';
export type SessionAccountActionAuthorizationPreparation = Readonly<{
  operation: Pick<SessionActionOperation, 'actionId' | 'input' | 'requestId' | 'surface'>;
  authority: SessionActionAuthority;
  isCallerCurrent(): Promise<boolean>;
  sessionActionOrigin: SessionActionRpcOriginV1;
  /** Selected by the existing host target owner, never by an author-provided authority field. */
  targetMachineId?: string;
}>;

/** Adapts authenticated Session custody to the existing credentialed Account executor. */
export function createDaemonSessionAccountActionExecutor(params: Readonly<{
  serverId: string;
  serverHttpBaseUrl: string;
  token: string;
  /** The installed daemon producer, independent of optional public-API proof. */
  machineId?: string;
  createExecutor: (getCurrentTurnWorkDepth: (turnId?: string) => number | undefined,
    isCallerCurrent: () => Promise<boolean>) => Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
  /** Host-only producer of original Home authority; author input cannot install this port. */
  prepareExternalActionAuthorization?: (input: SessionAccountActionAuthorizationPreparation) => Promise<Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1; target: ExternalActionTargetV1;
  }> | null | undefined>;
}>) {
  const actionSettingsProvider = runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createActionSettingsProvider({
    scopeKey: resolveAccountSettingsScopeKeyForToken(params.token),
  }));
  return async (operation: SessionActionOperation, authority: SessionActionAuthority): Promise<ActionExecuteResult> => {
    const logRefusal = (reason: SessionAccountActionRefusalReason) => logger.warnLocalFile('[Session Account Action] Refused', {
      actionId: operation.actionId, sessionId: authority.sessionId, requestId: operation.requestId,
      turnId: operation.witness.turnId, reason,
    });
    const refuse = (reason: SessionAccountActionRefusalReason,
      errorCode: 'target_unavailable' | 'cancelled' = 'target_unavailable'): ActionExecuteResult => {
      if (errorCode === 'cancelled') return { ok: false, errorCode, error: errorCode };
      logRefusal(reason);
      return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable', details: { reason } };
    };
    if (authority.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    if (!await authority.isCurrent()) return refuse('runtime_authority_unavailable');
    const executionPlacement = resolveActionExecutionPlacementForInput(getActionSpec(operation.actionId), operation.input);
    // Existing Session-bound Role RPCs retain their own origin channel. Every
    // other Machine effect needs the actual original Home producer, not a
    // second, locally maintained family allowlist.
    const requiresMachineAuthorization = executionPlacement !== 'account'
      && executionPlacement !== 'client'
      && !(Object.hasOwn(RoleActionInputSchemasV1, operation.actionId) && operation.actionId.startsWith('session.'));
    const witness = operation.witness;
    const caller = AgentStartSessionCallerV1Schema.safeParse(witness.agentStartCaller);
    if (!caller.success || caller.data.sessionId !== authority.sessionId
      || witness.workDepth !== readAgentStartCallerWorkDepthV1(caller.data)) {
      return refuse('caller_witness_invalid');
    }
    // Process/Session custody does not authorize borrowing the daemon Account.
    // The exact authenticated Home's owner projection proves same-account use;
    // a shared recipient requires its own admitted requester execution channel.
    const readCallerRefusal = async (): Promise<SessionAccountActionRefusalReason | null> => {
      if (authority.signal?.aborted || !await authority.isCurrent()) return 'runtime_authority_unavailable';
      try {
        const session = await fetchSessionById({
          token: params.token, serverUrl: params.serverHttpBaseUrl, sessionId: authority.sessionId,
          ...(authority.signal ? { signal: authority.signal } : {}),
        });
        if (!session || session.id !== authority.sessionId) return 'session_owner_missing';
        if (readSessionAccessProjectionRoleV1(session) !== 'owner') return 'session_not_owner';
        return !authority.signal?.aborted && await authority.isCurrent() ? null : 'runtime_authority_unavailable';
      } catch {
        return 'session_owner_read_failed';
      }
    };
    const isCallerCurrent = async (): Promise<boolean> => {
      const reason = await readCallerRefusal();
      if (reason && !authority.signal?.aborted) logRefusal(reason);
      return reason === null;
    };
    const callerRefusal = await readCallerRefusal();
    if (callerRefusal) return refuse(callerRefusal, authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
    const preferenceFailure = resolveActionOriginationPreferenceFailureV1(operation.actionId, {
      managedMachineCreationEnabled: actionSettingsProvider.getAccountSettings()?.managedMachineCreationEnabled,
    });
    if (preferenceFailure) return preferenceFailure;
    const context: ActionExecutorContext = {
      surface: operation.surface ?? 'agent', authority: 'account_automation', serverId: params.serverId,
      actionCaller: caller.data,
      ...(params.machineId ? { defaultSessionMachineId: params.machineId } : {}),
      defaultSessionId: authority.sessionId, actionRequestId: operation.requestId,
      callerPermissionMode: witness.callerPermissionMode ?? null,
      causalPermissionAuthority: witness.causalPermissionAuthority ?? null,
      sessionInputSource: { sourceSessionId: authority.sessionId, sourceTurnId: witness.turnId, via: 'action' },
      ...(operation.toolCallId ? { approvalOrigin: {
        kind: 'transcript_tool_call' as const, sessionId: authority.sessionId, toolCallId: operation.toolCallId,
      } } : {}),
      ...(authority.signal ? { signal: authority.signal } : {}),
    };
    let sessionActionOrigin: SessionActionRpcOriginV1;
    try { sessionActionOrigin = resolveSessionRoleRpcOrigin(context); }
    catch { return refuse('session_action_origin_invalid'); }
    let external: Awaited<ReturnType<NonNullable<typeof params.prepareExternalActionAuthorization>>>;
    try {
      external = params.prepareExternalActionAuthorization
        ? await params.prepareExternalActionAuthorization({ operation, authority, isCallerCurrent, sessionActionOrigin }) : undefined;
    } catch (error) {
      logRefusal('external_authorization_preparation_failed');
      throw error;
    }
    if (external === null) return refuse('external_authorization_refused', authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
    if (requiresMachineAuthorization && !external) return refuse('external_authorization_missing', authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
    if (requiresMachineAuthorization && external && (external.authorization.binding.actionId !== operation.actionId
      || external.authorization.binding.requestId !== operation.requestId
      || !sameStrictJsonValue(external.authorization.binding.sessionActionOrigin, sessionActionOrigin)
      || operation.actionId === 'session.board.item.upsert' && (
        external.target.kind !== 'session' || external.target.sessionId !== authority.sessionId
        || external.authorization.binding.target?.kind !== 'session'
        || external.authorization.binding.target.sessionId !== authority.sessionId
        || !external.authorization.binding.sessionActionSource
        || external.authorization.binding.machineId !== external.authorization.binding.sessionActionSource.machineId
        || params.machineId !== undefined && external.authorization.binding.sessionActionSource.machineId !== params.machineId))) {
      return refuse('external_authorization_binding_mismatch', authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
    }
    if (external) {
      const reason = await readCallerRefusal();
      if (reason) return refuse(reason, authority.signal?.aborted ? 'cancelled' : 'target_unavailable');
    }
    const executor = params.createExecutor((turnId) =>
      !turnId || turnId === witness.turnId ? witness.workDepth : undefined, isCallerCurrent);
    // The original Home preparer verified this protected source tuple against
    // the installed Session host's proof. It is not the selected receiver: a
    // remote controller must still sign its own approvals through that receiver.
    const source = external
      && external.authorization.binding.actionId === operation.actionId
      && external.authorization.binding.requestId === operation.requestId
      && sameStrictJsonValue(external.authorization.binding.sessionActionOrigin, sessionActionOrigin)
      ? external.authorization.binding.sessionActionSource : undefined;
    const outcome = await executor.execute(operation.actionId, operation.input, {
      ...context,
      ...(source ? { defaultSessionMachineId: source.machineId } : {}),
      ...(external ? { externalActionExecutionAuthorization: external.authorization, externalActionTarget: external.target } : {}),
    });
    if (!outcome.ok && outcome.errorCode === 'target_unavailable') logRefusal('action_executor_refused');
    return outcome;
  };
}
