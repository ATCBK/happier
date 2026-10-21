import { BackendTargetKeyV2InputSchema, buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveActionBackendTargetSelection } from '@happier-dev/protocol/actions/resolveActionBackendTargetSelection';
import type { BackendTargetRefV1 } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import type { AgentExecutionTargetV1, BackendTargetRefV2, PluginProjectionV2 } from '@happier-dev/protocol';
import type { AgentInventoryProbeInput } from '@happier-dev/protocol/actions/actionSpecs';
import { AgentModelsProbeObservationSchema, AgentSessionModesProbeObservationSchema, AgentConfigOptionsProbeObservationSchema, projectProbedConfigOptionDefinitions, type AgentModelsProbeObservation } from '@happier-dev/protocol/capabilities';
import type { ConnectedServicesProfileOption } from '@happier-dev/agents';
import { projectUnexpectedActionFailureV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';
import { machineCapabilitiesInvoke, type MachineCapabilitiesInvokeResult } from '@/sync/ops/capabilities';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { projectConnectedPresentationLabelsV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import {
    applyProjectedCredentialKindRestrictions,
    buildQualifiedConnectedAccountGroupOptionsByServiceId,
    buildQualifiedConnectedAccountProfileOptionsByServiceId,
    resolveProjectedConnectedAccountServiceKeys,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';

/**
 * The app client's `sessions.spawn.*` / `agents.*` inventory Action
 * dependencies.
 *
 * Every function here is a projection over incumbent owners — the machine
 * capability probe transport, the Account's Connected Account profile, and the
 * shared V4 → session-options qualifier — so an external qualified Agent is
 * answered by the same facts the New Session screen reads, never by a second
 * inventory or a bundled-catalog fallback.
 *
 * Failure rules: an unknown Agent id or an unprobeable machine produces a typed
 * empty/unavailable answer, never bundled Codex/Claude substitutes.
 */

export type AgentInventoryProbeTarget = Readonly<{
    /** The runtime Agent id that names the machine capability (`cli.<id>`). */
    agentId: string;
    /**
     * The V1 backend target carried to the probe, when the target can be
     * expressed in that vocabulary at all. An external qualified Agent target
     * (`agent:<pluginId>/<localId>`) has no V1 carrier form — the daemon
     * resolves it from the capability id — so omitting the param is the
     * contract, not a lost fact.
     */
    backendTargetParam: BackendTargetRefV1 | BackendTargetRefV2 | null;
}>;

function findProjectedAgentByIdentity(projection: PluginProjectionV2, identity: AgentExecutionTargetV1['identity']) {
    return Object.values(projection.agentsById).find((candidate) => (
        candidate.identity?.pluginId === identity.pluginId
        && candidate.identity.localId === identity.localId
    ));
}

export async function resolveSessionSpawnAgentInventorySelectionForActions(args: Readonly<{
    agentTarget: AgentExecutionTargetV1;
    machineId?: string;
    serverId?: string;
    signal?: AbortSignal;
    accountLifetime?: import('@/sync/domains/scope/serverAccountScope').ServerAccountScopeLifetime;
}>): Promise<Readonly<{ agentId: string; backendTargetKey: string }> | null> {
    const machineId = normalizeId(args.machineId);
    if (!machineId) return null;
    const serverId = normalizeId(args.serverId) || normalizeId(getActiveServerSnapshot()?.serverId);
    const projection = (await loadDaemonMergedProjectionInputs({
        machineId,
        ...(serverId ? { serverId } : {}),
        signal: args.signal,
        accountLifetime: args.accountLifetime,
    }))?.pluginProjectionV2;
    if (!projection) return null;
    const entry = findProjectedAgentByIdentity(projection, args.agentTarget.identity);
    if (!entry) return null;
    return {
        agentId: entry.id,
        backendTargetKey: buildBackendTargetKeyV2(args.agentTarget),
    };
}

type AgentInventoryTargetResolution =
    | Readonly<{ ok: true; target: AgentInventoryProbeTarget }>
    | Readonly<{ ok: false; errorCode: 'invalid_parameters' | 'unknown_agent' }>;

function normalizeId(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Parses one canonical Agent selection into the machine-probe target.
 *
 * `backend:`-form keys (and identity keys of bundled Agents, which canonicalize
 * to `agent:`) convert through the Protocol owner into a V1 probe target.
 * A novel external identity key has no V1 carrier — it fails closed unless the
 * caller names the runtime Agent id that the machine capability probe needs.
 */
export function resolveAgentInventoryProbeTarget(args: Readonly<{
    agentId?: string | null;
    backendTargetKey?: string | null;
}>): AgentInventoryTargetResolution {
    const providedAgentId = normalizeId(args.agentId);
    const backendTargetKey = normalizeId(args.backendTargetKey);
    const resolved = resolveActionBackendTargetSelection({
        ...(providedAgentId ? { agentId: providedAgentId } : {}),
        ...(backendTargetKey ? { backendTargetKey } : {}),
    });
    if (!resolved.ok) {
        return {
            ok: false,
            errorCode: resolved.path === 'agentId' ? 'unknown_agent' : 'invalid_parameters',
        };
    }
    if (!resolved.selection.agentId) {
        return { ok: false, errorCode: 'unknown_agent' };
    }
    return {
        ok: true,
        target: {
            agentId: resolved.selection.agentId,
            backendTargetParam: resolved.selection.backendTarget,
        },
    };
}

async function probeAgentInventory(
    machineId: string,
    target: AgentInventoryProbeTarget,
    method: 'probeModels' | 'probeModes' | 'probeConfigOptions',
    requestedServerId?: string,
    probe?: AgentInventoryProbeInput,
    signal?: AbortSignal,
): Promise<Readonly<{ ok: true; result: Record<string, unknown> }> | Readonly<{ ok: false; failure: ActionExecuteFailure }>> {
    const serverId = normalizeId(requestedServerId) || normalizeId(getActiveServerSnapshot()?.serverId);
    const { transportTimeoutMs, ...capabilityParams } = probe ?? {};
    const res = await machineCapabilitiesInvoke(
        machineId,
        {
            id: buildProviderCliCapabilityId(target.agentId),
            method,
            params: {
                timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
                ...capabilityParams,
                ...(target.backendTargetParam ? { backendTarget: target.backendTargetParam } : {}),
            },
        },
        { ...(serverId ? { serverId } : {}), ...(transportTimeoutMs ? { timeoutMs: transportTimeoutMs } : {}), signal },
    );
    if (!res.supported) return { ok: false, failure: {
        ...(res.reason === 'outcomeUnknown' ? projectUnexpectedActionFailureV1(true) : {
            ok: false as const,
            errorCode: res.reason === 'not-supported' ? 'unsupported_method' : 'agent_inventory_probe_failed',
            error: res.reason === 'not-supported' ? 'unsupported_method' : 'agent_inventory_probe_failed',
        }),
        details: { reason: res.reason, ...(res.requestDisposition ? { requestDisposition: res.requestDisposition } : {}) },
    } };
    const failed = (errorCode = 'agent_inventory_probe_failed'): Readonly<{ ok: false; failure: ActionExecuteFailure }> => ({ ok: false,
        failure: { ok: false, errorCode, error: errorCode } });
    if (!res.response.ok) return failed(res.response.error.code?.trim() || undefined);
    const result = res.response.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return failed();
    if (probe) {
        const parsed = (method === 'probeModels' ? AgentModelsProbeObservationSchema
            : method === 'probeModes' ? AgentSessionModesProbeObservationSchema : AgentConfigOptionsProbeObservationSchema).safeParse(result);
        return parsed.success ? { ok: true, result: parsed.data } : failed();
    }
    return { ok: true, result: result as Record<string, unknown> };
}

/** Existing inventory Actions are the only public preflight transport front door. */
export async function invokeAgentInventoryProbeAction(params: Readonly<{
    agentId: string;
    machineId: string;
    serverId?: string | null;
    backendTarget?: BackendTargetRefV1 | BackendTargetRefV2 | null;
    capabilityParams: Readonly<Record<string, unknown>>;
    bypassCache?: boolean;
    transportTimeoutMs?: number;
    signal?: AbortSignal;
}>, method: 'probeModels' | 'probeModes' | 'probeConfigOptions'): Promise<MachineCapabilitiesInvokeResult> {
    try {
        const target = params.backendTarget ? readBackendTargetRefV2(params.backendTarget) : null;
        const configured = target?.configuredBackendId || target?.sourceKind === 'configured';
        const result = await createFrontDoorActionExecute()(method === 'probeModels' ? 'agents.models.list'
            : method === 'probeModes' ? 'agents.session_modes.list' : 'agents.config_options.list', {
            ...(!configured ? { agentId: params.agentId } : {}),
            ...(target ? { backendTargetKey: resolveBackendTargetKeyV2(target) } : {}),
            machineId: params.machineId,
            probe: { ...params.capabilityParams, ...(params.bypassCache ? { bypassCache: true } : {}),
                ...(params.transportTimeoutMs ? { transportTimeoutMs: params.transportTimeoutMs } : {}) },
        }, { surface: 'ui', ...(params.serverId ? { serverId: params.serverId } : {}), signal: params.signal });
        params.signal?.throwIfAborted();
        if (!result.ok) {
            const details = result.details && typeof result.details === 'object' && !Array.isArray(result.details)
                ? result.details as Record<string, unknown> : null;
            return { supported: false,
                errorCode: result.errorCode,
                reason: result.errorCode === 'action_outcome_unknown' ? 'outcomeUnknown'
                    : details?.reason === 'not-supported' ? 'not-supported' : 'error',
                ...(details?.requestDisposition === 'outcomeUnknown' || details?.requestDisposition === 'notSent'
                    ? { requestDisposition: details.requestDisposition } : {}) };
        }
        if (!result.result || typeof result.result !== 'object' || Array.isArray(result.result)) return { supported: false, reason: 'error' };
        const observation = (method === 'probeModels' ? AgentModelsProbeObservationSchema
            : method === 'probeModes' ? AgentSessionModesProbeObservationSchema : AgentConfigOptionsProbeObservationSchema)
            .safeParse((result.result as Record<string, unknown>).probeObservation);
        return observation.success ? { supported: true, response: { ok: true, result: observation.data } } : { supported: false, reason: 'error' };
    } catch (error) {
        if (params.signal?.aborted) throw error;
        return { supported: false, reason: 'error' };
    }
}

/** Admitted native model transport, below the Action executor and shared cache. */
export async function probeAgentModelsForActions(args: Readonly<{ machineId: string; serverId?: string; signal?: AbortSignal; probe: AgentInventoryProbeInput }>, target: AgentInventoryProbeTarget): Promise<Readonly<{
    agentId: string;
    items: readonly Readonly<{ modelId: string; label: string; description?: string }>[];
    supportsFreeform?: boolean;
    source: 'dynamic' | 'static' | 'unavailable' | 'preflight';
    probeObservation?: AgentModelsProbeObservation;
}> | ActionExecuteFailure> {
    const probe = await probeAgentInventory(args.machineId, target, 'probeModels', args.serverId, args.probe, args.signal);
    if (!probe.ok) return probe.failure;
    const parsed = AgentModelsProbeObservationSchema.parse(probe.result);
    return {
        agentId: target.agentId,
        items: parsed.availableModels.map(model => ({ modelId: model.id, label: model.name, ...(model.description ? { description: model.description } : {}) })),
        supportsFreeform: parsed.supportsFreeform,
        source: parsed.source ?? 'preflight',
        probeObservation: parsed,
    };
}

function readProbeSource(result: Record<string, unknown>): 'static' | 'dynamic' | 'unavailable' | null {
    const source = result.source;
    return source === 'static' || source === 'dynamic' || source === 'unavailable'
        ? source
        : null;
}

function inventoryListResult(params: Readonly<{
    agentId: string;
    items: readonly unknown[];
    source: 'static' | 'dynamic' | 'unavailable';
    limit: number | null;
    probeObservation?: Readonly<Record<string, unknown>>;
}>): unknown {
    const bounded = params.limit ? params.items.slice(0, params.limit) : params.items;
    return {
        agentId: params.agentId,
        items: bounded,
        source: params.source,
        ...(params.probeObservation ? { probeObservation: params.probeObservation } : {}),
    };
}

function readInventoryLimit(raw: unknown): number | null {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    return Math.max(1, Math.min(200, Math.floor(raw)));
}

function dedupeById(items: readonly Readonly<{ id: string }>[]): readonly Readonly<{ id: string }>[] {
    return items.filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
}

export type AgentSessionModesListArgs = Readonly<{
    agentId?: string;
    machineId?: string;
    serverId?: string;
    limit?: number;
    backendTargetKey?: string;
    probe?: AgentInventoryProbeInput;
    signal?: AbortSignal;
}>;

/**
 * `agents.session_modes.list`: the selected machine's mode probe, projected
 * into the shared inventory row shape the CLI host answers with.
 */
export async function listAgentSessionModesForActions(args: AgentSessionModesListArgs, admittedTarget?: AgentInventoryProbeTarget): Promise<unknown> {
    const target = admittedTarget ? { ok: true as const, target: admittedTarget } : resolveAgentInventoryProbeTarget(args);
    if (!target.ok) {
        return { ok: false, errorCode: target.errorCode, errorMessage: target.errorCode };
    }
    const machineId = normalizeId(args.machineId);
    if (!machineId) {
        // Session modes are a machine fact; without a machine there is no
        // honest answer and no bundled stand-in.
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
    }
    const probe = await probeAgentInventory(machineId, target.target, 'probeModes', args.serverId, args.probe, args.signal);
    if (!probe.ok) {
        return probe.failure;
    }
    const source = readProbeSource(probe.result);
    const modesRaw = probe.result.availableModes;
    if (!source || !Array.isArray(modesRaw)) {
        return inventoryListResult({
            agentId: target.target.agentId,
            items: [],
            source: 'unavailable',
            limit: readInventoryLimit(args.limit),
            ...(args.probe ? { probeObservation: probe.result } : {}),
        });
    }
    const items = dedupeById(modesRaw
        .map((entry: unknown): Readonly<{ id: string; label: string; description?: string }> | null => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
            const record = entry as Record<string, unknown>;
            const id = normalizeId(record.id);
            if (!id) return null;
            const name = normalizeId(record.name);
            const description = normalizeId(record.description);
            return {
                id,
                label: name || id,
                ...(description ? { description } : {}),
            };
        })
        .filter((entry): entry is Readonly<{ id: string; label: string; description?: string }> => entry !== null));
    return inventoryListResult({
        agentId: target.target.agentId,
        items,
        source,
        limit: readInventoryLimit(args.limit),
        ...(args.probe ? { probeObservation: probe.result } : {}),
    });
}

export type AgentConfigOptionsListArgs = Readonly<{
    agentId?: string;
    machineId?: string;
    serverId?: string;
    limit?: number;
    backendTargetKey?: string;
    modelId?: string;
    probe?: AgentInventoryProbeInput;
    signal?: AbortSignal;
}>;

/**
 * `agents.config_options.list`: the selected machine's config-option probe,
 * projected into the shared inventory row shape the CLI host answers with.
 */
export async function listAgentConfigOptionsForActions(args: AgentConfigOptionsListArgs, admittedTarget?: AgentInventoryProbeTarget): Promise<unknown> {
    const target = admittedTarget ? { ok: true as const, target: admittedTarget } : resolveAgentInventoryProbeTarget(args);
    if (!target.ok) {
        return { ok: false, errorCode: target.errorCode, errorMessage: target.errorCode };
    }
    const machineId = normalizeId(args.machineId);
    if (!machineId) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
    }
    const probe = await probeAgentInventory(machineId, target.target, 'probeConfigOptions', args.serverId, args.probe, args.signal);
    if (!probe.ok) {
        return probe.failure;
    }
    const source = readProbeSource(probe.result);
    const optionsRaw = probe.result.configOptions;
    if (!source || !Array.isArray(optionsRaw)) {
        return inventoryListResult({
            agentId: target.target.agentId,
            items: [],
            source: 'unavailable',
            limit: readInventoryLimit(args.limit),
            ...(args.probe ? { probeObservation: probe.result } : {}),
        });
    }
    const modelProbe = args.modelId
        ? await probeAgentInventory(machineId, target.target, 'probeModels', args.serverId, args.probe, args.signal)
        : null;
    if (modelProbe && !modelProbe.ok) return modelProbe.failure;
    const models = AgentModelsProbeObservationSchema.safeParse(modelProbe?.result);
    const definitions = projectProbedConfigOptionDefinitions({
        configOptions: optionsRaw,
        source,
        modelId: args.modelId,
        models: models.success ? models.data : null,
    });
    return inventoryListResult({
        agentId: target.target.agentId,
        items: definitions.items,
        source: definitions.source,
        limit: readInventoryLimit(args.limit),
        ...(args.probe ? { probeObservation: probe.result } : {}),
    });
}

export type SpawnConnectedServicesListArgs = Readonly<{
    agentId?: string;
    backendTargetKey?: string;
    machineId?: string;
    serverId?: string;
    includeUnavailable?: boolean;
    signal?: AbortSignal;
}>;

/**
 * `sessions.spawn.connected_services.list`: the Account's Connected Accounts,
 * qualified through the one V4 → session-options projection every Session
 * connected-account surface shares.
 *
 * Machine declarations supply the supported-service set. A qualified target
 * resolves its contribution through that same projection, including configured
 * definitions; the definition's command does not grant another Agent's purposes.
 * Bundled declarations remain the fallback when machine facts are unavailable.
 */
export async function listSpawnConnectedServicesForActions(args: SpawnConnectedServicesListArgs): Promise<unknown> {
    let agentId = normalizeId(args.agentId);
    const parsedKey = BackendTargetKeyV2InputSchema.safeParse(args.backendTargetKey);
    const target = parsedKey.success ? parseBackendTargetKeyV2(parsedKey.data) : null;
    if (!agentId && target?.kind !== 'agent') {
        return { ok: false, errorCode: 'unknown_agent', errorMessage: 'unknown_agent' };
    }
    const serverId = normalizeId(args.serverId) || normalizeId(getActiveServerSnapshot()?.serverId);
    if (!serverId) return { ok: false, errorCode: 'action_home_not_found', errorMessage: 'action_home_not_found' };
    const { captureLazyActionAccountContext } = await import('./actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId, args.signal);
    try {
        let projectedAgent: PluginProjectionV2['agentsById'][string] | undefined;
        const machineId = normalizeId(args.machineId);
        if (machineId) {
            const projection = (await loadDaemonMergedProjectionInputs({
                machineId,
                serverId: account.serverId,
                accountLifetime: account.accountLifetime,
                signal: args.signal,
            }))?.pluginProjectionV2;
            if (projection) {
                projectedAgent = agentId ? projection.agentsById[agentId]
                    : target?.kind === 'agent' ? findProjectedAgentByIdentity(projection, target.identity) : undefined;
                agentId = projectedAgent?.id ?? agentId;
            }
        }
        if (!agentId) return { ok: false, errorCode: 'unknown_agent', errorMessage: 'unknown_agent' };
        const agentCore = isBundledAgentId(agentId) ? getAgentCore(agentId) : null;
        const projectedConnectedAccounts = projectedAgent?.connectedAccounts ?? [];
        const supportedServiceIds = projectedAgent
            ? resolveProjectedConnectedAccountServiceKeys(projectedConnectedAccounts)
            : agentCore
            ? (agentCore.connectedServices?.supportedServiceIds ?? [])
                .map((serviceId) => resolveQualifiedConnectedAccountServiceKey(serviceId))
                .filter((serviceKey): serviceKey is string => Boolean(serviceKey))
                .filter((serviceKey, index, all) => all.indexOf(serviceKey) === index)
            : [];

        if (supportedServiceIds.length === 0) {
            return { agentId, supportedServiceIds: [], items: [] };
        }

        const { readConnectedMetadataCatalogInContext, readConnectedMetadataProfileInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
        const profile = await readConnectedMetadataProfileInContext(account);
        let catalog = await readConnectedMetadataCatalogInContext(account, undefined, undefined, false);
        if ((catalog.presentation.status === 'unavailable' && catalog.presentation.reason === 'authority-not-confirmed')
            || (catalog.acknowledgements.status === 'unavailable' && catalog.acknowledgements.reason === 'authority-not-confirmed')) {
            catalog = await readConnectedMetadataCatalogInContext(account);
        }
        account.assertCurrent();
        const connectedAccounts = profile.connectedAccountsV4;
        const connectedGroups = profile.connectedAccountGroupsV4;
        const labelsByKey = catalog.presentation.status === 'ready' || catalog.presentation.status === 'partial'
            ? projectConnectedPresentationLabelsV1(catalog.presentation) : {};
        const profileOptionsByServiceId = applyProjectedCredentialKindRestrictions({
            optionsByServiceId: buildQualifiedConnectedAccountProfileOptionsByServiceId({
                accounts: connectedAccounts,
                supportedServiceIds,
                labelsByKey,
            }),
            connectedAccounts: projectedConnectedAccounts,
        });
        const groupOptionsByServiceId = buildQualifiedConnectedAccountGroupOptionsByServiceId({
            groups: connectedGroups,
            supportedServiceIds,
            labelsByKey,
        });

        const includeUnavailable = args.includeUnavailable === true;
        const items = Object.entries(profileOptionsByServiceId).flatMap(([serviceId, options]) => (
            options
                .filter((option) => includeUnavailable || option.status === 'connected')
                .map((option) => ({
                    value: `${serviceId}:profile:${option.profileId}`,
                    label: option.label ?? option.providerEmail ?? `${serviceId}:${option.profileId}`,
                }))
        ));

        return {
            agentId,
            supportedServiceIds,
            profileOptionsByServiceId,
            groupOptionsByServiceId,
            items,
        };
    } finally {
        account.dispose();
    }
}
