import { isApiTokenGrantTargetMemberV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ApiTokenGrantV1, ApprovalRequestV2, TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import {
  classifyApprovalExecutionOriginCurrentness,
  type ActionExecuteResult,
  type ActionExecutorDeps,
  type ActionExecutorContext,
} from '@happier-dev/protocol/actions';
import { admitApprovalRequesterDecisionV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { projectTargetActionApprovalInvocationV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { PluginError } from '@happier-dev/plugin-sdk';
import { ActionOperationCredentialUseV1Schema, type ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import type { DaemonApprovalExecutionOriginCurrentness } from './daemonExternalActionTargetResolver';
import {
  executeContributedAction,
} from '@/plugins/runtime/invocation/actions/executeContributedAction';
import {
  createCommittedContributedActionDefinitionLister,
  createCommittedContributedActionInvoker,
} from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { targetActionApprovalMatchesCurrentIntent } from '@/session/actions/approvals/targetActionCurrentIntent';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
import type {
  TargetActionCurrentIntentRequest,
  TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { PluginExternalActionContext } from '@/plugins/runtime/invocation/services/types';

type TargetActionApprovalStore = Pick<
  ReturnType<typeof createCliApprovalsArtifactStore>,
  'targetActionApprovalsGet' | 'targetActionApprovalsUpdate'
>;

function buildTargetActionApprovalDecisionResult(
  request: TargetActionApprovalRequestV1,
): ActionExecuteResult {
  return {
    ok: true,
    result: {
      ok: true,
      status: request.status,
      ...(request.execution === undefined ? {} : { execution: request.execution }),
    },
  };
}

function targetActionReplayFailure(
  errorCode: string,
  error = errorCode,
): ActionExecuteResult {
  return { ok: false, errorCode, error };
}

function projectTargetApprovalRequest(request: TargetActionApprovalRequestV1): ApprovalRequestV2 | null {
  const invocation = projectTargetActionApprovalInvocationV1(request);
  if (!invocation || !request.executionOriginV1) return null;
  return { v: 2, status: request.status, createdAtMs: request.createdAtMs, updatedAtMs: request.updatedAtMs,
    createdBy: request.createdBy, requestedSurface: request.requestedSurface, ...invocation,
    executionOriginV1: request.executionOriginV1, summary: request.summary,
    ...(request.requesterConfirmation ? { requesterConfirmation: request.requesterConfirmation } : {}),
    ...(request.detail ? { preview: { detail: request.detail } } : {}),
    ...(request.decision ? { decision: request.decision } : {}),
  };
}

/**
 * Adapts the public host Action `action.invoke` to the one committed-runtime
 * contributed-Action dispatcher. This adapter translates the public typed
 * contribution identity to the registry's canonical internal key; API caller
 * provenance remains host-owned and is deliberately not fabricated as a
 * plugin caller.
 */
export function createDaemonExternalActionContributedInvoker(input: Readonly<{
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  requestCurrentIntent?: (
    request: TargetActionCurrentIntentRequest,
  ) => Promise<TargetActionCurrentIntentResult>;
}> = {}): NonNullable<ActionExecutorDeps['invokeContributedAction']> {
  const acquireRuntimeRegistryLease = input.acquireRuntimeRegistryLease
    ?? acquireAuthoritativePluginRuntimeRegistryLease;

  return createCommittedContributedActionInvoker({
    defaultInvocationSurface: 'api',
    acquireRuntimeRegistryLease: () => acquireRuntimeRegistryLease({
      happyHomeDir: configuration.happyHomeDir,
    }),
    ...(input.requestCurrentIntent ? { requestCurrentIntent: input.requestCurrentIntent } : {}),
  });
}

/**
 * Settles target-action approvals at their admitting daemon. Live-only input
 * resumes the incumbent waiter; durable public input re-enters the canonical
 * contributed-Action dispatcher. `approval.request.decide` owns both decisions.
 */
export function createDaemonExternalActionContributedApprovalReplay(input: Readonly<{
  credentials: StoredCredentials;
  isApprovalExecutionOriginCurrent?: DaemonApprovalExecutionOriginCurrentness;
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  targetActionApprovals?: TargetActionApprovalStore;
  readInstallationIdentity?: typeof readInstallationIdentityIfExistsSync;
  now?: () => number;
}>): NonNullable<ActionExecutorDeps['targetActionApprovalReplay']> {
  const acquireRuntimeRegistryLease = input.acquireRuntimeRegistryLease
    ?? acquireAuthoritativePluginRuntimeRegistryLease;
  const targetActionApprovals = input.targetActionApprovals
    ?? createCliApprovalsArtifactStore({ credentials: input.credentials });
  const now = input.now ?? Date.now;
  const readInstallationIdentity = input.readInstallationIdentity
    ?? readInstallationIdentityIfExistsSync;
  const replayArtifact = async ({
    artifactId,
    decision,
    signal,
    callerGrant,
    context,
  }: Readonly<{
    artifactId: string;
    decision: 'approve' | 'reject' | 'cancel';
    signal?: AbortSignal;
    callerGrant?: ApiTokenGrantV1;
    context?: ActionExecutorContext;
  }>): Promise<ActionExecuteResult | null> => {
    let existing: TargetActionApprovalRequestV1 | null;
    try {
      existing = await targetActionApprovals.targetActionApprovalsGet({ artifactId });
    } catch {
      return targetActionReplayFailure('approval_unavailable');
    }
    // This callback deliberately leaves ordinary ApprovalRequestV1 artifacts
    // on the generic Action owner rather than trying to interpret them here.
    if (!existing) return null;
    const originalInvocation = projectTargetActionApprovalInvocationV1(existing);
    if (!originalInvocation) return targetActionReplayFailure('approval_invalid');
    const admitRequester = async (request: TargetActionApprovalRequestV1) => await admitApprovalRequesterDecisionV1({
      request: { ...request, ...originalInvocation }, context: context ?? {},
    });
    const requesterAdmission = await admitRequester(existing);
    if (!requesterAdmission.ok) return requesterAdmission;
    const isRequesterSourceCurrent = async (request: TargetActionApprovalRequestV1): Promise<boolean> => {
      const projected = projectTargetApprovalRequest(request);
      return projected !== null && input.isApprovalExecutionOriginCurrent !== undefined
        && await input.isApprovalExecutionOriginCurrent({ origin: projected.executionOriginV1, request: projected,
          ...(signal ? { signal } : {}) }).catch(() => false);
    };
    if (existing.requesterConfirmation && !['executed', 'failed', 'rejected', 'canceled'].includes(existing.status)
      && !await isRequesterSourceCurrent(existing)) return targetActionReplayFailure('approval_stale');
    const requesterDecision = existing.requesterConfirmation ? {
      authority: 'present_user' as const, decidingAccountId: existing.requesterConfirmation.requesterAccountId,
    } : {};
    if ((!['api', 'cli', 'agent', 'mcp'].includes(existing.requestedSurface) && existing.approvalInputCustody !== 'live_only')
      || (existing.approvalInputCustody !== 'live_only' && existing.replayPlacement === undefined)) {
      return targetActionReplayFailure('approval_invalid');
    }
    const decisionOrigin = existing.executionOriginV1;
    const target = decisionOrigin?.target
      ?? (decisionOrigin?.sessionId ? { kind: 'session' as const, sessionId: decisionOrigin.sessionId } : null)
      ?? (decisionOrigin?.machineId ? { kind: 'machine' as const, machineId: decisionOrigin.machineId } : null);
    const decisionTarget = target ?? (existing.replayPlacement?.defaultSessionId
      ? { kind: 'session' as const, sessionId: existing.replayPlacement.defaultSessionId }
      : existing.replayPlacement
      ? { kind: 'machine' as const, machineId: existing.replayPlacement.machineId } : null);
    if (callerGrant && !isApiTokenGrantTargetMemberV1(callerGrant, decisionTarget,
      decisionOrigin?.machineId ?? existing.replayPlacement?.machineId)) {
      return targetActionReplayFailure('credential_scope_denied');
    }

    const nextTimestamp = (request: TargetActionApprovalRequestV1): number => (
      Math.max(now(), request.updatedAtMs)
    );
    const persist = async (
      request: TargetActionApprovalRequestV1,
    ): Promise<ActionExecuteResult | null> => {
      try {
        const updated = await targetActionApprovals.targetActionApprovalsUpdate({ artifactId, request });
        return updated.ok ? null : targetActionReplayFailure(updated.errorCode, updated.error);
      } catch {
        return targetActionReplayFailure('approval_update_failed');
      }
    };

    if (decision === 'cancel') {
      if (existing.status === 'canceled') return buildTargetActionApprovalDecisionResult(existing);
      if (existing.status !== 'open') return targetActionReplayFailure('approval_not_open');
      const canceled: TargetActionApprovalRequestV1 = {
        ...existing, status: 'canceled', updatedAtMs: nextTimestamp(existing),
      };
      const persistenceFailure = await persist(canceled);
      if (!persistenceFailure) getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({ artifactId, request: canceled });
      return persistenceFailure ?? buildTargetActionApprovalDecisionResult(canceled);
    }

    if (decision === 'reject') {
      if (existing.status === 'rejected' && existing.decision?.kind === 'reject') {
        return buildTargetActionApprovalDecisionResult(existing);
      }
      if (existing.status !== 'open') {
        return targetActionReplayFailure('approval_not_open');
      }
      const rejected: TargetActionApprovalRequestV1 = {
        ...existing,
        status: 'rejected',
        updatedAtMs: nextTimestamp(existing),
        decision: { kind: 'reject', decidedAtMs: nextTimestamp(existing), ...requesterDecision },
      };
      const persistenceFailure = await persist(rejected);
      if (!persistenceFailure) getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({ artifactId, request: rejected });
      return persistenceFailure ?? buildTargetActionApprovalDecisionResult(rejected);
    }

    if (existing.approvalInputCustody === 'live_only'
      && getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId) === 0) {
      return targetActionReplayFailure('approval_stale');
    }
    if ((existing.status === 'executed' || existing.status === 'failed')
      && existing.decision?.kind === 'approve') {
      return buildTargetActionApprovalDecisionResult(existing);
    }
    if (existing.status === 'executing' && existing.decision?.kind === 'approve') {
      return targetActionReplayFailure('approval_execution_outcome_unknown');
    }
    if (existing.status !== 'open'
      && (existing.status !== 'approved' || existing.decision?.kind !== 'approve')) {
      return targetActionReplayFailure('approval_not_open');
    }
    if (resolveApprovalRequestApproveAdmission(existing).status !== 'available') {
      return targetActionReplayFailure('approval_context_unavailable');
    }
    let approved = existing;
    if (existing.status === 'open') {
      const approvedAtMs = nextTimestamp(existing);
      const nextApproved: TargetActionApprovalRequestV1 = {
        ...existing,
        status: 'approved',
        updatedAtMs: approvedAtMs,
        decision: { kind: 'approve', decidedAtMs: approvedAtMs, ...requesterDecision },
      };
      // A lost or conflicting decision write is reconciled from the durable
      // row rather than assumed: another decider may already have committed
      // the same approval, or carried it through to a terminal outcome.
      const persistenceFailure = await persist(nextApproved);
      let persisted: TargetActionApprovalRequestV1 | null;
      try {
        persisted = await targetActionApprovals.targetActionApprovalsGet({ artifactId });
      } catch {
        return targetActionReplayFailure('approval_unavailable');
      }
      if (!persisted) {
        return persistenceFailure ?? targetActionReplayFailure('approval_not_found');
      }
      if ((persisted.status === 'executed' || persisted.status === 'failed')
        && persisted.decision?.kind === 'approve') {
        return buildTargetActionApprovalDecisionResult(persisted);
      }
      if (persisted.status !== 'approved' || persisted.decision?.kind !== 'approve') {
        return persistenceFailure ?? targetActionReplayFailure('approval_not_open');
      }
      approved = persisted;
    }
    if (approved.approvalInputCustody === 'live_only') {
      // The existing admitted invocation owns the raw input and rechecks its
      // current policy after this decision. Never redispatch its projection.
      const coordinator = getSharedBlockingApprovalCoordinator();
      // Its Account subscription may already have consumed this durable
      // decision before the write returned. Liveness was admitted above;
      // an already-woken waiter is not a stale replay.
      if (approved.requesterConfirmation) {
        const proof = context?.requesterApprovalDecision;
        await coordinator.resolveBlockingDecision({ artifactId, request: approved, decision: 'approve',
          decisionAuthority: 'present_user', ...(proof ? { requesterApprovalDecision: {
            ...proof, isCurrent: async () => await proof.isCurrent() && await isRequesterSourceCurrent(approved),
          } } : {}) });
      } else coordinator.notifyApprovalUpdated({ artifactId, request: approved });
      return buildTargetActionApprovalDecisionResult(approved);
    }
    const requestedSurface = approved.requestedSurface;
    if ((requestedSurface !== 'api' && requestedSurface !== 'cli' && requestedSurface !== 'agent' && requestedSurface !== 'mcp')
      || approved.replayPlacement === undefined) {
      return targetActionReplayFailure('approval_invalid');
    }
    // The durable placement is stamped once at admission; later status writes
    // below carry it forward unchanged, so it is captured here rather than
    // re-read from a reassigned request.
    const replayPlacement = approved.replayPlacement;
    const action = parseQualifiedPluginActionId(approved.qualifiedActionId);
    if (!action) return targetActionReplayFailure('approval_invalid');
    const origin = approved.executionOriginV1;
    if (!origin) return targetActionReplayFailure('approval_invalid');
    const sourceBinding = origin.externalActionExecutionAuthorization?.binding;
    const sourceSession = sourceBinding && 'authentication' in sourceBinding ? sourceBinding.sessionActionOrigin : undefined;

    const approvalRequest = projectTargetApprovalRequest(approved);
    if (!approvalRequest) return targetActionReplayFailure('approval_invalid');
    const currentness = await classifyApprovalExecutionOriginCurrentness({
      check: async reportStale => input.isApprovalExecutionOriginCurrent
        ? await input.isApprovalExecutionOriginCurrent({
            origin,
            request: approvalRequest,
            reportStale,
            ...(signal ? { signal } : {}),
          })
        : (reportStale('currentness_owner_unavailable'), false),
    });
    if (currentness.status === 'requester_home_unavailable') {
      return targetActionReplayFailure('project_requester_home_unavailable');
    }
    if (currentness.status === 'read_failed') {
      return targetActionReplayFailure(currentness.failure.errorCode, currentness.failure.error);
    }
    if (currentness.status === 'stale') {
      logger.debug('[RPC] Contributed approval origin is stale', {
        code: 'approval_stale',
        reason: currentness.reason,
      });
      const executedAtMs = nextTimestamp(approved);
      const terminal: TargetActionApprovalRequestV1 = {
        ...approved,
        status: 'failed',
        updatedAtMs: executedAtMs,
        execution: {
          executedAtMs,
          ok: false,
          errorCode: 'approval_stale',
          error: 'approval_stale',
        },
      };
      const persistenceFailure = await persist(terminal);
      return persistenceFailure ?? targetActionReplayFailure('approval_stale');
    }

    const executionClaim: TargetActionApprovalRequestV1 = {
      ...approved,
      status: 'executing',
      updatedAtMs: nextTimestamp(approved),
    };
    const claimFailure = await persist(executionClaim);
    if (claimFailure) {
      let persisted: TargetActionApprovalRequestV1 | null;
      try {
        persisted = await targetActionApprovals.targetActionApprovalsGet({ artifactId });
      } catch {
        return targetActionReplayFailure('approval_unavailable');
      }
      if (persisted && (persisted.status === 'executed' || persisted.status === 'failed')
        && persisted.decision?.kind === 'approve') {
        return buildTargetActionApprovalDecisionResult(persisted);
      }
      if (persisted?.status === 'executing' && persisted.decision?.kind === 'approve') {
        return targetActionReplayFailure('approval_execution_outcome_unknown');
      }
      return claimFailure;
    }
    approved = executionClaim;

    const operationCredentialUses: ActionOperationCredentialUseV1[] = [];
    let observingCredentialUse = true;
    const recordOperationCredentialUse = (use: ActionOperationCredentialUseV1) => {
      if (!observingCredentialUse) return;
      const parsed = ActionOperationCredentialUseV1Schema.safeParse(use);
      if (!parsed.success || operationCredentialUses.some(existing => sameStrictJsonValue(existing, parsed.data))) return;
      operationCredentialUses.push(parsed.data);
      context?.recordOperationCredentialUse?.(parsed.data);
    };
    let executionResult: ActionExecuteResult | undefined;
    let externalActionContext: PluginExternalActionContext | undefined;
    if (executionResult === undefined && origin.externalActionExecutionAuthorization !== undefined) {
      const installationIdentity = readInstallationIdentity();
      if (
        !installationIdentity
        || !origin.serverIdentityId
        || !origin.accountId
        || ('grant' in origin.externalActionExecutionAuthorization.binding && (!origin.principalId || !origin.credentialId))
        || !origin.target
      ) {
        executionResult = targetActionReplayFailure('approval_stale');
      } else {
        const authorization = origin.externalActionExecutionAuthorization;
        const externalActionCredential = 'grant' in authorization.binding && origin.principalId && origin.credentialId ? Object.freeze({
          accountId: origin.accountId,
          principalId: origin.principalId,
          credentialId: origin.credentialId,
          grant: authorization.binding.grant,
        }) : undefined;
        const authorizedTarget = Object.freeze({ ...authorization.binding.target });
        const externalActionExecutionAuthorization = Object.freeze({
          ...authorization,
          binding: Object.freeze({
            ...authorization.binding,
            target: authorizedTarget,
          }),
        });
        const externalActionTarget = Object.freeze({ ...origin.target });
        externalActionContext = Object.freeze<PluginExternalActionContext>({
          authority: 'account_automation',
          serverId: origin.serverId,
          serverIdentityId: origin.serverIdentityId,
          actionRequestId: origin.requestId,
          ...(externalActionCredential ? { externalActionCredential } : {}),
          externalActionExecutionAuthorization,
          externalActionTarget,
          signExternalActionApprovalInput: ({ actionId, input: actionInput, target, requesterConfirmation, sessionTargetsV1 }) =>
            signExternalActionApprovalInputV1({
              authorizationToken: externalActionExecutionAuthorization.token,
              actionId,
              target,
              input: actionInput,
              privateKey: installationIdentity.privateKey,
              ...(requesterConfirmation ? { requesterConfirmation } : {}),
              ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}),
            }),
        });
      }
    }
    const invocationSignal = signal ?? new AbortController().signal;
    if (executionResult === undefined) {
      try {
        invocationSignal.throwIfAborted();
        const lease = await acquireRuntimeRegistryLease({
          happyHomeDir: configuration.happyHomeDir,
        });
        try {
          invocationSignal.throwIfAborted();
          const attempt = await executeContributedAction({
            runtimeRegistry: lease.registry,
            actionId: buildQualifiedPluginContributionKey(action),
            input: approved.input,
            expectedApprovalReplayPlacement: replayPlacement,
            // Replay fingerprints the admitting authority, not the decider's
            // authority or the dispatcher's absent-context automation default.
            approvalContext: { authority: origin.authority, runtimeAccountId: origin.accountId,
              recordOperationCredentialUse,
              serverId: origin.serverId,
              ...(replayPlacement.defaultSessionId === undefined ? {} : { defaultSessionId: replayPlacement.defaultSessionId }),
              actionRequestAttributionV1: origin.actionRequestAttributionV1,
              actionCaller: origin.caller,
              callerPermissionMode: origin.callerPermissionMode,
              causalPermissionAuthority: origin.causalPermissionAuthority,
              sessionInputSource: origin.sessionInputSource,
              sessionAgentSpawnPolicyV1: origin.sessionAgentSpawnPolicyV1,
              workspaceWrites: sourceSession?.workspaceWrites,
              ...(externalActionContext ?? {}),
            },
            approvalExecutionOrigin: origin,
            requestCurrentIntent: async (currentIntent) => (
              targetActionApprovalMatchesCurrentIntent(approved, {
                ...currentIntent,
                executionOriginV1: origin,
              })
                ? { status: 'approved', fingerprint: currentIntent.fingerprint, artifactId }
                : { status: 'unavailable', code: 'plugin_action_current_intent_mismatch' }
            ),
            context: {
              surface: requestedSurface,
              invocationSurface: requestedSurface,
              initiatingActionCaller: origin.caller,
              ...(externalActionContext ? { externalActionContext } : {}),
              ...(replayPlacement.defaultSessionId === undefined
                ? {}
                : { defaultSessionId: replayPlacement.defaultSessionId }),
              signal: invocationSignal,
              ...(approved.requesterConfirmation ? { beforeHandlerInvocation: async () => {
                const admission = await admitRequester(approved);
                if (!admission.ok) throw new PluginError({
                  code: admission.errorCode, message: admission.error,
                });
                if (!await isRequesterSourceCurrent(approved)) throw new PluginError({ code: 'approval_stale', message: 'approval_stale' });
              } } : {}),
            },
          });
          if (!attempt.matched) {
            executionResult = targetActionReplayFailure('contributed_action_unavailable');
          } else if (attempt.result.ok && attempt.result.deferredApprovalArtifactId !== undefined) {
            executionResult = targetActionReplayFailure('plugin_action_current_intent_mismatch');
          } else {
            executionResult = attempt.result;
          }
        } finally {
          await lease.release();
        }
      } catch {
        executionResult = targetActionReplayFailure('plugin_action_execution_failed');
      }
    }
    observingCredentialUse = false;

    const executedAtMs = nextTimestamp(approved);
    const terminal: TargetActionApprovalRequestV1 = executionResult.ok
      ? {
          ...approved,
          status: 'executed',
          updatedAtMs: executedAtMs,
          execution: { executedAtMs, ok: true, result: executionResult.result },
        }
      : {
          ...approved,
          status: 'failed',
          updatedAtMs: executedAtMs,
          execution: {
            executedAtMs,
            ok: false,
            errorCode: executionResult.errorCode,
            error: executionResult.error,
          },
        };
    if (operationCredentialUses.length && terminal.execution) {
      terminal.execution = { ...terminal.execution, effectAttempted: true, operationCredentialUses };
    }
    const persistenceFailure = await persist(terminal);
    // Once the durable claim is admitted, a lost terminal write leaves later
    // callers unable to distinguish an in-flight effect from an unknown one.
    if (persistenceFailure) return targetActionReplayFailure('approval_execution_outcome_unknown');
    return executionResult.ok
      ? buildTargetActionApprovalDecisionResult(terminal)
      : operationCredentialUses.length ? { ...executionResult, operationCredentialUses } : executionResult;
  };

  return async ({ artifactId: rawArtifactId, decision, signal, callerGrant, context }) => {
    const artifactId = rawArtifactId.trim();
    if (!artifactId) return null;
    signal?.throwIfAborted();
    return await replayArtifact({ artifactId, decision, ...(signal ? { signal } : {}), ...(callerGrant ? { callerGrant } : {}), ...(context ? { context } : {}) });
  };
}

/**
 * Reads the current committed runtime's contributed Action declarations for
 * the canonical `action.spec.search` and `action.spec.get` owner. The lease
 * is released after the immutable declaration snapshot is copied; execution
 * keeps its own currentness checks through the committed invoker above.
 */
export function createDaemonExternalActionContributedDefinitionLister(input: Readonly<{
  tryAcquireRuntimeRegistryLease?: typeof tryAcquireAuthoritativePluginRuntimeRegistryLease;
}> = {}): NonNullable<ActionExecutorDeps['listContributedActionDefinitions']> {
  const tryAcquireRuntimeRegistryLease = input.tryAcquireRuntimeRegistryLease
    ?? tryAcquireAuthoritativePluginRuntimeRegistryLease;

  return createCommittedContributedActionDefinitionLister({
    tryAcquireRuntimeRegistryLease: () => tryAcquireRuntimeRegistryLease({
      happyHomeDir: configuration.happyHomeDir,
    }),
    onLeaseReleaseError: () => logger.debug(
      '[ExternalAction] Contributed Action discovery registry lease release failed (non-fatal)',
      { error: 'external_action_catalog_registry_lease_release_failed' },
    ),
  });
}
