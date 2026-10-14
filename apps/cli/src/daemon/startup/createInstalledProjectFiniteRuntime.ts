import type { ApiMachineClientLifecycleDependencies } from '@/api/apiMachine';
import type { ApiClient } from '@/api/api';
import type { StoredCredentials } from '@/persistence';
import { readStoredCredentialsForServerId, sameStoredCredentials } from '@/persistence';
import { readInstallationIdentityIfExistsSync } from '../identity/store';
import { resolveAdmittedRequesterAccountReadRuntime, readRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionProjection';
import { readProjectFiniteIngressRefusal, type ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { createProjectFiniteSourceManifestInspector } from './createDaemonMachineBootstrapRuntime';
import { createWorkspaceSyncWorkerPreparation } from '@/workspaces/sync/workspaceSyncPreparation';
import { createAccountServerWorkspaceWorkerPreferenceClient } from '@/api/workspaces/workspaceWorkerPreferences';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import type { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

/** Installed composition shared by the daemon and its real ingress harness. */
export function createInstalledProjectFiniteRuntime(params: Readonly<{
  api: Pick<ApiClient, 'getMachine'>;
  credentials: StoredCredentials;
  externalActionAccountId: string | null;
  finiteServerId: string;
  finiteServerHttpBaseUrl: string;
  registeredMachineId: string;
  admission: ProjectFiniteActionRuntime['workerAdmission'];
  nativeIo: ReturnType<typeof createProjectNativeIo>;
  plugins?: ProjectFiniteActionRuntime['plugins'];
  successHomeDir: string;
  isCurrent(): Promise<boolean>;
  prepareBetween: WorkspaceSyncHandoffAdapter['prepareBetween'];
  resolveCurrentMachineExecutionOriginContext(signal?: AbortSignal): Promise<CurrentMachineExecutionOriginContext | null>;
}>): NonNullable<ApiMachineClientLifecycleDependencies['createProjectFiniteRuntime']> {
  const { api, credentials, externalActionAccountId, finiteServerId, finiteServerHttpBaseUrl,
    registeredMachineId, admission, isCurrent, resolveCurrentMachineExecutionOriginContext } = params;
  return async (ports, ingress) => {
    if (!externalActionAccountId || !await isCurrent()) return null;
    const installationId = readInstallationIdentityIfExistsSync()?.installationId;
    const requester = ingress.callerInputAuthorization && installationId
      ? await resolveAdmittedRequesterAccountReadRuntime({ ingress, serverId: finiteServerId,
        machineId: registeredMachineId, installationId, isInstalledCurrent: isCurrent }) : null;
    if (ingress.callerInputAuthorization && !requester || !requester && readProjectFiniteIngressRefusal(ingress)) return null;
    const currentCredentials = requester ? null : await readStoredCredentialsForServerId(finiteServerId).catch(() => null);
    if (!requester && (!currentCredentials || !sameStoredCredentials(credentials, currentCredentials)) || !await isCurrent()) return null;
    const runtimeCurrent = requester?.isCurrent ?? isCurrent;
    const requesterContext = requester ? readRequesterAccountActionContext(requester.accountAuthorization) : null;
    const io = params.nativeIo;
    const accountAccess = requester ?? (currentCredentials ? { serverId: finiteServerId, machineId: registeredMachineId,
      accountId: externalActionAccountId, credentials: currentCredentials, serverHttpBaseUrl: finiteServerHttpBaseUrl } : null);
    if (!accountAccess) return null;
    return { ...ports, ...accountAccess, workerAdmission: admission, isCurrent: runtimeCurrent,
      nativeIo: io.commandIo, environmentIo: io.environmentIo,
      ...(params.plugins ? { plugins: { async resolveProjectNativeAdapter(reference, role) {
        if (!await runtimeCurrent()) return { kind: 'refused', code: 'native_adapter_retired' };
        const selected = await params.plugins!.resolveProjectNativeAdapter(reference, role);
        return await runtimeCurrent() ? selected : { kind: 'refused', code: 'native_adapter_retired' };
      } } } : {}),
      successHomeDir: params.successHomeDir,
      ...(currentCredentials ? { inspectSourceProjectManifest: createProjectFiniteSourceManifestInspector({ api,
        credentials: currentCredentials, serverId: finiteServerId, serverHttpBaseUrl: finiteServerHttpBaseUrl,
        accountId: externalActionAccountId, ingress, isCurrent }),
        ...createWorkspaceSyncWorkerPreparation({ serverId: finiteServerId,
        serverHttpBaseUrl: finiteServerHttpBaseUrl, targetMachineId: registeredMachineId,
        credentials: currentCredentials, isCurrent,
        prepareBetween: (request, signal) => params.prepareBetween(request, signal) }) } : {}),
      resolveWorkspaceExecutionConfig: async (context, currentIngress, actionId) => {
        const preferenceCredentials = requesterContext?.credentials ?? currentCredentials;
        if (!preferenceCredentials || !await runtimeCurrent()) return null;
        const origin = await resolveCurrentMachineExecutionOriginContext(currentIngress.signal);
        if (!origin || origin.machineId !== registeredMachineId || !await isCurrent()) return null;
        const authorization = currentIngress.callerInputAuthorization;
        const requestContext = { ...context, ...(authorization ? {
          externalActionExecutionAuthorization: authorization,
          externalActionTarget: authorization.binding.target,
        } : {}) };
        const installation = readInstallationIdentityIfExistsSync();
        return await createAccountServerWorkspaceWorkerPreferenceClient({
          token: preferenceCredentials.token, credentials: preferenceCredentials,
          serverHttpBaseUrl: accountAccess.serverHttpBaseUrl, signal: currentIngress.signal,
          context: requestContext, actionId, isCredentialCurrent: runtimeCurrent,
          ...(requesterContext ? { operationContext: requesterContext.savedSecretOperationContext } : {}),
          resolveRequestHeaders: async request => {
            if (requester) return await requester.accountAuthorization.requesterHttpProjection!.createRequestHeaders({
              effectActionId: request.effectActionId, method: request.method, path: request.path,
              ...(request.body === undefined ? {} : { body: request.body }), signal: currentIngress.signal,
            });
            const result = resolveExternalActionServerRequestHeaders({ ...request,
              daemonToken: preferenceCredentials.token, serverIdentityId: origin.serverIdentityId,
              ...(installation ? { privateKey: installation.privateKey, installationId: installation.installationId } : {}),
            });
            return result.ok ? result.headers : null;
          },
        });
      },
    };
  };
}

