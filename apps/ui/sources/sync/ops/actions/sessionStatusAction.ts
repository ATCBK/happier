import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { projectSessionSummaryV1, readSystemSessionMetadataFromMetadata } from '@happier-dev/protocol/sessions/control/contract';
import { isSessionReadinessNativeSelectionV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import { resolveAmbientProviderConnectionForModelIntent, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { isDataKeyAuthCredentials, isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { readMachineAgentsForScope, refreshMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { buildSessionReadinessViewModel } from '@/components/sessions/model/sessionReadinessViewModel';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTargetKey } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { resolveDisplayIdentityForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { storage } from '@/sync/domains/state/storage';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Status stays usable without a running Agent; detail reads are explicit and use the existing inventory. */
export function createUiSessionStatusGet(account: LazyActionAccountContext | null | undefined,
  options?: Readonly<{ refreshReadiness?: boolean }>): NonNullable<ActionExecutorDeps['sessionStatusGet']> {
  return async ({ sessionId, readiness, serverId, signal }) => {
    if (!account) return { ok: false, code: 'not_authenticated' };
    account.assertCurrent();
    signal?.throwIfAborted();
    if (serverId && serverId !== account.serverId) return { ok: false, code: 'server_scope_mismatch' };
    const { session } = await runWithServerRequestAuthorityForServerAccountScope({ scope: account.accountLifetime.scope,
      activeRequest: account.request }, authority => readSessionSnapshotForAuthority({ authority, sessionId,
        isCurrent: account.accountLifetime.isCurrent }));
    account.assertCurrent();
    signal?.throwIfAborted();
    const access = session.access;
    const invocation = access ? { v: 1 as const, level: access.level, sources: access.sources ?? [], capabilities: access.capabilities } : null;
    const metadata = readSessionOwnerMetadataView(session);
    const presentationMetadata = metadata ?? session.metadata;
    const system = presentationMetadata ? readSystemSessionMetadataFromMetadata({ metadata: presentationMetadata }) : null;
    const summary = projectSessionSummaryV1({ row: { ...session, ...(invocation ? { effectiveAccess: invocation } : {}) },
      metadata: presentationMetadata, permissionMode: resolvePermissionIntentFromSessionMetadata(presentationMetadata)?.intent,
      ...(system ? { systemPurpose: system.key ?? null } : {}),
      encryption: isDataKeyAuthCredentials(account.credentials) ? { type: 'dataKey' }
        : isLegacyAuthCredentials(account.credentials) ? { type: 'legacy' } : null });
    const result = { ok: true as const, session: summary, awareness: projectUiSessionAwareness(session, Date.now()) };
    if (readiness !== true) return result;
    // Diagnostics keep stable attribution when control admission correctly refuses an offline Machine.
    const target = resolveDisplayIdentityForSessionFromState({ state: storage.getState(),
      serverId: account.serverId, sessionId, metadata, preferProvidedMetadata: true });
    const selectedMachineId = target.machineId || null;
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    const definitionId = readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId;
    if (selectedMachineId && agentId && invocation?.capabilities.submitAgentInput) {
      try {
        await refreshMachineAgents({ serverId: account.serverId, machineId: selectedMachineId,
          accountLifetime: account.accountLifetime, agentId, ...(definitionId ? { definitionId } : {}),
          ...(options?.refreshReadiness ? { force: true } : {}), ...(signal ? { signal } : {}) });
      } catch { signal?.throwIfAborted(); }
      account.assertCurrent();
      signal?.throwIfAborted();
    }
    const inventory = selectedMachineId ? readMachineAgentsForScope(account.accountLifetime, selectedMachineId) : null;
    const agent = inventory?.agents.find(agent => agent.agentId === agentId && agent.definitionId === definitionId) ?? null;
    const targetKey = resolveSessionActionDefaultTargetKey(resolveSessionActionDefaultBackend({ session }));
    const provider = targetKey ? resolveAmbientProviderConnectionForModelIntent({ metadata, agentTargetKey: targetKey, sessionActive: session.active }) : null;
    const native = isSessionReadinessNativeSelectionV1({ metadata,
      providerConnectionId: provider?.status === 'resolved' ? provider.providerConnectionId : undefined });
    const machine = selectedMachineId ? resolveServerScopedMachine(storage.getState(), account.serverId, selectedMachineId) : null;
    const model = buildSessionReadinessViewModel({ configured: true, machine: { scope: account.accountLifetime.scope,
      selectedMachineId, machine, requireExactSpawnReadiness: true,
      keyAvailable: inventory?.status === 'ready' ? true : 'unknown', rpcAvailable: inventory?.status === 'ready' ? true : 'unknown' },
      agent, selection: native ? { credentialBindings: null } : null,
      inventory: inventory ?? { status: 'idle', lastCheckedAt: null }, invocation,
      mayRepairAgent: machine?.access?.role === 'manage' && machine.access.accessState === 'ready' });
    return { ...result, readiness: model.readiness };
  };
}
