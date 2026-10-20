import { PrivateSecretContinuationV1Schema, type PrivateSecretContinuationV1 } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';
import { SecretFillSettlementV1Schema, type SecretFillSettlementV1 } from '@happier-dev/protocol/computer/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { captureLazyActionAccountContext } from './actionAccountContext';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';

export type ConfidentialSecretContinuationResult = Readonly<{
  fill: SecretFillSettlementV1;
  remember: 'not_requested' | 'saved' | 'failed' | 'unknown' | 'canceled';
}>;

/** The human prompt owns this mutable operand and clears its input when this returns. */
export async function continueConfidentialSecretFill(input: Readonly<{
  continuation: PrivateSecretContinuationV1;
  scope: AccountSettingsScope;
  /** Immutable reviewed Home identity, never inferred from a local profile alias. */
  expectedServerIdentityId?: string | null;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  /** Omitted by default. Never inferred from the fill choice. */
  remember?: Readonly<{ name: string }>;
}>): Promise<ConfidentialSecretContinuationResult> {
  let continuation: PrivateSecretContinuationV1 | null = null;
  let dispatched = false;
  let remember: ConfidentialSecretContinuationResult['remember'] = 'not_requested';
  let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
  try {
    const parsed = PrivateSecretContinuationV1Schema.safeParse(input.continuation);
    if (!parsed.success) {
      return { fill: { status: 'refused', code: 'approval_changed' }, remember };
    }
    continuation = parsed.data;
    if (input.signal?.aborted || !input.isCurrent()) return { fill: { status: 'canceled', code: 'canceled' }, remember };
    try {
      account = await captureLazyActionAccountContext(input.scope.serverId, input.signal);
      const expectedIdentity = input.expectedServerIdentityId?.trim() || null;
      if (account.accountId !== input.scope.accountId || account.serverId !== input.scope.serverId
        || (expectedIdentity && account.serverIdentityId !== expectedIdentity)
        || (continuation.request.serverId !== input.scope.serverId
          && (!expectedIdentity || account.serverIdentityId !== expectedIdentity))) {
        return { fill: { status: 'refused', code: 'approval_changed' }, remember };
      }
      const encryption = await account.resolveAccountEncryption();
      account.assertCurrent();
      if (encryption.accountMode !== continuation.accountEncryptionMode) {
        return { fill: { status: 'refused', code: 'approval_changed' }, remember };
      }
      if (!input.isCurrent()) return { fill: { status: 'canceled', code: 'canceled' }, remember };
    } catch {
      return { fill: input.signal?.aborted || !input.isCurrent()
        ? { status: 'canceled', code: 'canceled' } : { status: 'refused', code: 'target_unavailable' }, remember };
    }
    let fill: SecretFillSettlementV1;
    try {
      const result = await machineRpcWithServerScope<unknown, PrivateSecretContinuationV1>({
        machineId: continuation.request.machineId, serverId: input.scope.serverId,
        accountId: input.scope.accountId, method: RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE,
        payload: continuation, signal: input.signal, onDispatched: () => { dispatched = true; },
        // Setup stays bounded; admitted native delivery follows the human caller's lifetime.
        operationTimeoutMs: null,
        ...(continuation.accountEncryptionMode === 'e2ee' ? { requireEncryptedPayload: true as const } : {}),
      });
      const settlement = SecretFillSettlementV1Schema.safeParse(result);
      fill = settlement.success ? settlement.data : { status: 'unknown', code: 'delivery_unknown' };
    } catch (error) {
      fill = dispatched || readRpcRequestDisposition(error) === 'outcomeUnknown'
        ? { status: 'unknown', code: 'delivery_unknown' }
        : input.signal?.aborted ? { status: 'canceled', code: 'canceled' }
          : { status: 'refused', code: 'target_unavailable' };
    }
    if (input.remember && continuation.choice.kind === 'once' && fill.status === 'filled') {
      if (input.signal?.aborted || !input.isCurrent()) remember = 'canceled';
      else {
        remember = 'failed';
        const name = input.remember.name.trim();
        if (name) {
          try {
            const created = await runTeamAction({
              scope: input.scope,
              actionId: 'secrets.create',
              input: { name, kind: 'apiKey', value: continuation.choice.value },
              parse: value => PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(value),
              approval: 'surface_confirmed',
              signal: input.signal,
            });
            remember = created.kind === 'succeeded' ? 'saved'
              : created.failure.kind === 'outcome_unknown' ? 'unknown' : 'failed';
          } catch (error) {
            remember = input.signal?.aborted || !input.isCurrent() ? 'canceled'
              : error !== null && typeof error === 'object'
                && Reflect.get(error, 'code') === 'outcome_unknown' ? 'unknown' : 'failed';
          }
        }
      }
    }
    return { fill, remember };
  } finally {
    account?.dispose();
    if (continuation?.choice.kind === 'once') continuation.choice.value = '';
    if (input.continuation.choice.kind === 'once') input.continuation.choice.value = '';
    continuation = null;
  }
}
