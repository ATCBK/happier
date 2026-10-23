import { join } from 'node:path';

import type { StoredCredentials } from '@/persistence';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { openTeamCredentialProviderBroker } from '@/api/client/providerBrokerApi';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
  openSessionTeamCredentialProviderBinding,
  type SessionTeamCredentialDirectOpen,
  type SessionTeamCredentialProviderBinding,
} from '@/providers/broker/sessionTeamCredentialProviderBinding';
import {
  readSessionTeamCredentialProviderModels,
  SessionTeamCredentialLaunchUnavailableError,
} from '@/session/services/sessionTeamCredentialLaunch';
import { createProviderBrokerMachineCarrierTunnelOpen } from '../peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import type { DaemonMachineIrohRuntime } from '../peer/iroh/daemonMachineIrohRuntime';
import type { startDaemonSessionControlRuntime } from '../startup/startDaemonSessionControlRuntime';

type BindingOpen = NonNullable<Parameters<typeof startDaemonSessionControlRuntime>[0]['openTeamCredentialProviderBinding']>;
type BindingOpenInput = Parameters<BindingOpen>[0];

/** Composition used by both Session and independently selected Run bindings. */
export async function openDaemonSessionTeamCredentialProviderBinding(input: BindingOpenInput, dependencies: Readonly<{
  machineId: string;
  accountId: string;
  serverId: string;
  serverHttpBaseUrl: string;
  credentials: StoredCredentials;
  happyHomeDir: string;
  controller: PluginReloadController;
  runtime?: DaemonMachineIrohRuntime | null;
  resolveTrustRoots: Parameters<typeof createProviderBrokerMachineCarrierTunnelOpen>[0]['resolveTrustRoots'];
  openTeamDirect: SessionTeamCredentialDirectOpen;
}>): Promise<SessionTeamCredentialProviderBinding> {
  // The dispatcher supplies the admitted Session/Run Account. Changing only
  // its Home URL cannot change the daemon's captured bearer or tunnel identity.
  const requester = input.providerSettingsOperationContext;
  if (requester && !await requester.isCurrent(input.signal)) {
    throw new SessionTeamCredentialLaunchUnavailableError();
  }
  const accountId = requester ? readAccountIdFromToken(requester.credentials.token) : dependencies.accountId;
  if (!accountId) throw new SessionTeamCredentialLaunchUnavailableError();
  const credentials = requester?.credentials ?? dependencies.credentials;
  const serverHttpBaseUrl = requester?.serverHttpBaseUrl ?? dependencies.serverHttpBaseUrl;
  const homeDomainAction = createAccountServerActionDeps({ token: credentials.token, credentials,
    serverId: dependencies.serverId, serverHttpBaseUrl }).homeDomainAction;
  if (!homeDomainAction) throw new SessionTeamCredentialLaunchUnavailableError();
  const openTunnel = dependencies.runtime
    ? createProviderBrokerMachineCarrierTunnelOpen({ accountId,
        localMachineId: dependencies.machineId, runtime: dependencies.runtime,
        resolveTrustRoots: dependencies.resolveTrustRoots,
        beginSessionApplicationRequest: sessionId => sessionId === input.sessionId ? input.beginBrokerRequest?.() : undefined })
    : undefined;
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
    happyHomeDir: dependencies.happyHomeDir, controller: dependencies.controller,
  });
  try {
    const opened = await openSessionTeamCredentialProviderBinding({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.consumer ? { consumer: input.consumer } : {}),
      machineId: dependencies.machineId, agentId: input.agentId,
      agentTargetKey: input.agentTargetKey, modelId: input.modelId,
      binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: input.resourceId,
        expectedResourceRevision: input.expectedResourceRevision,
        deliveryMode: input.deliveryMode, teamId: input.teamId },
      lease, materializationBaseDir: join(dependencies.happyHomeDir, 'providers', 'materialized'),
      signal: input.signal, providerSettingsOperationContext: input.providerSettingsOperationContext,
      readCatalog: signal => readSessionTeamCredentialProviderModels({
        homeDomainAction, lease, agentId: input.agentId,
        agentTargetKey: input.agentTargetKey, resourceId: input.resourceId, teamId: input.teamId, signal,
      }),
      ...(openTunnel ? { openBroker: (request, signal) => openTeamCredentialProviderBroker({
        token: credentials.token, serverBaseUrl: serverHttpBaseUrl, request, signal }), openTunnel } : {}),
      openTeamDirect: dependencies.openTeamDirect,
    });
    if (!opened) throw new SessionTeamCredentialLaunchUnavailableError();
    return opened;
  } finally { await lease.release(); }
}
