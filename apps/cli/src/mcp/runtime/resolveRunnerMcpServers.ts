import type { McpServerConfig } from '@/agent';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import type { ExecutionRunOccurrenceWitnessV1 } from '@/agent/runtime/bridges/executionRun/runOccurrenceWitness';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { SESSION_RUN_PROMPT_READ_ACTION_IDS_V1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { SessionCapabilityNoticeV1Schema, SESSION_CAPABILITY_NOTICE_SIDECAR_KEY } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import type { AccountSettings, ActionExecutorDeps, SessionRunPromptReadActionIdV1 } from '@happier-dev/protocol';
import type { UsageMcpBindingIdentity } from '@happier-dev/protocol/usage/coach/usageMcpBindingUsage';

import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '../servers/readMcpServersSettingsFromAccountSettings';
import { resolveSessionCapabilitiesForDirectory } from '../servers/resolveSessionCapabilitiesForDirectory';
import {
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/valueRefs/resolveValueRefPlaintext';
import { listSelectedMcpSharedSecretReferences, materializeMcpServerConfigRecord } from '../servers/materializeMcpServerConfigRecord';
import { mergeWithBuiltInHappierMcpServer } from '../servers/mergeWithBuiltInHappierMcpServer';
import {
  createSavedSecretMaterializerV1,
  createSavedSecretMaterializerFromSnapshotV1,
  SavedSecretResolutionError,
  type SavedSecretCatalogResourceInputV1,
} from '@/settings/secrets/savedSecretCatalog';
import {
  refreshSavedSecretCatalogForOperation,
  savedSecretOperationAdmissionStatus,
  SavedSecretOperationAdmissionError,
  createInvocationSavedSecretOperationContextV1,
  type SavedSecretOperationContextV1,
} from '@/settings/secrets/hydrateSavedSecretCatalog';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import type { HappyMcpSessionClient } from '../startHappyServer';
import { SessionAttestedContextV1Schema } from '@happier-dev/protocol';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { randomUUID } from 'node:crypto';
import type { McpRequestAuthCapability } from './mcpRequestAuth';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';

/**
 * The exact Session-owned Run whose authority this MCP profile serves.
 *
 * `readCurrentRunOccurrence` projects the bridge's canonical controller entry,
 * deliberately read per request: the built-in Happier server is rebuilt for each
 * MCP call, so a resumed or replaced controller occurrence must stop supplying
 * authority without rebuilding the server.
 */
export type ExecutionRunMcpBinding = Readonly<{
  runId: string;
  /** Trusted absolute depth from this Run's canonical host manager. */
  workDepth: number;
  /** The Run's working location; the parent Session remains the resource scope. */
  cwd: string;
  /** The Run runtime's own lifetime, not the parent Session's. */
  signal: AbortSignal;
  isCurrent: () => boolean;
  getPermissionMode?: NonNullable<HappyMcpSessionClient['getPermissionMode']>;
  /** This Run's own admitted turn; `null` between turns and once superseded. */
  readActiveTurnAdmissionWitness: () => AgentInvocationTurnAdmissionWitness | null;
  readCurrentRunOccurrence: (runId: string) => ExecutionRunOccurrenceWitnessV1 | null;
}>;

function createRunScopedMcpSessionView(
  session: HappyMcpSessionClient,
  run: ExecutionRunMcpBinding,
): HappyMcpSessionClient {
  const readWitness = (): AgentInvocationTurnAdmissionWitness | null => {
    // Currentness is the occurrence owner's answer, never the caller's guess.
    if (!run.readCurrentRunOccurrence(run.runId)) return null;
    return run.readActiveTurnAdmissionWitness();
  };
  return {
    ...session,
    // Class prototype methods are not preserved by object spread. Forward the
    // admitted Session transport's immutable Home binding explicitly so a
    // Run-scoped MCP view cannot fall back to ambient Home configuration.
    getServerBinding: () => session.getServerBinding(),
    getMcpRequestAuthPort: () => session.getMcpRequestAuthPort?.(),
    ...(session.getEphemeralStreamConnectionEpoch
      ? { getEphemeralStreamConnectionEpoch: () => session.getEphemeralStreamConnectionEpoch!() } : {}),
    ...(session.isDaemonPluginCatalogSignalReady
      ? { isDaemonPluginCatalogSignalReady: () => session.isDaemonPluginCatalogSignalReady!() } : {}),
    ...(session.subscribeDaemonPluginCatalogChanges
      ? { subscribeDaemonPluginCatalogChanges: (listener: Parameters<NonNullable<HappyMcpSessionClient['subscribeDaemonPluginCatalogChanges']>>[0]) => session.subscribeDaemonPluginCatalogChanges!(listener) } : {}),
    ...(session.getBackendTarget ? { getBackendTarget: () => session.getBackendTarget!() } : {}),
    ...(session.getMetadataSnapshot ? { getMetadataSnapshot: () => session.getMetadataSnapshot!() } : {}),
    ...(session.getMachineAdmissionTransport
      ? { getMachineAdmissionTransport: () => session.getMachineAdmissionTransport!() }
      : {}),
    ...(session.getServerFeaturesSnapshot
      ? { getServerFeaturesSnapshot: () => session.getServerFeaturesSnapshot!() }
      : {}),
    ...(session.getStoredContentEncryptionContext
      ? { getStoredContentEncryptionContext: () => session.getStoredContentEncryptionContext!() }
      : {}),
    getPermissionMode: () => run.getPermissionMode ? run.getPermissionMode() : session.getPermissionMode?.(),
    getWorkDepth: () => run.workDepth,
    getAgentStartRunCaller: () => run.isCurrent() && !run.signal.aborted && run.readCurrentRunOccurrence(run.runId)
      ? { hostSessionId: session.sessionId, callingRunId: run.runId, callingRunDepth: run.workDepth }
      : null,
    getActiveTurnPermissionWitness: () => {
      const witness = readWitness();
      return witness
        ? {
          turnId: witness.turnId,
          workDepth: run.workDepth,
          ...(witness.causalPermissionAuthority
            ? { causalPermissionAuthority: witness.causalPermissionAuthority }
            : {}),
        }
        : null;
    },
    getActiveTurnAdmissionWitness: readWitness,
    getRuntimeLifetimeSignal: () => run.signal,
    getSessionActionConfirmationBinding: () => {
      const occurrence = run.readCurrentRunOccurrence(run.runId);
      const witness = occurrence ? run.readActiveTurnAdmissionWitness() : null;
      if (!occurrence || !witness) return null;
      const { occurrenceId, sidechainId } = occurrence;
      return {
        turnId: witness.turnId,
        lifetimeSignal: run.signal,
        // A superseded occurrence, a retired turn, or a cancelled controller all
        // retire an already issued confirmation without a second decision owner.
        isCurrent: () => {
          const current = run.readCurrentRunOccurrence(run.runId);
          return current?.occurrenceId === occurrenceId
            && run.isCurrent()
            && run.readActiveTurnAdmissionWitness()?.turnId === witness.turnId;
        },
        run: { runId: run.runId, occurrenceId, sidechainId },
      };
    },
    getCurrentSessionLocation: () => ({
      ...(session.getCurrentSessionLocation?.() ?? {}),
      path: run.cwd,
    }),
  };
}

type RunnerMcpServersParams = Readonly<{
  session: HappyMcpSessionClient & Required<Pick<HappyMcpSessionClient, 'enqueueSessionEventCommitted'>>;
  credentials: StoredCredentials;
  /** Account-wide Action authority; explicit null keeps the runtime Session-scoped. */
  accountCredentials?: StoredCredentials | null;
  sessionList?: ActionExecutorDeps['sessionList'];
  accountSettings: AccountSettings | null;
  accountSettingsSnapshot?: ActiveAccountSettingsSnapshot | null;
  /** The existing invocation's Home/Account custody; never borrowed by Session authority. */
  operationContext?: SavedSecretOperationContextV1;
  /** Exact runtime policy when ambient Account settings are intentionally unavailable. */
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  /** Exact caller-owned registry lease for daemonless scoped runtimes. */
  pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease;
  machineId: string;
  directory: string;
  agentId?: string | null;
  agentAcceptsUserMcp?: boolean;
  sessionMetadata?: Readonly<Record<string, unknown>> | null;
  env?: NodeJS.ProcessEnv;
  tmpDir?: string | null;
  commandMode?: NonNullable<Parameters<typeof createHappierMcpBridge>[1]>['commandMode'];
  resolvedMcpServers?: Record<string, McpServerConfig>;
  /** Extension-delivered Happier tools already have their own bridge. */
  includeHappierMcpServer?: boolean;
  /**
   * Binds this resolution to one Session-owned Execution Run occurrence.
   *
   * The parent Session stays the resource scope and keeps its own configured
   * server profile; only permission mode, working location, runtime lifetime and
   * turn authority come from the Run. The Run's concurrently active parent turn
   * is never substituted for it.
   */
  executionRun?: ExecutionRunMcpBinding;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  savedSecretCatalogState?: import('@/settings/secrets/savedSecretCatalog').SavedSecretCatalogState;
}>;

type RunnerMcpServersResult<Bridge extends { stop: () => void }> = Readonly<{
  happierMcpServer: Bridge;
  mcpServers: Record<string, McpServerConfig>;
  mcpBindingIdentities?: Readonly<Record<string, UsageMcpBindingIdentity>>;
}>;
type HappierMcpBridgeHandle = {
  url: string;
  supportedSessionReadActions: readonly SessionRunPromptReadActionIdV1[];
  stop: () => void;
};

export function resolveRunnerMcpServers(params: RunnerMcpServersParams & { includeHappierMcpServer?: true }): Promise<RunnerMcpServersResult<HappierMcpBridgeHandle>>;
export function resolveRunnerMcpServers(params: RunnerMcpServersParams & { includeHappierMcpServer: false }): Promise<RunnerMcpServersResult<{ stop: () => void }>>;
export function resolveRunnerMcpServers(params: RunnerMcpServersParams): Promise<RunnerMcpServersResult<{ stop: () => void }>>;
export async function resolveRunnerMcpServers(params: RunnerMcpServersParams): Promise<RunnerMcpServersResult<{ stop: () => void }>> {
  const env = params.env ?? process.env;
  const accountCredentials = Object.hasOwn(params, 'accountCredentials')
    ? params.accountCredentials ?? null
    : params.credentials;
  let operationContext = accountCredentials ? params.operationContext : undefined;
  const initialAccountSnapshot = params.accountSettingsSnapshot;
  if (accountCredentials && !operationContext && initialAccountSnapshot
    && initialAccountSnapshot === getActiveAccountSettingsSnapshot()) {
    // Ordinary Home callers use this same admitted Account owner. Capture its
    // existing lifetime before bridge startup, never after an awaited boundary.
    // Foreign invocation snapshots still require their explicit context.
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const scopeKey = initialAccountSnapshot.scopeKey;
    const serverHttpBaseUrl = params.session.getServerBinding().serverUrl;
    const boundScopeKey = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(accountCredentials.token));
    if (!scopeKey || scopeKey !== boundScopeKey) throw new McpServerCatalogUnavailableError('scope-retired');
    operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
      credentials: accountCredentials, snapshot: initialAccountSnapshot, serverHttpBaseUrl,
      isCurrent: async () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
        && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken,
    }));
  }
  if (operationContext && (operationContext.credentials.token !== accountCredentials?.token || !await operationContext.isCurrent())) {
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  let accountSettings = accountCredentials ? params.accountSettings ?? params.accountSettingsSnapshot?.settings ?? null : null;
  let savedSecretResources = params.savedSecretResources;
  let savedSecretCatalogState = params.savedSecretCatalogState;

  const run = params.executionRun;
  const scopedSession: HappyMcpSessionClient = run
    ? createRunScopedMcpSessionView(params.session, run)
    : params.session;
  const accountSnapshot = params.accountSettingsSnapshot ?? null;
  const accountScopeKey = accountCredentials ? operationContext
    ? runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(accountCredentials.token))
    : resolveAccountSettingsScopeKeyForToken(accountCredentials.token) : null;
  if (accountCredentials && accountSnapshot?.scopeKey
    && accountSnapshot.scopeKey !== accountScopeKey) {
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  let mcpSettings = accountCredentials ? readMcpServersSettingsFromAccountSettings(accountSnapshot) : null;
  let mcpCatalog = accountSnapshot?.mcpServerCatalog;
  let resolvedSelection: ReturnType<typeof resolveSessionCapabilitiesForDirectory> | null = null;
  if (mcpSettings && accountCredentials) {
    const selection = readSessionCapabilitySelectionFromMetadataV1(params.sessionMetadata ?? null).mcp;
    const initialSelection = resolveSessionCapabilitiesForDirectory({
      settings: mcpSettings,
      machineId: params.machineId,
      directory: params.directory,
      selection: selection ? { mcp: selection } : {},
      agentId: params.agentId,
      agentAcceptsUserMcp: params.agentAcceptsUserMcp,
    });
    const sharedReferences = listSelectedMcpSharedSecretReferences(initialSelection.selectedServersByName);
    if (sharedReferences.length > 0) {
      let admitted: Awaited<ReturnType<typeof refreshSavedSecretCatalogForOperation>>;
      try {
        const refresh = () => refreshSavedSecretCatalogForOperation({
          expectedScopeKey: resolveAccountSettingsScopeKeyForToken(accountCredentials.token),
          references: sharedReferences,
          ...(operationContext ? { operationContext } : {}),
          ...(run?.signal ? { signal: run.signal } : {}),
        });
        admitted = await (operationContext ? runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl, refresh) : refresh());
      } catch (error) {
        if (error instanceof SavedSecretOperationAdmissionError) {
          throw new SavedSecretResolutionError({
            status: savedSecretOperationAdmissionStatus(error.reason),
            reference: error.reference,
            consumer: 'mcp',
            field: 'operation',
          });
        }
        throw error;
      }
      accountSettings = admitted.settings;
      savedSecretResources = admitted.savedSecretResources;
      savedSecretCatalogState = admitted.savedSecretCatalogState;
      mcpSettings = readMcpServersSettingsFromAccountSettings({ ...admitted, mcpServerCatalog: admitted.mcpServerCatalog ?? accountSnapshot?.mcpServerCatalog });
      mcpCatalog = admitted.mcpServerCatalog ?? accountSnapshot?.mcpServerCatalog;
    }
    resolvedSelection = resolveSessionCapabilitiesForDirectory({
      settings: mcpSettings,
      machineId: params.machineId,
      directory: params.directory,
      selection: selection ? { mcp: selection } : {},
      agentId: params.agentId,
      agentAcceptsUserMcp: params.agentAcceptsUserMcp,
    });
  }
  if (operationContext && !await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
  const builtIn = params.includeHappierMcpServer === false
    ? { happierMcpServer: { stop: () => undefined }, mcpServers: {} }
    : await createHappierMcpBridge(scopedSession, {
    commandMode: params.commandMode,
    sessionCredentials: params.credentials,
    credentials: accountCredentials,
    authorityScope: accountCredentials ? 'account' : 'session',
    ...(params.sessionList ? { sessionList: params.sessionList } : {}),
    accountSettings,
    ...(params.actionsSettingsProvider
      ? { actionsSettingsProvider: params.actionsSettingsProvider }
      : {}),
    ...(params.pluginRuntimeRegistryLease
      ? { pluginRuntimeRegistryLease: params.pluginRuntimeRegistryLease }
      : {}),
    requiredDirectActionIds: run ? SESSION_RUN_PROMPT_READ_ACTION_IDS_V1 : undefined,
  });

  if (operationContext && !await operationContext.isCurrent()) {
    builtIn.happierMcpServer.stop();
    throw new McpServerCatalogUnavailableError('scope-retired');
  }

  if (!accountSettings || !accountCredentials) {
    return { happierMcpServer: builtIn.happierMcpServer, mcpServers: params.resolvedMcpServers ? mergeWithBuiltInHappierMcpServer({ builtIn: builtIn.mcpServers, extra: params.resolvedMcpServers }) : builtIn.mcpServers };
  }

  if (!mcpSettings || !resolvedSelection) {
    return { happierMcpServer: builtIn.happierMcpServer, mcpServers: builtIn.mcpServers };
  }

  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(accountCredentials);
  const invocationSnapshot = operationContext?.readSnapshot();
  if (operationContext && !invocationSnapshot) {
    builtIn.happierMcpServer.stop();
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  const savedSecretMaterializer = operationContext && invocationSnapshot
    ? createSavedSecretMaterializerFromSnapshotV1(invocationSnapshot, { isCurrent: () => operationContext.readSnapshot() === invocationSnapshot })
    : createSavedSecretMaterializerV1({
    accountSettings,
    settingsSecretsReadKeys,
    resources: savedSecretResources,
    resourceCatalogState: savedSecretCatalogState,
  });

  const attestation = SessionAttestedContextV1Schema.safeParse(params.session.getMetadataSnapshot?.()?.attestedContext);
  const requestAuthByServerId: Record<string, McpRequestAuthCapability> = {};
  const requestAuthPort = scopedSession.getMcpRequestAuthPort?.();
  const materializationIds = new Set<string>();
  const retireRequestAuth = () => {
    for (const materializationId of materializationIds) {
      materializationIds.delete(materializationId);
      void requestAuthPort?.close({ materializationId }).catch(() => {
        logger.debug('[mcp] Request-auth capability retirement failed');
      });
    }
  };
  let materialized: Awaited<ReturnType<typeof materializeMcpServerConfigRecord>>;
  try {
    for (const { config: server } of Object.values(resolvedSelection.selectedServersByName)) {
      if (server.transport === 'stdio' || server.remote.auth?.kind !== 'oauth') continue;
      if (!requestAuthPort) continue;
      const materializationId = randomUUID();
      const occurrence = run?.readCurrentRunOccurrence(run.runId);
      if (run && (!occurrence || !run.isCurrent() || run.signal.aborted)) throw new Error('mcp_request_auth_not_active');
      try {
        const capability = await requestAuthPort.open({
        serverId: server.id,
        resource: canonicalMcpOAuthResourceUrlV1(server.remote.url),
        materializationId,
        ...(run && occurrence ? { executionRun: { runId: run.runId, occurrenceId: occurrence.occurrenceId } } : {}),
        });
        materializationIds.add(materializationId);
        requestAuthByServerId[server.id] = capability;
      } catch (error) {
        if (mcpSettings.strictMode) throw error;
        // The materializer owns the canonical unavailable-server warning/notice.
      }
    }
    materialized = await materializeMcpServerConfigRecord({
    resolved: {
      directory: params.directory,
      strictMode: resolvedSelection.strictMode,
      serversByName: resolvedSelection.selectedServersByName,
    },
    savedSecretMaterializer,
    session: { sessionId: params.session.sessionId,
      ...(attestation.success ? { attestedContext: attestation.data } : {}) },
    processEnv: env,
    tmpDir: params.tmpDir ?? null,
    strictMode: mcpSettings.strictMode,
    requestAuthByServerId,
  });
  } catch (error) {
    retireRequestAuth();
    builtIn.happierMcpServer.stop();
    throw error;
  }
  if (operationContext && !await operationContext.isCurrent()) {
    materialized.cleanup();
    retireRequestAuth();
    builtIn.happierMcpServer.stop();
    throw new McpServerCatalogUnavailableError('scope-retired');
  }

  if (materialized.warnings.length > 0) {
    logger.debug('[mcp] Materialization warnings', {
      warningCount: materialized.warnings.length,
      warnings: materialized.warnings.map((w) => ({ serverName: w.serverName, code: w.code, detail: w.detail })),
    });
  }
  const merged = mergeWithBuiltInHappierMcpServer({ builtIn: builtIn.mcpServers, extra: params.resolvedMcpServers ?? materialized.mcpServers });
  const warningsByName = new Map(materialized.warnings
    .filter(warning => !Object.hasOwn(merged, warning.serverName))
    .map(warning => [warning.serverName, warning]));
  if (warningsByName.size > 0) {
    const notice = SessionCapabilityNoticeV1Schema.parse({
      v: 1,
      items: [...warningsByName.values()].map(warning => ({
        kind: 'mcp_server',
        name: warning.serverName,
        itemId: resolvedSelection.itemsByName[warning.serverName]?.serverId,
        code: warning.code,
        detail: warning.detail,
      })),
    });
    try {
      await params.session.enqueueSessionEventCommitted({
        type: 'message',
        message: notice.items.map(item => `${item.name} couldn't start · ${item.detail ?? item.code}`).join('\n'),
        [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: notice,
      });
      if (operationContext && !await operationContext.isCurrent()) {
        throw new McpServerCatalogUnavailableError('scope-retired');
      }
    } catch (error) {
      materialized.cleanup();
      retireRequestAuth();
      builtIn.happierMcpServer.stop();
      throw error;
    }
  }

  const mcpBindingIdentities: Record<string, UsageMcpBindingIdentity> = {};
  if (!params.resolvedMcpServers && mcpCatalog?.status === 'ready' && mcpCatalog.authority === 'active'
      && typeof mcpCatalog.revision === 'number') {
    for (const name of Object.keys(materialized.mcpServers)) {
      const item = resolvedSelection.itemsByName[name];
      if (!item?.selected || !item.bindingId) continue;
      const binding = mcpSettings.bindings.find(row => row.id === item.bindingId && row.serverId === item.serverId);
      const server = mcpSettings.servers.find(row => row.id === item.serverId);
      if (!binding?.enabled || !server) continue;
      mcpBindingIdentities[name] = { serverId: server.id, bindingId: binding.id,
        serverRevision: server.updatedAt, bindingRevision: binding.updatedAt, catalogRevision: mcpCatalog.revision };
    }
  }
  return {
    happierMcpServer: {
      ...builtIn.happierMcpServer,
      stop: () => {
        try { builtIn.happierMcpServer.stop(); } finally { materialized.cleanup(); retireRequestAuth(); }
      },
    },
    mcpServers: merged,
    mcpBindingIdentities,
  };
}
