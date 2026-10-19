import {
  DaemonProviderModelProjectionResponseV1Schema,
} from '@happier-dev/protocol/rpc/providers';
import { randomUUID } from 'node:crypto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createProviderErrorV1, providerErrorFromRpcFailure } from '@happier-dev/protocol/providers/errors';
import type { StoredCredentials } from '@/persistence';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ProviderRuntimeModelProjectionReader } from '../spawn/runtimeCatalog';
import { logger } from '@/ui/logger';

/** Transport only: the caller owns Home/Account admission and the target owns
 * source projection, compatibility, probing and managed consumer custody. */
export function createAccountScopedProviderModelProjectionReader(input: Readonly<{
  serverUrl: string;
  readCredentials(): Promise<StoredCredentials | null>;
  readAccountSettingsSnapshot(): Promise<ActiveAccountSettingsSnapshot | null>;
  isCurrent(): boolean | Promise<boolean>;
}>): ProviderRuntimeModelProjectionReader {
  return async (request, signal) => {
    const context = {
      machineId: request.machineId,
      ...(request.providerConnection ? { connectionId: request.providerConnection.connectionId } : {}),
    };
    const unavailable = () => ({
      status: 'error' as const, error: createProviderErrorV1('provider_authorization_changed', context),
    });
    const projectionId = randomUUID();
    let phase: 'account_before' | 'machine_rpc' | 'account_after' | 'response' = 'account_before';
    let phaseStartedAt = performance.now();
    const record = (status: 'started' | 'completed' | 'failed', reason?: string) => logger.infoFile('[PROVIDER] Remote model projection phase', {
      projectionId, ...context, phase, status, durationMs: Math.round(performance.now() - phaseStartedAt),
      ...(reason ? { reason } : {}),
    });
    const nextPhase = (next: typeof phase) => {
      record('completed');
      phase = next;
      phaseStartedAt = performance.now();
      record('started');
    };
    const readCurrent = async () => {
      signal.throwIfAborted();
      const [credentials, snapshot, current] = await Promise.all([
        input.readCredentials(), input.readAccountSettingsSnapshot(), input.isCurrent(),
      ]);
      signal.throwIfAborted();
      return current && credentials && snapshot?.scopeKey === resolveAccountSettingsScopeKey(credentials)
        ? { credentials, scopeKey: snapshot.scopeKey } : null;
    };
    record('started');
    try {
      const admitted = await readCurrent();
      if (!admitted) { record('failed', 'provider_authorization_changed'); return unavailable(); }
      nextPhase('machine_rpc');
      const value = await callExactMachineRpc({
        credentials: admitted.credentials, serverUrl: input.serverUrl,
        machineId: request.machineId, requireCurrentMachine: true, requiredMachineKind: 'persistent',
        method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, request, signal,
        // The caller's admitted operation owns acknowledgement lifetime. The
        // existing transport retains its own connection/setup budgets.
        timeoutMs: null,
      });
      nextPhase('account_after');
      const current = await readCurrent();
      if (!current || current.scopeKey !== admitted.scopeKey
        || current.credentials.token !== admitted.credentials.token) {
        record('failed', 'provider_authorization_changed'); return unavailable();
      }
      nextPhase('response');
      const parsed = DaemonProviderModelProjectionResponseV1Schema.safeParse(value);
      if (!parsed.success || parsed.data.status === 'success' && parsed.data.agentTargetKey !== request.agentTargetKey) {
        record('failed', 'provider_rpc_response_invalid');
        return { status: 'error', error: createProviderErrorV1('provider_rpc_response_invalid', context) };
      }
      record(parsed.data.status === 'error' ? 'failed' : 'completed',
        parsed.data.status === 'error' ? parsed.data.error.code : undefined);
      return parsed.data;
    } catch (error) {
      const refusal = providerErrorFromRpcFailure(error, context);
      record('failed', signal.aborted ? 'cancelled' : refusal.code);
      signal.throwIfAborted();
      return { status: 'error', error: refusal };
    }
  };
}
