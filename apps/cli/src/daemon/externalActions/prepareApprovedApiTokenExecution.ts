import type { ActionExecutorDeps, ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';
import { AccountApiTokensCreateActionInputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { resolveExternalActionRootInvocationAuthority, resolveExternalActionAccountInvocationSurface } from '@/api/externalActionExecutionAuthorization';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';

/** Transfers only a reviewed token effect to the live requester, retaining the human's admitted custody. */
export function createApprovedApiTokenExecutionPreparer(input: Readonly<{
  requester: RequesterAccountActionContext;
  artifactId: string;
  authority: ActionExecutorContext['authority'];
  surface?: ActionExecutorContext['surface'];
  signal?: AbortSignal;
  execute: NonNullable<ActionExecutorDeps['accountApiTokensCreateAction']>;
}>): NonNullable<ActionExecutorDeps['prepareApprovedApiTokenExecution']> {
  return async ({ artifactId, request }) => {
    const root = input.requester.authorization;
    if (input.authority !== 'present_user' || input.signal?.aborted || artifactId !== input.artifactId
      || root.binding.actionId !== 'approval.request.decide' || !('authentication' in root.binding)
      || root.binding.sessionActionOrigin || root.binding.workflowActionOrigin
      || resolveExternalActionRootInvocationAuthority(root) !== 'present_user'
      || request.v !== 2 || request.actionId !== 'account.apiTokens.create' || request.status !== 'approved'
      || request.decision?.kind !== 'approve' || request.approval?.flow !== 'blocking'
      || request.executionOriginV1.accountId !== root.binding.accountId
      || request.executionOriginV1.serverIdentityId !== root.binding.serverIdentityId
      || request.executionOriginV1.machineId !== root.binding.machineId
      || !await input.requester.isCurrent()) return null;
    const actionId = 'account.apiTokens.create';
    const surface = resolveExternalActionAccountInvocationSurface(root.binding.authentication.kind, input.surface);
    if (surface !== 'ui' && surface !== 'cli') return null;
    const requestId = request.executionOriginV1.requestId;
    const inputDigest = computeActionInputApprovalDigestV1(actionId, request.actionArgs);
    const release = input.requester.retain();
    let retired = false;
    let result: Promise<ActionExecuteResult> | undefined;
    let complete!: () => void;
    const settled = new Promise<void>(resolve => { complete = resolve; });
    const dispose = async () => {
      if (retired) return;
      retired = true;
      input.signal?.removeEventListener('abort', abort);
      try { await release(); } finally { complete(); }
    };
    const abort = () => { void dispose(); };
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) await dispose();
    return Object.freeze({ settled, dispose, execute: (value: unknown, signal?: AbortSignal): Promise<ActionExecuteResult> => {
      if (result) return Promise.resolve({ ok: false, errorCode: 'approval_stale', error: 'approval_stale' });
      result = (async (): Promise<ActionExecuteResult> => {
        const operationSignal = signal && input.signal && signal !== input.signal
          ? AbortSignal.any([signal, input.signal]) : signal ?? input.signal;
        if (retired || signal?.aborted || input.signal?.aborted
          || computeActionInputApprovalDigestV1(actionId, value) !== inputDigest
          || !await input.requester.isCurrent()) return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        if (retired || operationSignal?.aborted) return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
        const context: ActionExecutorContext = { surface,
          authority: 'present_user', actionCaller: { kind: 'host' },
          serverId: request.executionOriginV1.serverId, serverIdentityId: root.binding.serverIdentityId,
          runtimeAccountId: root.binding.accountId, actionRequestId: requestId, bypassApprovals: true,
          presentUserApproval: { artifactId, actionId, requestId, inputDigest },
          ...(operationSignal ? { signal: operationSignal } : {}) };
        const effect = await input.execute({ input: AccountApiTokensCreateActionInputV1Schema.parse(value), context,
          ...(operationSignal ? { signal: operationSignal } : {}) });
        return 'ok' in effect ? effect : { ok: true, result: effect };
      })();
      return result;
    } });
  };
}
