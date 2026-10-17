import { AgentExecutionRunEventSchema } from '@happier-dev/protocol/runtime/agentExecutionRunV1';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { resolveNativeAgentLaunchEnvironment } from '@/agent/runtime/launchEnvironment';
import { HappierStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { AccountSettings, SessionCapabilitySelectionV1 } from '@happier-dev/protocol';
import type {
    AgentExecutionRunEvent,
    AgentExecutionRunOpenRequest,
    AgentExecutionRunRuntime,
    AgentExecutionRunRuntimeFactory,
    AgentExecutionRunRuntimeContextV1,
    AgentExecutionRunHostServicesV1,
    AgentSessionExecutionRunRuntimeFactoryV1,
    AgentLaunchEnvironment,
    AgentRuntime,
    AgentRuntimeContext,
    AgentSessionInput,
    AgentSessionOpenRequest,
    AgentSessionRuntime,
    AgentSessionRuntimeContext,
    AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { WorkStateService } from '@happier-dev/plugin-sdk/sessions/work-state';
import { randomUUID } from 'node:crypto';
import { createExecutionRunHostBackendFromSessionRuntime } from '@happier-dev/plugin-sdk/host/registration';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { CreateCliExecutionRunBackendParams, EngineResolutionAgent } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { continueNativeRuntimeAfterFailure, createRecoveringAgentSessionRuntime } from './hostRuntime/recovery';
import {
    createPluginInteractionsService,
    createPluginInvocationPresentation,
} from '@/plugins/runtime/invocation/services/interactions';
import {
    createNativeAgentCurrentExecutionRunUiServices,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import {
    buildExecutionRunPermissionRequestEnvelope,
    resolveExecutionRunPermissionInteractionMode,
} from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import {
    createRunScopedExecutionPermissionHandler,
    readRunScopedExecutionProviderRequestId,
} from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import { resolveNativeAgentSessionStateSharingPolicy } from '@/agent/runtime/registry/engineRegistry/stateSharingPolicy';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';
import {
    createNativeAgentSessionInteractionOperations,
    applyNativeAgentConfigurationUpdate,
    resolveNativeAgentSessionNativeHomeService,
    resolveAgentSessionMcpLaunchConfigs,
    toNativeAgentUsageObservation,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import type { UsageObservation } from '@/usage/usageObservation';
import type { UsageObservationPublishResult } from '@/usage/createUsageObservationPublisher';
import {
    normalizeHostProviderInputOutcome,
    type SessionProviderInputOutcome,
} from '@/agent/runtime/session/input/providerInputOutcome';

import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';
import { createNativeAgentExecutionRunHostServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import type { PluginRuntimeAuthoritySnapshotV1 } from '@/plugins/runtime/lifecycle/activation/runtimeAuthority';
import {
    createRuntimeTurnFailureAlreadySurfacedError,
    readRuntimeTurnFailureAlreadySurfacedEvent,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import { resolveStructuredInputProviderDispatchContext } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import { readConnectedServiceChildMemberLogContextFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { logger } from '@/ui/logger';
import { publishSkillLaunchNotice } from '@/prompts/skills/runtime/publishRunnerSkillNotice';
import { createExecutionRunCodedError, readExecutionRunErrorCode, readExecutionRunRejectedStartDiagnostic, sanitizeExecutionRunError as sanitizeThrownError, type ExecutionRunRejectedStartError } from './errors';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { resolveSessionCapabilitiesForDirectory } from '@/mcp/servers/resolveSessionCapabilitiesForDirectory';
import { agentReceivesUserMcpServersV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { listSelectedMcpSharedSecretReferences, materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { projectResolvedMcpServers } from '@/mcp/runtime/projectResolvedMcpServers';
import { readLoadedMcpNativeServerNames } from '@/mcp/runtime/assignMcpWireNames';
import { detectProviderMcpServers } from '@/mcp/providerDetection/detectProviderMcpServers';
import type { ResolvedSessionMcpServer } from '@/mcp/runtimeTypes';
import type { McpToolPolicyContext } from '@/mcp/runtime/resolveMcpToolIdentity';
import { projectMcpToolLaunchPolicies } from '@/mcp/runtime/projectMcpToolLaunchPolicy';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import {
    isWorkflowInteractionCapacityError,
    WORKFLOW_INTERACTION_CAPACITY_EXCEEDED,
} from '@/agent/permissions/interactionPersistenceError';
import { isForegroundTurnRuntimeTranscriptEvent } from '@/agent/runtime/session/events/runtimeTranscriptScope';

type NativeAgentRunUsagePublisher = Readonly<{
    provider: string;
    publish(input: Readonly<{
        observedAt: number;
        observation: UsageObservation;
        turnId: string | null;
        externalKey: string;
    }>): void | Promise<void | UsageObservationPublishResult>;
}>;

type NativeAgentSessionContextLease = Readonly<{
    context: AgentSessionRuntimeContext;
    mcpServers?: AgentSessionOpenRequest['mcpServers'];
    mcpServersStrictMode?: AgentSessionOpenRequest['mcpServersStrictMode'];
    mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
    subscribeMcpToolPolicy?: (listener: (policy: NonNullable<AgentSessionOpenRequest['mcpToolPolicy']>) => void) => () => void;
    skills?: AgentSessionOpenRequest['skills'];
    observeSkillUse?: (event: Extract<AgentSessionRuntimeEvent, { kind: 'skill-usage' }>) => Promise<void>;
    skillIndex?: string;
    capabilityNoticeSession?: Parameters<typeof publishSkillLaunchNotice>[0];
    usagePublisher?: NativeAgentRunUsagePublisher;
    dispose(): Promise<void>;
}>;

export type NativeAgentSessionContextLeaseFactory = ((params: Readonly<{
    services: PluginServices;
    signal: AbortSignal;
    readSessionRuntime(): AgentSessionRuntime | null;
    readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
}>) => Promise<NativeAgentSessionContextLease> | NativeAgentSessionContextLease) & Readonly<{
    bindInvocationServices?: (params: Readonly<{
        services: PluginServices;
        signal: AbortSignal;
        readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
    }>) => Promise<PluginServices>;
    respondToPermissionRequest?: (requestId: string, approved: boolean) => boolean;
    abortPendingPermissionRequests?: (reason: string) => Promise<void>;
    onTurnTerminal?: (turnId: string) => Promise<void>;
    resolveStructuredInputForDispatch?: (params: Readonly<{
        input: AgentSessionInput;
        localId: string;
        signal: AbortSignal;
    }>) => Promise<AgentSessionInput>;
}>;

type NativeAgentExecutionRunContextLease = Readonly<{
    context: AgentExecutionRunRuntimeContextV1;
    mcpServers?: AgentSessionOpenRequest['mcpServers'];
    mcpServersStrictMode?: AgentSessionOpenRequest['mcpServersStrictMode'];
    mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
    skills?: AgentSessionOpenRequest['skills'];
    skillIndex?: string;
    dispose(): Promise<void>;
}>;

export type NativeAgentExecutionRunContextLeaseFactory = ((params: Readonly<{
    services: PluginServices;
    signal: AbortSignal;
    readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
}>) => Promise<NativeAgentExecutionRunContextLease> | NativeAgentExecutionRunContextLease) & Pick<
    NativeAgentSessionContextLeaseFactory,
    'bindInvocationServices' | 'respondToPermissionRequest' | 'abortPendingPermissionRequests' | 'onTurnTerminal' | 'resolveStructuredInputForDispatch'
>;

export type NativeAgentRuntimeLeaseIdentity = Readonly<{
    pluginId: string;
    pluginVersion: string;
    agentId: string;
    localAgentId: string;
    occurrenceId: string;
    isCurrent(): boolean;
}>;

const RUN_SESSION_PROJECTION_UNAVAILABLE_CODE = 'agent_run_session_projection_unavailable';

function withRunScopedSessionHooks(context: AgentSessionRuntimeContext): AgentSessionRuntimeContext {
    const hooks = context.session.services.sessionHooks;
    return Object.freeze({
        ...context,
        session: Object.freeze({
            ...context.session,
            services: Object.freeze({
                ...context.session.services,
                sessionHooks: Object.freeze({
                    ...hooks,
                    // Child runtimes share Session identity, never its retained hook endpoint or files.
                    startServer: (request: Parameters<typeof hooks.startServer>[0]) =>
                        hooks.startServer({ ...request, lifetime: 'invocation' }),
                    createPluginDir: (request: Parameters<typeof hooks.createPluginDir>[0]) =>
                        hooks.createPluginDir({ ...request, lifetime: 'invocation' }),
                }),
            }),
        }),
    });
}

export function createRunScopedWorkStateService(signal: AbortSignal): WorkStateService {
    return Object.freeze({
        publisher: () => Object.freeze({
            async publish() {
                signal.throwIfAborted();
                return {
                    status: 'unavailable' as const,
                    diagnostic: {
                        code: RUN_SESSION_PROJECTION_UNAVAILABLE_CODE,
                        severity: 'error' as const,
                    },
                };
            },
        }),
    });
}

/**
 * Owns the detached Run's one truthful interaction/permission binding. The
 * context carries execution-run scope and only scope-neutral host services; it
 * has no ApiSessionClient and cannot create a Happier Session, Pending row,
 * transcript, or Session projection.
 */
export function createNativeAgentExecutionRunContextLeaseFactory(params: Readonly<{
    lease: NativeAgentRuntimeLeaseIdentity;
    runId: string;
    controllerOccurrenceId: string;
    callId: string;
    sidechainId: string;
    resolveAcpHostLaunch?: Parameters<typeof createPublicAcpRuntimeProtocols>[0]['resolveHostLaunch'];
    acpRuntimeDefinition?: Parameters<typeof createPublicAcpRuntimeProtocols>[0]['runtimeDefinition'];
    transformAgentRequest?: Parameters<typeof createPublicAcpRuntimeProtocols>[0]['transformAgentRequest'];
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    runtimeAuthority?: PluginRuntimeAuthoritySnapshotV1;
    directory: string;
    machineId: string;
    accountSettings: AccountSettings | null;
    resolveAccountSettingsSnapshot?: import('@/settings/accountSettings/activeAccountSettingsSnapshot').AccountSettingsSnapshotResolver;
    permissionMode: string;
    workspaceWrites?: 'allow' | 'deny';
    start: ExecutionRunBackendStartContext;
    causalPermissionAuthority?: CreateCliExecutionRunBackendParams['causalPermissionAuthority'];
    getPermissionRequestStore?: CreateCliExecutionRunBackendParams['getPermissionRequestStore'];
    capabilitySelection?: SessionCapabilitySelectionV1;
    happyHomeDir?: string;
    agent?: EngineResolutionAgent;
    sourceEnvironment?: Readonly<Record<string, string>>;
    refreshRuntimeAuthViaDaemon?: CreateCliExecutionRunBackendParams['connectedServiceRuntimeAuthRefresh'];
    createInvocationServices?: (params: Readonly<{
        currentSession: HostCurrentSessionUiServices;
        signal: AbortSignal;
        readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
    }>) => Promise<PluginServices>;
}>): NativeAgentExecutionRunContextLeaseFactory {
    const runId = readRequiredString(params.runId, 'a run id');
    const callId = readRequiredString(params.callId, 'a call id');
    const sidechainId = readRequiredString(params.sidechainId, 'a sidechain id');
    let readMcpToolContext: () => McpToolPolicyContext | null = () => null;
    const permissionHandler = createExecutionRunPermissionHandler({
        permissionMode: params.permissionMode,
        ...(params.start.allowedTools !== undefined ? { allowedTools: params.start.allowedTools } : {}),
        ...(params.start.unlistedTools !== undefined ? { unlistedTools: params.start.unlistedTools } : {}),
        workspaceWrites: params.workspaceWrites,
        backendId: params.lease.agentId,
        getMcpToolContext: () => readMcpToolContext(),
        ...(Object.hasOwn(params, 'causalPermissionAuthority')
            ? { causalPermissionAuthority: params.causalPermissionAuthority }
            : {}),
        publishPendingRequest: async ({ requestId, toolName, toolInput, turnId, mcpTool }) => {
            const requestStore = params.getPermissionRequestStore?.() ?? null;
            if (!requestStore) {
                throw Object.assign(
                    new Error('Execution-run permission interaction target is unavailable'),
                    { code: 'execution_run_interaction_unavailable' },
                );
            }
            const providerRequestId = readRunScopedExecutionProviderRequestId({
                runId,
                controllerOccurrenceId: params.controllerOccurrenceId,
                requestId,
            });
            if (!providerRequestId) {
                throw new Error('Execution-run permission request id does not belong to this run');
            }
            const envelope = buildExecutionRunPermissionRequestEnvelope({
                sessionId: null,
                runId,
                callId,
                sidechainId,
                backendId: params.lease.agentId,
                runtimeKind: 'native_agent_session',
                permissionMode: params.permissionMode,
                providerRequestId,
                controllerOccurrenceId: params.controllerOccurrenceId,
                providerPayload: toolInput,
                toolName,
                reason: toolName,
            });
            const publication = {
                requestId,
                toolName,
                toolInput,
                createdAt: envelope.createdAtMs,
                source: 'execution_run',
                ...(turnId ? { turnId } : {}),
                ...(mcpTool ? { mcpTool } : {}),
                responseTarget: envelope.responseTarget,
                sidechainId,
            };
            if (requestStore.publishRequestAndWait) {
                await requestStore.publishRequestAndWait(publication);
            } else {
                requestStore.publishRequest(publication);
            }
        },
    });
    const runPermissionScope = createRunScopedExecutionPermissionHandler({
        runId,
        controllerOccurrenceId: params.controllerOccurrenceId,
        handler: permissionHandler,
        readInteractionMode: () => {
            const requestStore = params.getPermissionRequestStore?.() ?? null;
            const { intent, runClass, ioMode, retentionPolicy } = params.start;
            if (!intent || !runClass || !ioMode || !retentionPolicy) {
                return 'interaction_unavailable';
            }
            return resolveExecutionRunPermissionInteractionMode({
                intent,
                runClass,
                ioMode,
                retentionPolicy,
                permissionMode: params.permissionMode,
                parentSessionId: null,
                interactionTargetAvailable: requestStore !== null,
                backendCapabilities: {
                    canRespondToPermission: true,
                    canSurfaceParentSessionPrompt: true,
                    runtimeKind: 'native_agent_session',
                    backendId: params.lease.agentId,
                },
            });
        },
        onPendingRequestAborted: async ({ requestId, reason }) => {
            await params.getPermissionRequestStore?.()?.completeRequest?.({
                requestId,
                status: 'canceled',
                decision: 'abort',
                reason,
            });
        },
    });
    const bindInvocationServices = async ({
        services,
        signal,
        readActiveTurnAdmissionWitness,
    }: Readonly<{
        services: PluginServices;
        signal: AbortSignal;
        readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
    }>): Promise<Readonly<{
        services: PluginServices;
        currentSession: HostCurrentSessionUiServices;
    }>> => {
        const currentSession = createNativeAgentCurrentExecutionRunUiServices({
            permissionHandler: runPermissionScope.handler,
            pluginId: params.lease.pluginId,
            contributionId: params.lease.localAgentId,
            runtimeId: `native-agent-run:${runId}`,
            executionRunId: runId,
            occurrenceId: params.lease.occurrenceId,
            isCurrent: params.lease.isCurrent,
            signal,
            readActiveTurnAdmissionWitness,
        });
        const boundServices = params.createInvocationServices
            ? await params.createInvocationServices({
                currentSession,
                signal,
                ...(readActiveTurnAdmissionWitness ? { readActiveTurnAdmissionWitness } : {}),
            })
            : services;
        return Object.freeze({ services: boundServices, currentSession });
    };
    const factory: NativeAgentExecutionRunContextLeaseFactory = async ({ services, signal, readActiveTurnAdmissionWitness }) => {
        const bound = await bindInvocationServices({
            services,
            signal,
            ...(readActiveTurnAdmissionWitness ? { readActiveTurnAdmissionWitness } : {}),
        });
        const nativeHome = params.agent ? await resolveNativeAgentSessionNativeHomeService({
            agent: params.agent,
            sourceEnvironment: params.sourceEnvironment ?? {},
        }) : null;
        signal.throwIfAborted();
        let resolvedRunMcpServers: readonly ResolvedSessionMcpServer[] = [];
        const pluginAttachments: Readonly<{ dispose(): void | Promise<void> }>[] = [];
        const disposeAttachments = async () => { await Promise.all(pluginAttachments.splice(0).map(attachment => attachment.dispose())); };
        const executionRunServices = createNativeAgentExecutionRunHostServices({
            readResolvedMcpServers: () => resolvedRunMcpServers,
            signal,
            executionRunId: runId,
            directory: params.directory,
            machineId: params.machineId,
            accountSettings: params.accountSettings,
            resolveAccountSettingsSnapshot: params.resolveAccountSettingsSnapshot,
            ...(params.capabilitySelection ? { capabilitySelection: params.capabilitySelection } : {}),
            runtimeRegistry: params.runtimeRegistry,
            ...(params.runtimeAuthority ? { runtimeAuthority: params.runtimeAuthority } : {}),
            pluginId: params.lease.pluginId,
            agentId: params.lease.agentId,
            ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
            ...(nativeHome ? { nativeHome } : {}),
            ...(params.refreshRuntimeAuthViaDaemon ? { refreshRuntimeAuthViaDaemon: params.refreshRuntimeAuthViaDaemon } : {}),
        });
        let context: AgentExecutionRunRuntimeContextV1;
        let mcpMaterial: Awaited<ReturnType<typeof materializeMcpServerConfigRecord>> | null = null;
        let mcpServers: AgentSessionOpenRequest['mcpServers'];
        let mcpServersStrictMode: AgentSessionOpenRequest['mcpServersStrictMode'];
        let mcpToolPolicy: AgentSessionOpenRequest['mcpToolPolicy'];
        try {
            if (params.capabilitySelection?.mcp && (params.capabilitySelection.mcp.managedServersEnabled || params.capabilitySelection.mcp.forceIncludeServerIds.length > 0)) {
                let snapshot = await params.resolveAccountSettingsSnapshot?.({ mcpServerCatalog: true, signal }) ?? null;
                signal.throwIfAborted();
                if (!snapshot) throw new McpServerCatalogUnavailableError('catalog-unobserved');
                const pluginItems = await params.runtimeRegistry?.projectMcpServerItems?.(readMcpServersSettingsFromAccountSettings(snapshot)) ?? [];
                const detected = params.runtimeRegistry?.discoverMcpServersForDetection
                    ? await detectProviderMcpServers({ directory: params.directory, providers: [params.lease.agentId],
                        env: { ...process.env, ...params.sourceEnvironment }, runtimeRegistry: params.runtimeRegistry }) : { servers: [] };
                const nativeServerNames = readLoadedMcpNativeServerNames({ servers: detected.servers, agentId: params.lease.agentId });
                const select = (admitted: NonNullable<typeof snapshot>) => resolveSessionCapabilitiesForDirectory({
                    settings: readMcpServersSettingsFromAccountSettings(admitted),
                    machineId: params.machineId, directory: params.directory, selection: params.capabilitySelection,
                    agentId: params.lease.agentId, agentAcceptsUserMcp: agentReceivesUserMcpServersV1(resolveAgentToolsDelivery(params.lease.agentId, params.runtimeRegistry?.contributes)),
                    mcpPluginItems: pluginItems, nativeServerNames,
                });
                let selected = select(snapshot);
                const references = listSelectedMcpSharedSecretReferences(selected.selectedServersByName);
                if (references.length > 0) {
                    snapshot = await params.resolveAccountSettingsSnapshot?.({ mcpServerCatalog: true, savedSecretReferences: references, signal }) ?? null;
                    signal.throwIfAborted();
                    if (!snapshot) throw new McpServerCatalogUnavailableError('catalog-unobserved');
                    selected = select(snapshot);
                }
                if (params.runtimeRegistry?.materializePluginMcpServers) {
                    const attached = await params.runtimeRegistry.materializePluginMcpServers({ scope: { kind: 'execution_run', executionRunId: runId },
                        directory: params.directory, signal, currentSession: bound.currentSession,
                        servers: Object.values(selected.selectedServersByName).map(server => ({ id: server.serverId, name: server.name,
                            transport: server.config.remote ? { kind: 'http' as const, url: server.config.remote.url } : { kind: 'stdio' as const },
                            scope: { executionRunId: runId, directory: params.directory } })),
                        addDisposable: attachment => pluginAttachments.push(attachment) });
                    selected = { ...selected, selectedServersByName: Object.fromEntries(attached.map(server => {
                        const original = selected.selectedServersByName[server.name]!;
                        return [server.name, server.transport.kind === 'http' || server.transport.kind === 'sse'
                            ? { ...original, config: { ...original.config, remote: { ...original.config.remote!, url: server.transport.url } } } : original];
                    })) };
                }
                mcpMaterial = await materializeMcpServerConfigRecord({
                    resolved: { directory: params.directory, strictMode: selected.strictMode, serversByName: selected.selectedServersByName },
                    savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot),
                    processEnv: { ...process.env, ...params.sourceEnvironment }, tmpDir: null,
                });
                const settings = readMcpServersSettingsFromAccountSettings(snapshot);
                const identities = { mcpServerIdentities: Object.fromEntries(Object.entries(selected.mcpServerIdentities)
                    .filter(([name]) => Object.hasOwn(mcpMaterial!.mcpServers, name))) };
                mcpServers = await resolveAgentSessionMcpLaunchConfigs(mcpMaterial.mcpServers, params.start, signal);
                mcpServersStrictMode = selected.strictMode;
                resolvedRunMcpServers = projectResolvedMcpServers({ mcpServers: mcpMaterial.mcpServers,
                    identities: identities.mcpServerIdentities, scope: { executionRunId: runId, directory: params.directory } });
                const capturedMcpAccount = params.resolveAccountSettingsSnapshot?.readOperationContext?.();
                const activeScope = getActiveAccountSettingsSnapshot()?.scopeKey;
                const activeLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
                if (capturedMcpAccount && capturedMcpAccount.readSnapshot()?.scopeKey === snapshot.scopeKey) {
                    readMcpToolContext = () => ({ mcpServerIdentities: identities.mcpServerIdentities, catalog: capturedMcpAccount.readSnapshot()?.mcpServerCatalog ?? null });
                } else if (activeScope && activeScope === snapshot.scopeKey && getActiveAccountSettingsSnapshot()?.mcpServerCatalog?.status === 'ready') {
                    readMcpToolContext = () => ({ mcpServerIdentities: identities.mcpServerIdentities,
                        prepareCatalog: async () => params.resolveAccountSettingsSnapshot?.({ mcpServerCatalog: true, signal }),
                        catalog: getActiveAccountSettingsSnapshot()?.scopeKey === activeScope
                            && getActiveAccountSettingsSnapshotLifetimeToken() === activeLifetime
                            ? getActiveAccountSettingsSnapshot()?.mcpServerCatalog ?? null : null });
                }
                if (readMcpToolContext()) {
                    const control = readAgentCatalogSnapshot().catalogEntriesById[params.lease.agentId]?.mcpToolControl;
                    if (control?.approval === 'host') {
                        mcpToolPolicy = projectMcpToolLaunchPolicies({ catalog: { v: 1, servers: settings.servers, bindings: settings.bindings,
                            ...(settings.pluginServers ? { pluginServers: settings.pluginServers } : {}) },
                            mcpServerIdentities: identities.mcpServerIdentities, control,
                            permissionMode: parseAgentPermissionIntentV1Alias(params.permissionMode) ?? 'default' });
                    }
                }
                signal.throwIfAborted();
            }
            const created = createNativeAgentInvocationContext({
                lease: params.lease,
                runId,
                signal,
                services: bound.services,
                invokedAtMs: Date.now(),
                currentSession: bound.currentSession,
                executionRunServices,
                ...(readActiveTurnAdmissionWitness ? { readActiveTurnAdmissionWitness } : {}),
                ...(params.resolveAcpHostLaunch || params.transformAgentRequest || params.acpRuntimeDefinition
                    ? {
                        protocolOptions: {
                            ...(params.resolveAcpHostLaunch ? { resolveHostLaunch: params.resolveAcpHostLaunch } : {}),
                            ...(params.acpRuntimeDefinition ? { runtimeDefinition: params.acpRuntimeDefinition } : {}),
                            ...(params.transformAgentRequest ? { transformAgentRequest: params.transformAgentRequest } : {}),
                        },
                    }
                    : {}),
            });
            if (!('executionRun' in created)) {
                throw new Error('Detached execution-run context was not constructed');
            }
            context = created;
        } catch (error) {
            try {
                try { mcpMaterial?.cleanup(); }
                finally { try { await disposeAttachments(); } finally { await executionRunServices.dispose(); } }
            } finally {
                await runPermissionScope.dispose('Execution run context construction failed');
            }
            throw error;
        }
        return Object.freeze({
            context,
            ...(mcpServers ? { mcpServers } : {}),
            ...(mcpServersStrictMode !== undefined ? { mcpServersStrictMode } : {}),
            ...(mcpToolPolicy ? { mcpToolPolicy } : {}),
            async dispose() {
                try {
                    try { mcpMaterial?.cleanup(); }
                    finally { try { await disposeAttachments(); } finally { await executionRunServices.dispose(); } }
                } finally {
                    await runPermissionScope.dispose('Execution run disposed');
                }
            },
        });
    };
    Object.assign(factory, {
        async resolveStructuredInputForDispatch(input: Readonly<{
            input: AgentSessionInput;
            localId: string;
            signal: AbortSignal;
        }>) {
            const parsed = HappierStructuredInputV1Schema.safeParse(input.input.structuredInput);
            if (!parsed.success) return input.input;
            const envelope = parsed.data as Readonly<Record<string, unknown>>;
            if (!Object.hasOwn(envelope, 'mentions') && !Object.hasOwn(envelope, 'composerAttachments')) {
                return input.input;
            }
            const resolved = await resolveStructuredInputProviderDispatchContext({
                structuredInput: parsed.data,
                ...(params.runtimeRegistry?.composerReferences
                    ? {
                        composerReferences: {
                            resolve: params.runtimeRegistry.composerReferences.resolve,
                            signal: input.signal,
                        },
                    }
                    : {}),
                ...(params.runtimeRegistry?.composerAttachments
                    ? {
                        composerAttachments: {
                            scope: { kind: 'execution_run', executionRunId: runId },
                            localId: input.localId,
                            resolve: params.runtimeRegistry.composerAttachments.resolveForDispatch,
                            signal: input.signal,
                        },
                    }
                    : {}),
            });
            return Object.freeze({
                text: renderSessionInputContextPromptV1({
                    ...resolved.promptContext,
                    transformedUserText: input.input.text,
                }),
                ...(resolved.structuredInput ? { structuredInput: resolved.structuredInput } : {}),
            });
        },
        async bindInvocationServices(input: Readonly<{
            services: PluginServices;
            signal: AbortSignal;
            readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
        }>) {
            return (await bindInvocationServices(input)).services;
        },
        respondToPermissionRequest(requestId: string, approved: boolean) {
            return runPermissionScope.respondToPermissionRequest(requestId, approved);
        },
        async abortPendingPermissionRequests(reason: string) {
            await runPermissionScope.dispose(reason);
        },
        async onTurnTerminal(turnId: string) {
            await params.getPermissionRequestStore?.()?.retireCompletedRequestsForTurn?.(turnId);
        },
    });
    return factory;
}

function diagnosticMessage(
    diagnostic: Readonly<{ code: string; message?: string }> | undefined,
    sanitize: (value: string) => string,
): string {
    return sanitize(diagnostic?.message ?? diagnostic?.code ?? 'Native Agent execution run failed');
}

function createDisposedError(): Error {
    const error = new Error('Native Agent execution run disposed');
    error.name = 'AbortError';
    return error;
}

function toHostMessage(
    event: AgentExecutionRunEvent,
    sanitize: (value: string) => string,
): AgentMessage | null {
    switch (event.kind) {
        case 'run-start':
        case 'run-progress':
            return { type: 'status', status: 'running' };
        case 'output-delta':
            return event.channel === 'assistant'
                ? { type: 'model-output', textDelta: event.text,
                    ...(event.messageId ? { messageId: event.messageId } : {}) }
                : { type: 'event', name: 'thinking', payload: { textDelta: event.text } };
        case 'output-message-committed':
            return { type: 'model-output', messageId: event.messageId, fullText: event.text };
        case 'checkpoint':
            return {
                type: 'event',
                name: 'provider_session_id',
                payload: { sessionId: event.checkpointId },
            };
        case 'run-complete':
        case 'run-cancelled':
            return { type: 'status', status: 'stopped' };
        case 'run-failed':
            return {
                type: 'status',
                status: 'error',
                detail: diagnosticMessage(event.diagnostic, sanitize),
            };
    }
}

function sessionEventToHostMessage(
    event: AgentSessionRuntimeEvent,
    sanitize: (value: string) => string,
): AgentMessage | null {
    switch (event.kind) {
        case 'message-delta':
            if (!isForegroundTurnRuntimeTranscriptEvent(event)) return null;
            return event.channel === 'assistant'
                ? { type: 'model-output', textDelta: event.text,
                    ...(event.messageId ? { messageId: event.messageId } : {}) }
                : { type: 'event', name: 'thinking', payload: { textDelta: event.text } };
        case 'transcript-message-committed':
            return event.role === 'assistant' && isForegroundTurnRuntimeTranscriptEvent(event)
                ? { type: 'model-output', messageId: event.messageId, fullText: event.text }
                : null;
        case 'provider-session-id':
            return { type: 'event', name: 'provider_session_id', payload: { sessionId: event.providerSessionId } };
        case 'turn-start':
        case 'turn-progress':
            return { type: 'status', status: 'running' };
        case 'turn-complete':
        case 'turn-cancelled':
            return { type: 'status', status: 'stopped' };
        case 'turn-failed':
            return {
                type: 'status',
                status: 'error',
                detail: sanitize(event.diagnostic.message ?? event.diagnostic.code),
            };
        case 'runtime-ended':
            return {
                type: 'status',
                status: 'error',
                detail: sanitize(event.diagnostic?.message ?? event.diagnostic?.code ?? event.cause),
            };
        default:
            return null;
    }
}

function buildInput(prompt: string, structuredInput: unknown): AgentSessionInput {
    const parsed = AgentRuntimeJsonValueV1Schema.safeParse(structuredInput);
    return Object.freeze({
        text: prompt,
        ...(structuredInput !== undefined && parsed.success ? { structuredInput: parsed.data } : {}),
    });
}

/** The Run's prepared metadata-only index follows its own Agent and selection. */
function withRunSkillIndex(input: AgentSessionInput, skillIndex: string | undefined): AgentSessionInput {
    return skillIndex ? { ...input, text: `${skillIndex}\n\n${input.text}` } : input;
}

function rejectStructuredInputBeforeProviderEffect(error: unknown) {
    const candidate = error && typeof error === 'object'
        ? error as Readonly<{ code?: unknown; message?: unknown; retryable?: unknown }>
        : null;
    return Object.freeze({
        status: 'rejected' as const,
        diagnostic: Object.freeze({
            code: typeof candidate?.code === 'string'
                ? candidate.code
                : 'session_structured_input_resolution_unavailable',
            ...(typeof candidate?.message === 'string' ? { message: candidate.message } : {}),
            severity: 'error' as const,
        }),
        retryable: candidate?.retryable === true,
    });
}

function readRequiredString(value: string | undefined, field: string): string {
    const normalized = value?.trim();
    if (!normalized) {
        throw new Error(`Native Agent execution run requires ${field}`);
    }
    return normalized;
}

function resolveExecutionProfileReference(
    profileId: string,
    fallbackPluginId: string,
): Readonly<{ pluginId: string; localId: string }> {
    const separatorIndex = profileId.indexOf('/');
    if (separatorIndex > 0) {
        const qualified = PluginContributionIdentityV1Schema.safeParse({
            pluginId: profileId.slice(0, separatorIndex),
            localId: profileId.slice(separatorIndex + 1),
        });
        if (qualified.success) return Object.freeze(qualified.data);
    }
    return Object.freeze(PluginContributionIdentityV1Schema.parse({
        pluginId: fallbackPluginId,
        localId: profileId,
    }));
}

function buildLaunchEnvironment(
    options: CreateCliExecutionRunBackendParams,
): AgentLaunchEnvironment {
    return resolveNativeAgentLaunchEnvironment({
        processEnv: process.env,
        environmentVariables: options.isolation?.env,
        unsetEnvironmentVariables: options.isolation?.unsetEnvKeys,
    });
}

function createNativeAgentInvocationContext(params: Readonly<{
    lease: NativeAgentRuntimeLeaseIdentity;
    runId: string;
    signal: AbortSignal;
    services: PluginServices;
    invokedAtMs: number;
    protocolOptions?: Pick<
        Parameters<typeof createPublicAcpRuntimeProtocols>[0],
        'resolveHostLaunch' | 'transformAgentRequest' | 'runtimeDefinition'
    >;
    currentSession?: Parameters<typeof createPluginInvocationPresentation>[0]['currentSession'];
    readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
    executionRunServices?: AgentExecutionRunHostServicesV1;
}>): AgentExecutionRunRuntimeContextV1 {
    const interactions = params.currentSession
        ? createPluginInteractionsService({
            currentSession: params.currentSession,
            signal: params.signal,
            isOccurrenceCurrent: params.lease.isCurrent,
            ...(params.readActiveTurnAdmissionWitness
                ? { readActiveTurnAdmissionWitness: params.readActiveTurnAdmissionWitness }
                : {}),
        })
        : null;
    const services = interactions
        ? Object.freeze({ ...params.services, interactions })
        : params.services;
    const nativeLaunch = issueAgentNativeLaunchQualifierForHost(services.exec);
    const base = Object.freeze({
        plugin: Object.freeze({ id: params.lease.pluginId, version: params.lease.pluginVersion }),
        contribution: Object.freeze({
            id: params.lease.localAgentId,
            qualifiedId: resolveAgentContributionQualifiedId({
                pluginId: params.lease.pluginId,
                localId: params.lease.localAgentId,
            }),
        }),
        surface: 'agent' as const,
        invokedAtMs: params.invokedAtMs,
        signal: params.signal,
        services,
        ui: createPluginInvocationPresentation({
            currentSession: params.currentSession ?? null,
            signal: params.signal,
            isOccurrenceCurrent: params.lease.isCurrent,
        }),
        agent: Object.freeze({ id: params.lease.agentId }),
        protocols: createPublicAcpRuntimeProtocols({
            pluginId: params.lease.pluginId,
            agentId: params.lease.agentId,
            signal: params.signal,
            isCurrent: params.lease.isCurrent,
            services,
            nativeLaunch,
            ...(params.currentSession
                ? { interactions: params.currentSession.interactions }
                : {}),
            ...(params.protocolOptions ?? {}),
        }),
    });
    const unavailable = (): never => {
        throw new Error('Detached execution-run host service is unavailable');
    };
    const executionRunServices = params.executionRunServices ?? Object.freeze({
        features: Object.freeze({ isEnabled: () => false }),
        hooks: Object.freeze({
            startServer: unavailable,
            resolveForwarderAssets: unavailable,
            createPluginDir: unavailable,
            disposePluginDir: unavailable,
        }),
        fileFollow: Object.freeze({ follow: unavailable }),
        mcp: Object.freeze({ resolveServers: async () => Object.freeze([]) }),
        toolExecution: Object.freeze({
            async before(request: Parameters<AgentExecutionRunHostServicesV1['toolExecution']['before']>[0]) {
                return Object.freeze({ status: 'continue' as const, input: request.input });
            },
        }),
    });
    return Object.freeze({
        ...base,
        scope: Object.freeze({ kind: 'execution_run' as const, executionRunId: params.runId }),
        executionRun: Object.freeze({ id: params.runId, services: Object.freeze({ ...executionRunServices, nativeLaunch }) }),
    });
}

export function createNativeAgentExecutionRunHostRuntime(params: Readonly<{
    runtime: AgentRuntime;
    /** Additive detached facet for a Session-primary Agent. */
    executionRunContextV1?: AgentSessionExecutionRunRuntimeFactoryV1;
    lease: NativeAgentRuntimeLeaseIdentity;
    options: CreateCliExecutionRunBackendParams;
    supportsResume: boolean;
    /** Session-derived carriers intercept native turn failures before this projection. */
    sessionTurnRecoveryOwned?: boolean;
    generationSignal?: AbortSignal;
    services?: Promise<PluginServices>;
    createExecutionRunContext?: NativeAgentExecutionRunContextLeaseFactory;
    bindInvocationServices?: NativeAgentSessionContextLeaseFactory['bindInvocationServices'];
    respondToPermissionRequest?: NativeAgentSessionContextLeaseFactory['respondToPermissionRequest'];
    abortPendingPermissionRequests?: (reason: string) => Promise<void>;
    resolveStructuredInputForDispatch?: NativeAgentSessionContextLeaseFactory['resolveStructuredInputForDispatch'];
}>): ExecutionRunHostRuntime {
    const directExecutionRuns = params.runtime.executionRuns;
    if (!params.executionRunContextV1 && !directExecutionRuns) {
        throw new Error(`Agent runtime '${params.lease.agentId}' does not support execution runs`);
    }
    const runId = readRequiredString(params.options.runId, 'a run id');
    const profileId = readRequiredString(
        // Host intent keys use underscores; portable contribution ids use hyphens.
        params.options.start?.profileId ?? params.options.start?.intent?.replaceAll('_', '-'),
        'an execution profile id',
    );
    const profile = resolveExecutionProfileReference(profileId, params.lease.pluginId);
    const launchEnvironment = buildLaunchEnvironment(params.options);
    const boundedOpenInputs = Object.freeze({
        stateSharing: resolveNativeAgentSessionStateSharingPolicy(params.lease.agentId),
        ...(launchEnvironment ? { launchEnvironment } : {}),
        ...(params.options.runtimeDescriptorV1
            ? { runtimeDescriptorV1: params.options.runtimeDescriptorV1 }
            : {}),
        ...(params.options.modelSelection
            ? { modelSelection: params.options.modelSelection }
            : {}),
        ...(params.options.configuration
            ? { configuration: params.options.configuration }
            : {}),
        ...(params.options.providerBinding
            ? { providerBinding: params.options.providerBinding }
            : {}),
        ...(params.options.causalPermissionAuthority
            ? { causalPermissionAuthority: params.options.causalPermissionAuthority }
            : {}),
    });
    const sanitizeProviderDiagnosticText =
        params.options.sanitizeProviderDiagnosticText ?? ((value: string) => value);
    const ownedAbortController = new AbortController();
    const signal = params.generationSignal
        ? AbortSignal.any([ownedAbortController.signal, params.generationSignal])
        : ownedAbortController.signal;
    const servicesPromise =
        params.services
        ?? Promise.resolve(createUnavailablePluginServices());
    const listeners = new Set<(message: AgentMessage) => void>();
    let provisionPromise: Promise<Readonly<{ runtimeId: string }>> | null = null;
    let openRequest: AgentExecutionRunOpenRequest | null = null;
    let nativeRuntimePromise: Promise<AgentExecutionRunRuntime> | null = null;
    let nativeRuntime: AgentExecutionRunRuntime | null = null;
    let watchDisposable: { dispose(): void | Promise<void> } | null = null;
    let executionRunContextLease: NativeAgentExecutionRunContextLease | null = null;
    let lastSequence = -1;
    let terminal = false;
    let disposed = false;
    let openingInitialInput = false;
    let providerWorkObserved = false;
    let rejectedStart: ExecutionRunRejectedStartError | null = null;
    let checkpointId: string | null = null;
    let recovery: AbortController | null = null;
    let admittedInputMeta: Parameters<AgentExecutionRunRuntime['send']>[1];
    let resolveTerminal!: () => void;
    let rejectTerminal!: (error: Error) => void;
    const terminalPromise = new Promise<void>((resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
    });
    void terminalPromise.catch(() => undefined);

    function logProviderFailure(phase: 'open' | 'send' | 'stop' | 'event', code: string): void {
        logger.warn('[EXECUTION RUN] provider failure', {
            runId,
            agentId: params.lease.agentId,
            phase,
            // Typed cause only: provider text/details may contain Account data or credentials.
            code: sanitizeProviderDiagnosticText(code),
            selectedMembers: readConnectedServiceChildMemberLogContextFromEnv(launchEnvironment?.values ?? {}),
        });
    }

    function assertUsable(): void {
        if (disposed) throw new Error('Native Agent execution run is disposed');
        if (!params.lease.isCurrent()) {
            throw new Error(`Agent runtime '${params.lease.agentId}' belongs to a retired generation`);
        }
        signal.throwIfAborted();
    }

    function emit(message: AgentMessage): void {
        for (const listener of listeners) {
            try {
                listener(message);
            } catch {
                // One host projection cannot interrupt terminal settlement or later listeners.
            }
        }
    }

    async function resolveInputForDispatch(input: AgentSessionInput, localId: string): Promise<AgentSessionInput> {
        return params.resolveStructuredInputForDispatch
            ? await params.resolveStructuredInputForDispatch({ input, localId, signal })
            : input;
    }

    function failRuntime(message: string, code?: string): void {
        if (terminal) return;
        terminal = true;
        const error = code ? createExecutionRunCodedError(code, message) : new Error(message);
        emit({ type: 'status', status: 'error', detail: message });
        rejectTerminal(error);
    }

    function settleEvent(normalizedEvent: AgentExecutionRunEvent): void {
        const message = toHostMessage(normalizedEvent, sanitizeProviderDiagnosticText);
        if (message) emit(message);
        if (normalizedEvent.kind === 'run-complete' || normalizedEvent.kind === 'run-cancelled') {
            terminal = true;
            if (normalizedEvent.kind === 'run-complete' && !params.sessionTurnRecoveryOwned && params.options.connectedServiceRuntimeTurnCompleted) {
                void params.options.connectedServiceRuntimeTurnCompleted().then(resolveTerminal, resolveTerminal);
            } else resolveTerminal();
        } else if (normalizedEvent.kind === 'run-failed') {
            terminal = true;
            rejectTerminal(createExecutionRunCodedError(
                normalizedEvent.diagnostic?.code ?? 'agent_execution_run_failed',
                diagnosticMessage(normalizedEvent.diagnostic, sanitizeProviderDiagnosticText),
            ));
        }
    }

    async function recoverNativeFailure(
        failure: Extract<AgentExecutionRunEvent, { kind: 'run-failed' | 'run-cancelled' }>,
        nativeIdentity: string,
        attempt: AbortController,
    ): Promise<void> {
        const recoverySignal = AbortSignal.any([signal, attempt.signal]);
        try {
            const continued = await continueNativeRuntimeAfterFailure({
                input: {
                    diagnostic: failure.diagnostic!,
                    providerSessionId: nativeIdentity,
                    interruptedOriginId: admittedInputMeta?.localInputId ?? params.options.start?.localInputId ?? `${runId}-initial-input`,
                    signal: recoverySignal,
                },
                prepare: params.options.prepareRuntimeFailureRecovery!,
                async retireNative() {
                    const previous = await nativeRuntimePromise;
                    await watchDisposable?.dispose();
                    watchDisposable = null;
                    nativeRuntime = null;
                    nativeRuntimePromise = null;
                    await previous?.dispose();
                    await executionRunContextLease?.dispose();
                    executionRunContextLease = null;
                },
                async resumeNative(environment) {
                    lastSequence = -1;
                    openRequest = {
                        kind: 'resume', runId, cwd: params.options.cwd, profile,
                        ...boundedOpenInputs,
                        ...(environment ? { launchEnvironment: environment } : {}),
                        checkpointId: nativeIdentity,
                    };
                    await openNative(openRequest);
                },
                async sendContinuation(input) {
                    recovery = null;
                    admittedInputMeta = {
                        ...admittedInputMeta,
                        localInputId: `runtime-continuation:${randomUUID()}`,
                    };
                    const result = await nativeRuntime!.send({ text: input }, {
                        ...admittedInputMeta,
                        signal: recoverySignal,
                    });
                    if (result.status !== 'admitted' && !terminal) {
                        settleEvent({ ...failure, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) });
                    }
                },
            });
            if (!continued && !terminal && recovery === attempt) {
                recovery = null;
                settleEvent(failure);
            }
        } catch (error) {
            if (terminal || disposed || recoverySignal.aborted) return;
            recovery = null;
            const diagnostic = error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? { code: error.code, message: sanitizeProviderDiagnosticText(error.message), severity: 'error' as const }
                : failure.diagnostic;
            settleEvent({ ...failure, ...(diagnostic ? { diagnostic } : {}) });
        }
    }

    function handleEvent(event: AgentExecutionRunEvent): void {
        const parsed = AgentExecutionRunEventSchema.safeParse(event);
        if (!parsed.success) {
            failRuntime(`Native Agent execution run '${runId}' emitted an invalid runtime event`);
            return;
        }
        const normalizedEvent = parsed.data;
        if (normalizedEvent.runId !== runId) {
            failRuntime(`Native Agent execution run emitted an event for unexpected run '${normalizedEvent.runId}'`);
            return;
        }
        if (normalizedEvent.sequence <= lastSequence) {
            failRuntime(`Native Agent execution run '${runId}' emitted a non-monotonic event sequence`);
            return;
        }
        if (terminal) return;
        lastSequence = normalizedEvent.sequence;
        if (normalizedEvent.kind === 'checkpoint') checkpointId = normalizedEvent.checkpointId;
        if (recovery && normalizedEvent.kind === 'run-cancelled') return;
        if (normalizedEvent.kind === 'run-progress' || normalizedEvent.kind === 'output-delta'
            || normalizedEvent.kind === 'output-message-committed'
            || normalizedEvent.kind === 'run-complete' || normalizedEvent.kind === 'run-cancelled') {
            providerWorkObserved = true;
        }
        if (normalizedEvent.kind === 'run-failed' && openingInitialInput && !providerWorkObserved) {
            const rejection = readExecutionRunRejectedStartDiagnostic(normalizedEvent.diagnostic);
            if (rejection) {
                logProviderFailure('event', rejection.executionRunErrorCode);
                rejectedStart = rejection;
                terminal = true;
                rejectTerminal(rejection);
                return;
            }
        }
        if (normalizedEvent.kind === 'run-failed') logProviderFailure('event', normalizedEvent.diagnostic?.code ?? 'agent_execution_run_failed');
        if (normalizedEvent.kind === 'run-failed' && normalizedEvent.diagnostic && checkpointId
            // This typed ACP outcome is admission uncertainty, not an accepted
            // turn failure. Provider health facts cannot authorize continuation.
            && normalizedEvent.diagnostic.code !== 'acp_input_custody_unknown'
            && normalizedEvent.diagnostic.code !== 'acp_input_rejected_before_effect'
            && params.supportsResume && params.options.prepareRuntimeFailureRecovery
            && !params.sessionTurnRecoveryOwned && !recovery) {
            const attempt = new AbortController();
            recovery = attempt;
            void recoverNativeFailure(normalizedEvent, checkpointId, attempt);
            return;
        }
        settleEvent(normalizedEvent);
    }

    async function openNative(request: AgentExecutionRunOpenRequest): Promise<AgentExecutionRunRuntime> {
        assertUsable();
        if (nativeRuntimePromise) return await nativeRuntimePromise;
        const invokedAtMs = Date.now();
        nativeRuntimePromise = (async () => {
            const fallbackServices = await servicesPromise;
            assertUsable();
            const context = params.createExecutionRunContext
                ? (executionRunContextLease = await params.createExecutionRunContext({
                    services: fallbackServices,
                    signal,
                })).context
                : createNativeAgentInvocationContext({
                    lease: params.lease,
                    runId,
                    signal,
                    services: params.bindInvocationServices
                        ? await params.bindInvocationServices({ services: fallbackServices, signal })
                        : fallbackServices,
                    invokedAtMs,
                });
            assertUsable();
            let providerCurrent: Awaited<ReturnType<NonNullable<
                CreateCliExecutionRunBackendParams['revalidateProviderBeforeOpen']
            >>> | undefined;
            try {
                providerCurrent = await params.options.revalidateProviderBeforeOpen?.();
            } catch (error) {
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
            if (providerCurrent && !providerCurrent.ok) {
                throw Object.assign(
                    new Error(providerCurrent.error.code),
                    { code: providerCurrent.error.code },
                );
            }
            assertUsable();
            let opened: AgentExecutionRunRuntime;
            const admittedRequest = {
                ...request,
                ...(request.kind === 'create' ? { input: withRunSkillIndex(request.input, executionRunContextLease?.skillIndex) } : {}),
                ...(executionRunContextLease?.mcpServers ? { mcpServers: executionRunContextLease.mcpServers } : {}),
                ...(executionRunContextLease?.mcpToolPolicy ? { mcpToolPolicy: executionRunContextLease.mcpToolPolicy } : {}),
                ...(executionRunContextLease?.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: executionRunContextLease.mcpServersStrictMode } : {}),
                ...(executionRunContextLease?.skills ? { skills: executionRunContextLease.skills } : {}),
            };
            if (params.executionRunContextV1) {
                if (!('executionRun' in context)) {
                    throw new Error('Session-primary detached execution requires execution-run scope');
                }
                opened = await params.executionRunContextV1.open(admittedRequest, context);
            } else {
                opened = await directExecutionRuns!.open(admittedRequest, context);
            }
            try {
                assertUsable();
                nativeRuntime = opened;
                openingInitialInput = request.kind === 'create';
                if (request.kind === 'resume') checkpointId = request.checkpointId;
                if (request.kind === 'create') admittedInputMeta = {
                    ...(request.localInputId ? { localInputId: request.localInputId } : {}),
                    ...(request.resultContract ? { resultContract: request.resultContract } : {}),
                    ...(request.causalPermissionAuthority ? { causalPermissionAuthority: request.causalPermissionAuthority } : {}),
                };
                watchDisposable = opened.watch(event => { if (nativeRuntime === opened) handleEvent(event); });
                if (rejectedStart) throw rejectedStart;
            } catch (error) {
                if (rejectedStart === error) throw error;
                await opened.dispose();
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            } finally {
                openingInitialInput = false;
            }
            return opened;
        })().catch((error: unknown) => {
            // An open that failed cannot supply future terminal events. Settle
            // the same completion fence observed by long-lived input custody.
            // The explicit pre-start rejection retains its identity for pool recovery.
            if (error === rejectedStart) throw error;
            const failure = sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            const code = readExecutionRunErrorCode(failure) ?? 'agent_execution_run_open_failed';
            logProviderFailure('open', code);
            failRuntime(failure.message, code);
            throw failure;
        });
        return await nativeRuntimePromise;
    }

    return Object.freeze({
        permissionCapability: params.respondToPermissionRequest ? 'responds' as const : 'static' as const,
        ...(params.respondToPermissionRequest
            ? {
                async respondToPermission(requestId: string, approved: boolean) {
                    return params.respondToPermissionRequest!(requestId, approved)
                        ? { delivered: true as const }
                        : { delivered: false as const, reason: 'unknown_request' as const };
                },
            }
            : {}),
        ...(params.abortPendingPermissionRequests
            ? { abortPendingPermissionRequests: params.abortPendingPermissionRequests }
            : {}),
        async readResumeSupport() {
            return params.supportsResume;
        },
        async provisionRuntime(options) {
            assertUsable();
            provisionPromise ??= (async () => {
                if (options?.resumeRuntimeId) {
                    if (!params.supportsResume) throw new Error('Backend does not support resume');
                    openRequest = Object.freeze({
                        kind: 'resume' as const,
                        runId,
                        cwd: params.options.cwd,
                        profile,
                        ...boundedOpenInputs,
                        checkpointId: options.resumeRuntimeId,
                    });
                    await openNative(openRequest);
                } else if (options?.initialPrompt !== undefined) {
                    const localId = params.options.start?.localInputId ?? `${runId}-initial-input`;
                    const input = await resolveInputForDispatch(
                        buildInput(
                            options.initialPrompt,
                            params.options.start?.structuredInput ?? params.options.start?.intentInput,
                        ),
                        localId,
                    );
                    openRequest = Object.freeze({
                        kind: 'create' as const,
                        runId,
                        cwd: params.options.cwd,
                        profile,
                        ...boundedOpenInputs,
                        input,
                        ...(params.options.start?.localInputId
                            ? { localInputId: params.options.start.localInputId }
                            : {}),
                        ...(params.options.start?.resultContract
                            ? { resultContract: params.options.start.resultContract }
                            : {}),
                    });
                    await openNative(openRequest);
                }
                return Object.freeze({ runtimeId: runId });
            })();
            return await provisionPromise;
        },
        getRuntimeLifetimeSignal: () => signal,
        async deliverInput(runtimeId, admittedInput, meta) {
            assertUsable();
            if (!provisionPromise || runtimeId !== runId) {
                throw new Error(`Native Agent execution run '${runId}' is not provisioned for runtime '${runtimeId}'`);
            }
            await provisionPromise;
            if (terminal) throw new Error(`Native Agent execution run '${runId}' has already terminated`);
            const localId = meta?.localId ?? params.options.start?.localInputId ?? `${runId}-input`;
            const carriedInput = admittedInput.structuredInput === undefined
                ? buildInput(
                    admittedInput.text,
                    params.options.start?.structuredInput ?? params.options.start?.intentInput,
                )
                : admittedInput;
            let input: AgentSessionInput;
            try {
                input = await resolveInputForDispatch(carriedInput, localId);
            } catch (error) {
                return rejectStructuredInputBeforeProviderEffect(error);
            }
            if (!nativeRuntimePromise) {
                openRequest = Object.freeze({
                    kind: 'create' as const,
                    runId,
                    cwd: params.options.cwd,
                    profile,
                    ...boundedOpenInputs,
                    ...(meta?.causalPermissionAuthority
                        ? { causalPermissionAuthority: meta.causalPermissionAuthority }
                        : {}),
                    ...(meta?.localId || params.options.start?.localInputId
                        ? { localInputId: meta?.localId ?? params.options.start?.localInputId }
                        : {}),
                    ...(meta?.resultContract || params.options.start?.resultContract
                        ? { resultContract: meta?.resultContract ?? params.options.start?.resultContract }
                        : {}),
                    input,
                });
                await openNative(openRequest);
                return { status: 'admitted' as const };
            }
            const opened = await nativeRuntimePromise;
            admittedInputMeta = { ...meta, localInputId: localId };
            let result: Awaited<ReturnType<AgentExecutionRunRuntime['send']>>;
            try {
                result = await opened.send(input, {
                    signal,
                    ...(meta?.localId ? { localInputId: meta.localId } : {}),
                    ...(meta?.resultContract ? { resultContract: meta.resultContract } : {}),
                    ...(meta?.causalPermissionAuthority
                        ? { causalPermissionAuthority: meta.causalPermissionAuthority }
                        : {}),
                });
            } catch (error) {
                logProviderFailure('send', readExecutionRunErrorCode(error) ?? 'agent_execution_run_send_failed');
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
            if (result.status !== 'admitted') {
                const message = diagnosticMessage(result.diagnostic, sanitizeProviderDiagnosticText);
                const code = result.diagnostic?.code ?? 'agent_execution_run_failed';
                logProviderFailure('send', code);
                failRuntime(message, code);
                throw createExecutionRunCodedError(code, message);
            }
            // The execution-run-native surface has a deliberately looser
            // refusal shape than Agent Session delivery. Non-admission was
            // converted to an exception above, so expose only the proven
            // admitted arm at this adapter boundary.
            return { status: 'admitted' as const };
        },
        async cancel(runtimeId) {
            assertUsable();
            if (!provisionPromise || runtimeId !== runId) return;
            if (recovery) {
                recovery.abort(new Error('Execution Run recovery cancelled'));
                recovery = null;
                terminal = true;
                emit({ type: 'status', status: 'stopped' });
                resolveTerminal();
                return;
            }
            const opened = nativeRuntime ?? (nativeRuntimePromise ? await nativeRuntimePromise : null);
            if (!opened) return;
            let result: Awaited<ReturnType<AgentExecutionRunRuntime['stop']>>;
            try {
                result = await opened.stop({ signal });
            } catch (error) {
                logProviderFailure('stop', readExecutionRunErrorCode(error) ?? 'agent_execution_run_stop_failed');
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
            if (result.status === 'unavailable' || result.status === 'unsupported') {
                throw new Error(`Native Agent execution run stop is ${result.status}`);
            }
        },
        subscribeMessages(handler) {
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        async waitForTurnCompletion() {
            if (!nativeRuntimePromise && !recovery) return;
            await terminalPromise;
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            // The existing terminal fence settles completion waiters first, so
            // waiter settlement and controller retirement are independent of
            // any never-settling provider open or dispose below.
            if (nativeRuntimePromise && !terminal) {
                terminal = true;
                rejectTerminal(createDisposedError());
            }
            ownedAbortController.abort(new Error('Native Agent execution run disposed'));
            recovery?.abort(new Error('Execution Run recovery disposed'));
            recovery = null;
            const watch = watchDisposable;
            watchDisposable = null;
            listeners.clear();
            // Cleanup is attempted exactly once, best effort: it must not
            // block this return on a provider open that never settles, and a
            // provider cleanup failure is logged nowhere the caller depends
            // on. A late-settling open is disposed when it settles.
            const cleanupOpened = (opened: AgentExecutionRunRuntime | null): void => {
                if (!opened) return;
                void Promise.resolve().then(() => opened.dispose()).catch(() => undefined);
            };
            if (nativeRuntime) {
                cleanupOpened(nativeRuntime);
            } else if (nativeRuntimePromise) {
                void nativeRuntimePromise.then(cleanupOpened, () => undefined);
            }
            if (watch) {
                void Promise.resolve().then(() => watch.dispose()).catch(() => undefined);
            }
            const contextLease = executionRunContextLease;
            executionRunContextLease = null;
            if (contextLease) {
                void contextLease.dispose().catch(() => undefined);
            }
        },
    });
}

/**
 * Host-owned finite Run projection for an Agent whose provider-native owner is
 * a Session runtime. A parent Session supplies its complete host context;
 * detached Runs supply only the run-scoped context required by the runtime.
 */
export function createNativeAgentSessionExecutionRunHostRuntime(params: Readonly<{
    runtime: AgentRuntime;
    lease: NativeAgentRuntimeLeaseIdentity;
    options: CreateCliExecutionRunBackendParams;
    supportsResume: boolean;
    generationSignal?: AbortSignal;
    services?: Promise<PluginServices>;
    createSessionContext: NativeAgentSessionContextLeaseFactory;
}>): ExecutionRunHostRuntime {
    const sessions = params.runtime.sessions;
    if (!sessions) {
        throw new Error(`Agent runtime '${params.lease.agentId}' does not support sessions`);
    }
    const executionRuns: AgentExecutionRunRuntimeFactory = Object.freeze({
        async open(
            request: AgentExecutionRunOpenRequest,
            executionContext: AgentRuntimeContext,
        ) {
                if (request.kind === 'fork') {
                    throw new Error('Host-derived Session execution runs do not support fork');
                }
                let sourceSession: AgentSessionRuntime | null = null;
                const sessionContext = await params.createSessionContext({
                    services: executionContext.services,
                    signal: executionContext.signal,
                    readSessionRuntime: () => sourceSession,
                });
                const readBoundaryError = (): Error | null => {
                    if (!params.lease.isCurrent()) {
                        return new Error(
                            `Agent runtime '${params.lease.agentId}' belongs to a retired generation`,
                        );
                    }
                    if (!executionContext.signal.aborted) return null;
                    return executionContext.signal.reason instanceof Error
                        ? executionContext.signal.reason
                        : Object.assign(
                            new Error('Agent execution run was aborted'),
                            { name: 'AbortError' },
                        );
                };
                const contextBoundaryError = readBoundaryError();
                if (contextBoundaryError) {
                    try {
                        await sessionContext.dispose();
                    } catch {
                        // Preserve the currentness/abort refusal after host-context cleanup was attempted.
                    }
                    throw contextBoundaryError;
                }
                let execution: AgentExecutionRunRuntime;
                let unsubscribeMcpToolPolicy: (() => void) | undefined;
                try {
                    const runScopedContext: AgentSessionRuntimeContext = Object.freeze({
                        ...withRunScopedSessionHooks(sessionContext.context),
                        // A finite child Run may reuse its parent's Session context
                        // services, but it never owns the parent's published work state.
                        workState: createRunScopedWorkStateService(executionContext.signal),
                    });
                    const openNativeSession = async (sessionRequest: Extract<AgentSessionOpenRequest, { kind: 'create' | 'resume' }>) => {
                        const opened = await sessions.open(sessionRequest, runScopedContext);
                        sourceSession = opened;
                        let boundaryError = readBoundaryError();
                        if (!boundaryError && opened.skillsDelivered === false && sessionContext.skills && sessionContext.capabilityNoticeSession) {
                            await publishSkillLaunchNotice(sessionContext.capabilityNoticeSession, sessionContext.skills);
                            boundaryError = readBoundaryError();
                        }
                        if (boundaryError) {
                            void Promise.resolve().then(() => opened.dispose('runtime_recovery')).catch(() => undefined);
                            throw boundaryError;
                        }
                        return opened;
                    };
                    execution = await createExecutionRunHostBackendFromSessionRuntime({
                        request: {
                            ...request,
                            ...(request.kind === 'create' ? { input: withRunSkillIndex(request.input, sessionContext.skillIndex) } : {}),
                            ...(sessionContext.mcpServers ? { mcpServers: sessionContext.mcpServers } : {}),
                            ...(sessionContext.mcpToolPolicy ? { mcpToolPolicy: sessionContext.mcpToolPolicy } : {}),
                            ...(sessionContext.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: sessionContext.mcpServersStrictMode } : {}),
                            ...(sessionContext.skills ? { skills: sessionContext.skills } : {}),
                        },
                        sessionId: sessionContext.context.session.id,
                        openSession: async (sessionRequest) => {
                            const native = await openNativeSession(sessionRequest);
                            const opened = params.supportsResume && params.options.prepareRuntimeFailureRecovery
                                ? createRecoveringAgentSessionRuntime({
                                    session: native,
                                    request: sessionRequest,
                                    openSession: openNativeSession,
                                    recover: params.options.prepareRuntimeFailureRecovery,
                                    ...(params.options.connectedServiceRuntimeTurnCompleted ? { onTurnCompleted: params.options.connectedServiceRuntimeTurnCompleted } : {}),
                                    signal: executionContext.signal,
                                })
                                : native;
                            unsubscribeMcpToolPolicy = sessionContext.subscribeMcpToolPolicy?.(mcpToolPolicy => {
                                if (readBoundaryError()) return;
                                const configuration = sessionRequest.configuration;
                                if (!configuration || !opened.updateConfiguration) {
                                    logger.warn('[MCP] Native Session Run configuration update is unavailable');
                                    return;
                                }
                                const update = applyNativeAgentConfigurationUpdate(configuration, { mcpToolPolicy });
                                void opened.updateConfiguration(update.request).then(result => {
                                    if (result.status !== 'applied' && result.status !== 'deferred') logger.warn('[MCP] Native Session Run policy update was not applied');
                                }).catch(() => { logger.warn('[MCP] Native Session Run policy update failed'); });
                            });
                            return opened;
                        },
                        readCheckpointId: (event) => event.kind === 'provider-session-id'
                            ? event.providerSessionId
                            : null,
                        ...(sessionContext.usagePublisher || params.options.start?.observeWorkflowUsage || sessionContext.observeSkillUse ? {
                            observeSessionUsage: (event: Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' | 'skill-usage' }>) => {
                                if (event.kind === 'skill-usage') {
                                    if (!readBoundaryError()) void sessionContext.observeSkillUse?.(event).catch(() => undefined);
                                    return;
                                }
                                const publisher = sessionContext.usagePublisher;
                                const observation = toNativeAgentUsageObservation(
                                    event,
                                    publisher?.provider ?? params.lease.agentId,
                                );
                                params.options.start?.observeWorkflowUsage?.({
                                    turnId: event.turnId ?? null,
                                    observation,
                                });
                                if (publisher) {
                                    void Promise.resolve(publisher.publish({
                                        observedAt: event.emittedAtMs,
                                        observation,
                                        turnId: event.turnId ?? null,
                                        externalKey: event.observationId,
                                    })).catch(() => undefined);
                                }
                            },
                        } : {}),
                    });
                } catch (error) {
                    unsubscribeMcpToolPolicy?.();
                    try {
                        await sessionContext.dispose();
                    } catch {
                        // Preserve the Session open/admission failure after cleanup was attempted.
                    }
                    throw error;
                }
                let disposed = false;
                return Object.freeze({
                    send: (input: AgentSessionInput, options?: Parameters<AgentExecutionRunRuntime['send']>[1]) =>
                        execution.send(withRunSkillIndex(input, sessionContext.skillIndex), options),
                    stop: execution.stop.bind(execution),
                    watch: execution.watch.bind(execution),
                    async dispose() {
                        if (disposed) return;
                        disposed = true;
                        unsubscribeMcpToolPolicy?.();
                        // The SDK lifecycle has already settled terminal truth.
                        // Both native cleanup leaves are exactly-once, detached,
                        // and best effort so neither can retain the controller.
                        void Promise.resolve().then(() => execution.dispose())
                            .catch(() => undefined);
                        void Promise.resolve().then(() => sessionContext.dispose())
                            .catch(() => undefined);
                    },
                });
        },
    });
    const derivedRuntime: AgentRuntime = Object.freeze({
        executionRuns,
    });
    return createNativeAgentExecutionRunHostRuntime({
        runtime: derivedRuntime,
        sessionTurnRecoveryOwned: true,
        lease: params.lease,
        options: params.options,
        supportsResume: params.supportsResume,
        ...(params.generationSignal ? { generationSignal: params.generationSignal } : {}),
        ...(params.services ? { services: params.services } : {}),
        ...(params.createSessionContext.respondToPermissionRequest
            ? { respondToPermissionRequest: params.createSessionContext.respondToPermissionRequest }
            : {}),
        ...(params.createSessionContext.abortPendingPermissionRequests
            ? { abortPendingPermissionRequests: params.createSessionContext.abortPendingPermissionRequests }
            : {}),
        ...(params.createSessionContext.resolveStructuredInputForDispatch
            ? { resolveStructuredInputForDispatch: params.createSessionContext.resolveStructuredInputForDispatch }
            : {}),
    });
}

/**
 * Host-owned retained Session interaction used by multi-turn consumers such as
 * Voice. It deliberately bypasses finite Execution Run terminal semantics and
 * reuses the canonical native Session turn/custody controller for every turn.
 */
export function createNativeAgentSessionInteractionHostRuntime(params: Readonly<{
    runtime: AgentRuntime;
    lease: NativeAgentRuntimeLeaseIdentity;
    options: CreateCliExecutionRunBackendParams;
    /**
     * One declared capability set owns both resume admission and the controls
     * this retained interaction may offer.
     */
    sessionCapabilities: AgentSessionCapabilities;
    generationSignal?: AbortSignal;
    services?: Promise<PluginServices>;
    createSessionContext: NativeAgentSessionContextLeaseFactory;
}>): ExecutionRunHostRuntime {
    const sessions = params.runtime.sessions;
    if (!sessions) {
        throw new Error(`Agent runtime '${params.lease.agentId}' does not support sessions`);
    }
    const supportsResume = params.sessionCapabilities.open.includes('resume');
    const runId = readRequiredString(params.options.runId, 'a run id');
    const launchEnvironment = buildLaunchEnvironment(params.options);
    const sanitize = params.options.sanitizeProviderDiagnosticText ?? ((value: string) => value);
    const ownedAbortController = new AbortController();
    const signal = params.generationSignal
        ? AbortSignal.any([ownedAbortController.signal, params.generationSignal])
        : ownedAbortController.signal;
    const servicesPromise = params.services ?? Promise.resolve(createUnavailablePluginServices());
    const listeners = new Set<(message: AgentMessage) => void>();
    const inputOutcomeListeners = new Set<(outcome: SessionProviderInputOutcome) => void>();
    const runtimeEventListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    let operations: ReturnType<typeof createNativeAgentSessionInteractionOperations> | null = null;
    let unsubscribeEvents: (() => void) | null = null;
    let disposeSessionContext: (() => Promise<void>) | null = null;
    let openPromise: Promise<void> | null = null;
    let provisionPromise: Promise<Readonly<{ runtimeId: string }>> | null = null;
    let disposed = false;
    let turnOrdinal = 0;
    let pendingTurnTerminalSettlement: Promise<void> | null = null;
    let pendingTurnInputId: string | null = null;
    let pendingTurnAdmissionFailure: Error | null = null;
    let resumedProviderSessionId: string | null = null;
    let skillIndex: string | undefined;

    const assertUsable = (): void => {
        if (disposed) throw new Error('Native Agent Session interaction is disposed');
        if (!params.lease.isCurrent()) {
            throw new Error(`Agent runtime '${params.lease.agentId}' belongs to a retired generation`);
        }
        signal.throwIfAborted();
    };
    const emit = (message: AgentMessage): void => {
        for (const listener of listeners) {
            try {
                listener(message);
            } catch {
                // One Voice projection cannot interrupt the retained Session owner.
            }
        }
    };
    const open = async (resumeSessionId?: string): Promise<void> => {
        assertUsable();
        if (openPromise) return await openPromise;
        openPromise = (async () => {
            const services = await servicesPromise;
            assertUsable();
            let sourceSession: AgentSessionRuntime | null = null;
            const sessionContext = await params.createSessionContext({
                services,
                signal,
                readSessionRuntime: () => sourceSession,
                readActiveTurnAdmissionWitness: () => operations?.readActiveTurnAdmissionWitness?.() ?? null,
            });
            // Context acquisition can await plugin/daemon work. Re-check the
            // generation before invoking the provider so retirement cannot
            // trigger a native open side effect after this host is unusable.
            try {
                assertUsable();
            } catch (error) {
                await sessionContext.dispose();
                throw error;
            }
            const context = withRunScopedSessionHooks(sessionContext.context);
            skillIndex = sessionContext.skillIndex;
            let unsubscribeMcpToolPolicy: (() => void) | undefined;
            disposeSessionContext = async () => { unsubscribeMcpToolPolicy?.(); await sessionContext.dispose(); };
            const common = {
                sessionId: context.session.id,
                cwd: params.options.cwd,
                ...(sessionContext.mcpServers ? { mcpServers: sessionContext.mcpServers } : {}),
                ...(sessionContext.mcpToolPolicy ? { mcpToolPolicy: sessionContext.mcpToolPolicy } : {}),
                ...(sessionContext.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: sessionContext.mcpServersStrictMode } : {}),
                ...(sessionContext.skills ? { skills: sessionContext.skills } : {}),
                stateSharing: resolveNativeAgentSessionStateSharingPolicy(params.lease.agentId),
                ...(launchEnvironment ? { launchEnvironment } : {}),
                ...(params.options.runtimeDescriptorV1
                    ? { runtimeDescriptorV1: params.options.runtimeDescriptorV1 }
                    : {}),
                ...(params.options.modelSelection ? { modelSelection: params.options.modelSelection } : {}),
                ...(params.options.configuration ? { configuration: params.options.configuration } : {}),
                ...(params.options.providerBinding ? { providerBinding: params.options.providerBinding } : {}),
            };
            const request: AgentSessionOpenRequest = resumeSessionId
                ? { ...common, kind: 'resume', providerSessionId: resumeSessionId }
                : { ...common, kind: 'create' };
            let opened: AgentSessionRuntime | null = null;
            try {
                opened = await sessions.open(request, context);
                sourceSession = opened;
                assertUsable();
                if (opened.skillsDelivered === false && sessionContext.skills && sessionContext.capabilityNoticeSession) {
                    await publishSkillLaunchNotice(sessionContext.capabilityNoticeSession, sessionContext.skills);
                    assertUsable();
                }
                if (supportsResume && params.options.prepareRuntimeFailureRecovery) {
                    opened = createRecoveringAgentSessionRuntime({
                        session: opened,
                        request,
                        openSession: async request => {
                            const resumed = await sessions.open(request, context);
                            sourceSession = resumed;
                            try {
                                assertUsable();
                                if (resumed.skillsDelivered === false && sessionContext.skills && sessionContext.capabilityNoticeSession) {
                                    await publishSkillLaunchNotice(sessionContext.capabilityNoticeSession, sessionContext.skills);
                                    assertUsable();
                                }
                                return resumed;
                            } catch (error) {
                                void Promise.resolve().then(() => resumed.dispose('runtime_recovery')).catch(() => undefined);
                                throw error;
                            }
                        },
                        recover: params.options.prepareRuntimeFailureRecovery,
                        ...(params.options.connectedServiceRuntimeTurnCompleted ? { onTurnCompleted: params.options.connectedServiceRuntimeTurnCompleted } : {}),
                        signal,
                    });
                }
                operations = createNativeAgentSessionInteractionOperations({
                    session: opened,
                    sessionId: context.session.id,
                    cwd: params.options.cwd,
                    context,
                    capabilities: params.sessionCapabilities,
                    ...(sessionContext.usagePublisher || params.options.start?.observeWorkflowUsage ? {
                        usagePublisher: {
                            provider: sessionContext.usagePublisher?.provider ?? params.lease.agentId,
                            publish(input) {
                                params.options.start?.observeWorkflowUsage?.({
                                    turnId: input.turnId,
                                    observation: input.observation,
                                });
                                return sessionContext.usagePublisher?.publish(input);
                            },
                        },
                    } : {}),
                    ...(resumeSessionId ? { expectedProviderSessionId: resumeSessionId } : {}),
                    ...(params.options.configuration
                        ? { initialConfiguration: params.options.configuration }
                        : {}),
                });
                unsubscribeMcpToolPolicy = sessionContext.subscribeMcpToolPolicy?.(mcpToolPolicy => {
                    if (!operations || disposed || signal.aborted || !params.lease.isCurrent()) return;
                    void operations.updateSessionRuntimeConfig({ mcpToolPolicy }).then(result => {
                        if (!result || result.status !== 'applied') logger.warn('[MCP] Retained Session Run policy update was not applied');
                    }).catch(() => { logger.warn('[MCP] Retained Session Run policy update failed'); });
                });
                // A successful native resume admitted this existing vendor id.
                // Fresh sessions remain unknown until validated provider evidence.
                resumedProviderSessionId = resumeSessionId ?? null;
                operations.setOnPromptDeliveryOutcome((evidence) => {
                    const outcome = normalizeHostProviderInputOutcome(evidence);
                    if (!outcome) return;
                    if (outcome.localId === pendingTurnInputId && outcome.kind === 'rejected_before_effect') {
                        pendingTurnAdmissionFailure = createExecutionRunCodedError(
                            outcome.diagnostic.code,
                            diagnosticMessage(outcome.diagnostic, sanitize),
                        );
                    }
                    for (const listener of inputOutcomeListeners) listener(outcome);
                });
                unsubscribeEvents = operations.subscribeRuntimeEvents((event) => {
                    if ('type' in event) return;
                    if (event.kind === 'skill-usage' && !disposed && !signal.aborted && params.lease.isCurrent()) {
                        void sessionContext.observeSkillUse?.(event).catch(() => undefined);
                    }
                    for (const listener of runtimeEventListeners) listener(event);
                    if (
                        event.kind === 'turn-complete'
                        || event.kind === 'turn-failed'
                        || event.kind === 'turn-cancelled'
                    ) {
                        const settlement = Promise.resolve(
                            params.createSessionContext.onTurnTerminal?.(event.turnId),
                        );
                        pendingTurnTerminalSettlement = settlement;
                        // The turn-completion waiter below owns propagation. Attach
                        // an observer immediately so a synchronous persistence
                        // rejection cannot become an unhandled promise first.
                        void settlement.catch(() => undefined);
                    }
                    const message = sessionEventToHostMessage(event, sanitize);
                    if (message) emit(message);
                });
            } catch (error) {
                try {
                    await opened?.dispose('runtime_recovery');
                } finally {
                    await disposeSessionContext?.();
                    disposeSessionContext = null;
                }
                throw error;
            }
        })().catch(error => {
            throw sanitizeThrownError(error, sanitize);
        });
        return await openPromise;
    };

    const waitForTurnCompletion = async (timeoutMs?: number | null): Promise<void> => {
        if (!operations) return;
        let completionError: unknown = null;
        try {
            await operations.waitForTurnCompletion({ timeoutMs: timeoutMs ?? null });
        } catch (error) {
            completionError = error;
        }
        // A native refusal never started a turn. The Session owner returns to
        // idle, but this Run still owes its caller a failed operation/result.
        completionError ??= pendingTurnAdmissionFailure;
        pendingTurnInputId = null;
        const settlement = pendingTurnTerminalSettlement;
        if (settlement) {
            try {
                await settlement;
            } catch (error) {
                if (!isWorkflowInteractionCapacityError(error)) throw error;
                throw Object.assign(
                    createExecutionRunCodedError(WORKFLOW_INTERACTION_CAPACITY_EXCEEDED, error.message),
                    { code: WORKFLOW_INTERACTION_CAPACITY_EXCEEDED, recoverable: true as const },
                );
            } finally {
                if (pendingTurnTerminalSettlement === settlement) pendingTurnTerminalSettlement = null;
            }
        }
        if (!completionError) return;
        const event = readRuntimeTurnFailureAlreadySurfacedEvent(completionError);
        if (event?.diagnostic.code !== WORKFLOW_INTERACTION_CAPACITY_EXCEEDED) {
            if (!event) throw sanitizeThrownError(completionError, sanitize);
            throw createRuntimeTurnFailureAlreadySurfacedError({
                message: sanitize(completionError instanceof Error ? completionError.message : event.diagnostic.code),
                event: {
                    ...event,
                    diagnostic: {
                        ...event.diagnostic,
                        ...(event.diagnostic.message ? { message: sanitize(event.diagnostic.message) } : {}),
                    },
                },
            });
        }
        throw Object.assign(
            createExecutionRunCodedError(
                WORKFLOW_INTERACTION_CAPACITY_EXCEEDED,
                sanitize(event.diagnostic.message ?? WORKFLOW_INTERACTION_CAPACITY_EXCEEDED),
            ),
            { code: WORKFLOW_INTERACTION_CAPACITY_EXCEEDED, recoverable: true as const },
        );
    };

    return Object.freeze({
        permissionCapability: params.createSessionContext.respondToPermissionRequest ? 'responds' as const : 'static' as const,
        ...(params.createSessionContext.abortPendingPermissionRequests
            ? { abortPendingPermissionRequests: params.createSessionContext.abortPendingPermissionRequests }
            : {}),
        ...(params.createSessionContext.respondToPermissionRequest
            ? {
                async respondToPermission(requestId: string, approved: boolean) {
                    return params.createSessionContext.respondToPermissionRequest!(requestId, approved)
                        ? { delivered: true as const }
                        : { delivered: false as const, reason: 'unknown_request' as const };
                },
            }
            : {}),
        getRuntimeLifetimeSignal: () => signal,
        readActiveTurnAdmissionWitness: () => operations?.readActiveTurnAdmissionWitness?.() ?? null,
        subscribeProviderInputOutcomes(handler) {
            inputOutcomeListeners.add(handler);
            return () => inputOutcomeListeners.delete(handler);
        },
        subscribeRuntimeEvents(handler) {
            runtimeEventListeners.add(handler);
            return () => runtimeEventListeners.delete(handler);
        },
        // The exact adapter choice is the projection. A finite or native Execution
        // Run adapter never carries it, so a transcript-only or reconstructed run
        // cannot appear interactive.
        interaction: Object.freeze({
            kind: 'retained_agent_session.v1' as const,
            capabilities: params.sessionCapabilities,
        }),
        async readResumeSupport() {
            return supportsResume;
        },
        readProviderSessionId() {
            if (!supportsResume) return null;
            return operations?.readSessionIdentity?.().sessionId ?? resumedProviderSessionId;
        },
        async canContinueAfterCancellation(timeoutMs) {
            if (!params.sessionCapabilities.cancel || !params.sessionCapabilities.delivery.includes('newTurn')) return false;
            try {
                assertUsable();
                // A never-delivered first turn has no completion to join. For
                // delivered turns the canonical owner also retires interactions.
                if (turnOrdinal > 0) await waitForTurnCompletion(timeoutMs);
                assertUsable();
                return operations?.canStartNewTurn?.() === true;
            } catch {
                return false;
            }
        },
        async provisionRuntime(options) {
            assertUsable();
            provisionPromise ??= (async () => {
                if (options?.resumeRuntimeId && !supportsResume) {
                    throw new Error('Backend does not support resume');
                }
                await open(options?.resumeRuntimeId);
                if (options?.initialPrompt !== undefined) {
                    const turnId = `${runId}-turn-${++turnOrdinal}`;
                    pendingTurnInputId = `${runId}-input-${turnOrdinal}`;
                    pendingTurnAdmissionFailure = null;
                    operations!.beginTurnLifecycle();
                    try {
                        await operations!.sendTurnPrompt(withRunSkillIndex({ text: options.initialPrompt }, skillIndex).text, {
                            turnId,
                            localId: pendingTurnInputId,
                            ...(params.options.causalPermissionAuthority
                                ? { causalPermissionAuthority: params.options.causalPermissionAuthority }
                                : {}),
                        });
                    } catch (error) {
                        throw pendingTurnAdmissionFailure ?? error;
                    }
                }
                return Object.freeze({ runtimeId: runId });
            })();
            return await provisionPromise;
        },
        async deliverInput(runtimeId, input, meta) {
            assertUsable();
            if (!provisionPromise || runtimeId !== runId) {
                throw new Error(`Native Agent Session interaction '${runId}' is not provisioned for runtime '${runtimeId}'`);
            }
            await provisionPromise;
            await open();
            const inputOrdinal = ++turnOrdinal;
            const localId = meta?.localId ?? `${runId}-input-${inputOrdinal}`;
            const userMessageSeq = meta?.userMessageSeq !== undefined
                ? meta.userMessageSeq
                : params.options.scope === 'session_owned'
                    ? params.options.sessionInteractionHost?.session.getCommittedUserMessageSeq?.(localId) ?? null
                    : null;
            let resolvedInput: AgentSessionInput;
            try {
                resolvedInput = params.createSessionContext.resolveStructuredInputForDispatch
                    ? await params.createSessionContext.resolveStructuredInputForDispatch({ input, localId, signal })
                    : input;
            } catch (error) {
                return rejectStructuredInputBeforeProviderEffect(error);
            }
            pendingTurnInputId = localId;
            pendingTurnAdmissionFailure = null;
            operations!.beginTurnLifecycle();
            try {
                await operations!.sendTurnPrompt(withRunSkillIndex(resolvedInput, skillIndex).text, {
                    ...meta,
                    localId,
                    ...(resolvedInput.structuredInput === undefined ? {} : { structuredInput: resolvedInput.structuredInput }),
                    userMessageSeq,
                    ...(meta?.userMessageSeqs ? { userMessageSeqs: meta.userMessageSeqs } : {}),
                    ...(meta?.causalPermissionAuthority
                        ? { causalPermissionAuthority: meta.causalPermissionAuthority }
                        : {}),
                });
            } catch (error) {
                throw pendingTurnAdmissionFailure ?? error;
            }
            return { status: 'admitted' as const };
        },
        ...(params.sessionCapabilities.delivery.includes('steer') ? {
            async steerInput(runtimeId: string, input: AgentSessionInput, meta?: Parameters<ExecutionRunHostRuntime['deliverInput']>[2]) {
                assertUsable();
                if (!provisionPromise || runtimeId !== runId || !operations) {
                    throw new Error(`Native Agent Session interaction '${runId}' is not provisioned for runtime '${runtimeId}'`);
                }
                await provisionPromise;
                const inputOrdinal = ++turnOrdinal;
                const localId = meta?.localId ?? `${runId}-input-${inputOrdinal}`;
                let resolvedInput: AgentSessionInput;
                try {
                    resolvedInput = params.createSessionContext.resolveStructuredInputForDispatch
                        ? await params.createSessionContext.resolveStructuredInputForDispatch({ input, localId, signal })
                        : input;
                } catch (error) {
                    return rejectStructuredInputBeforeProviderEffect(error);
                }
                await operations.steerInFlightTurn(resolvedInput.text, {
                    ...meta,
                    localId,
                    ...(resolvedInput.structuredInput === undefined ? {} : { structuredInput: resolvedInput.structuredInput }),
                    ...(meta?.userMessageSeq !== undefined ? { userMessageSeq: meta.userMessageSeq } : {}),
                    ...(meta?.userMessageSeqs ? { userMessageSeqs: meta.userMessageSeqs } : {}),
                    ...(meta?.causalPermissionAuthority ? { causalPermissionAuthority: meta.causalPermissionAuthority } : {}),
                });
                return { status: 'admitted' as const };
            },
        } : {}),
        async cancel(runtimeId) {
            assertUsable();
            if (!provisionPromise || runtimeId !== runId || !operations) return;
            await operations.cancelTurn();
        },
        subscribeMessages(handler) {
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        waitForTurnCompletion,
        async dispose() {
            if (disposed) return;
            disposed = true;
            ownedAbortController.abort(new Error('Native Agent Session interaction disposed'));
            unsubscribeEvents?.();
            unsubscribeEvents = null;
            listeners.clear();
            inputOutcomeListeners.clear();
            runtimeEventListeners.clear();
            try {
                await operations?.resetOrDisposeRuntime('session_closed');
            } finally {
                await disposeSessionContext?.();
            }
        },
    });
}
