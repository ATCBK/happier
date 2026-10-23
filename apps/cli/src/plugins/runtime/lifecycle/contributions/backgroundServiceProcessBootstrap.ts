import type { BackgroundServiceContext, BackgroundServiceRunner } from '@happier-dev/plugin-sdk/background-services';
import type { JsonValue } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import { resolvePluginAuthorStagingModule } from '@/plugins/authoring/sourceModule';
import type { PluginActivationSource } from '../../activationSources';
import { createPluginTypeScriptGenerationScope, loadVerifiedPluginModule } from '../../loadPluginModule';
import type { PluginDaemonModuleNamespace } from '../../types';
import type { AdmittedBackgroundServicePlugin } from './backgroundServiceProcessSource';
import { activatePluginRuntimeRegistry } from '../manager';
import { createBackgroundServiceProcessServices, type PreparedBackgroundServiceProcessLocalServices } from './backgroundServiceProcessServices';
import type { CreateAgentInvocationServices } from '../../invocation/services/types';


export type BackgroundServiceProcessBootstrap = Readonly<{
    entry: 'plugin';
    payload: Readonly<{
        pluginId: string;
        localId: string;
        generation: number;
        plugins: readonly AdmittedBackgroundServicePlugin[];
    }>;
}> | Readonly<{
    entry: 'host';
    entryId: 'memory-indexer';
    payload: JsonValue;
    plugins?: readonly AdmittedBackgroundServicePlugin[];
}>;

export type HostBackgroundServiceProcessContext = Readonly<{
    signal: AbortSignal;
    services: Readonly<Record<string, unknown>>;
    agentRuntimesByAgentId?: ReadonlyMap<string, Pick<
        import('./targetAgents').AgentRuntimeRegistrationLease,
        'pluginId' | 'pluginVersion' | 'agentId' | 'localAgentId' | 'occurrenceId' | 'sourceCustody' | 'externalSessions' | 'isCurrent' | 'retirementSignal'
    >>;
}>;

export type BackgroundServiceProcessHostEntryLoader = (
    entryId: 'memory-indexer',
) => Promise<Readonly<{
    run(context: HostBackgroundServiceProcessContext, payload: JsonValue): Promise<void>;
}>>;

export type BackgroundServiceProcessPluginHost = Readonly<{
    prepareAgentInvocationServices(
        input: BackgroundServiceProcessAgentInvocationRequest,
    ): Promise<PreparedBackgroundServiceProcessLocalServices>;
}>;

export type BackgroundServiceProcessAgentInvocationRequest = Pick<
    Parameters<CreateAgentInvocationServices>[0],
    'pluginId' | 'pluginVersion' | 'agentId' | 'occurrenceId' | 'correlationId' | 'cwd' | 'providerBindingActive' | 'signal'
>;


async function loadAdmittedPlugins(
    plugins: readonly AdmittedBackgroundServicePlugin[],
    generation: number,
    createAgentInvocationServices: CreateAgentInvocationServices,
) {
    const sources = new Map(plugins.map((plugin) => {
        const generationScope = createPluginTypeScriptGenerationScope();
        const loadModule = (entryPath: string) => loadVerifiedPluginModule({
            entryPath, loadMode: plugin.processEntry.loadMode, generationScope,
            cacheKey: plugin.committedAuthorization?.immutableGenerationId ?? plugin.occurrenceId,
            nativeFileUrlMode: 'canonical',
        });
        const source: PluginActivationSource<PluginDaemonModuleNamespace> = {
            kind: 'bundled',
            moduleId: plugin.moduleId ?? plugin.processEntry.entryPath,
            sourceAuthority: plugin.sourceAuthority,
            load: () => loadModule(plugin.processEntry.entryPath),
            resolveRelativeModule: (module) => resolvePluginAuthorStagingModule({
                graph: { ...plugin.processEntry, loadModule }, module,
            }),
        };
        return [plugin.target.pluginId, source] as const;
    }));
    const contributes = createResolvedContributionRegistry({
        activationTargets: plugins.map(({ target }) => target),
        agents: plugins.flatMap(({ target }) => target.manifest.contributes.agents.map((definition) => (
            projectManifestAgentContribution({
                definition, pluginId: target.pluginId, provenance: target.provenance,
                source: target.source, sourceSpec: target.sourceSpec,
                hostAccess: target.manifest.hostAccess,
                systemTools: target.manifest.contributes.systemTools,
                manifestPath: target.manifestPath, daemonEntryPath: target.daemonEntryPath,
                devDaemonEntryPath: target.devDaemonEntryPath,
            })
        ))),
    });
    const registry = await activatePluginRuntimeRegistry({
        contributes, generation, serviceHost: true,
        serviceHostCreateAgentInvocationServices: createAgentInvocationServices,
        pluginIds: plugins.map(({ target }) => target.pluginId),
        occurrenceIdsByPluginId: new Map(plugins.map(({ target, occurrenceId }) => [target.pluginId, occurrenceId])),
        admittedPluginSourceCustodiesByPluginId: new Map(plugins.map(({ target, sourceCustody }) => [target.pluginId, sourceCustody])),
        resolveActivationSource: (target) => sources.get(target.pluginId) ?? null,
    });
    const failed = [...registry.failedActivationPluginIds].flatMap((pluginId) => registry.pluginDiagnosticsByPluginId[pluginId] ?? []);
    if (failed.length > 0) {
        await registry.dispose();
        throw new Error(`background_service_process_activation_failed: ${failed.map(({ code, message }) => `${code}: ${message}`).join('; ')}`);
    }
    return registry;
}

/** Child-side execution consumes inherited admission and performs no store/publication lifecycle. */
export async function resolveBackgroundServiceProcessBootstrap(
    bootstrap: BackgroundServiceProcessBootstrap,
    options: Readonly<{ loadHostEntry?: BackgroundServiceProcessHostEntryLoader }> = {},
): Promise<Readonly<{
    run(context: BackgroundServiceContext | HostBackgroundServiceProcessContext): Promise<void>;
    dispose(): Promise<void>;
}>> {
    const plugins = bootstrap.entry === 'plugin' ? bootstrap.payload.plugins : bootstrap.plugins ?? [];
    let currentContext: BackgroundServiceContext | HostBackgroundServiceProcessContext | undefined;
    const localAgentServices = new Set<ReturnType<typeof createBackgroundServiceProcessServices>>();
    const createAgentInvocationServices: CreateAgentInvocationServices = async (input) => {
        const context = currentContext;
        if (!context || context.signal.aborted
            || !plugins.some(({ target, occurrenceId }) => target.pluginId === input.pluginId && occurrenceId === input.occurrenceId)) {
            throw new Error('background_service_process_agent_context_unavailable');
        }
        const host = Reflect.get(context.services, '__backgroundServiceProcessPlugins') as BackgroundServiceProcessPluginHost | undefined;
        if (!host) throw new Error('background_service_process_agent_services_unavailable');
        const signal = AbortSignal.any([context.signal, input.signal]);
        const prepared = await host.prepareAgentInvocationServices({
            pluginId: input.pluginId, pluginVersion: input.pluginVersion,
            agentId: input.agentId, occurrenceId: input.occurrenceId,
            correlationId: input.correlationId, cwd: input.cwd,
            providerBindingActive: input.providerBindingActive,
            signal,
        });
        signal.throwIfAborted();
        const admittedAgent = registry?.agentRuntimesByAgentId.get(input.agentId);
        if (!admittedAgent || admittedAgent.pluginId !== input.pluginId || admittedAgent.occurrenceId !== input.occurrenceId) {
            throw new Error('background_service_process_agent_context_unavailable');
        }
        const local = createBackgroundServiceProcessServices({
            metadata: {
                plugin: { id: input.pluginId, version: input.pluginVersion },
                contribution: {
                    id: admittedAgent.localAgentId,
                    qualifiedId: resolveAgentContributionQualifiedId({ pluginId: input.pluginId, localId: admittedAgent.localAgentId }),
                },
            },
            signal,
            localPolicy: prepared.localPolicy,
            clientServices: prepared.services,
        });
        localAgentServices.add(local);
        return local.services;
    };
    const run = async (
        context: BackgroundServiceContext | HostBackgroundServiceProcessContext,
        operation: () => Promise<void>,
    ) => {
        currentContext = context;
        try { await operation(); }
        finally {
            currentContext = undefined;
            await Promise.all([...localAgentServices].map((services) => services.dispose()));
            localAgentServices.clear();
        }
    };
    const registry = plugins.length > 0
        ? await loadAdmittedPlugins(plugins, bootstrap.entry === 'plugin' ? bootstrap.payload.generation : 0, createAgentInvocationServices)
        : null;
    const readers: HostBackgroundServiceProcessContext['agentRuntimesByAgentId'] = registry
        ? new Map([...registry.agentRuntimesByAgentId].map(([id, lease]) => [id, Object.freeze({
            pluginId: lease.pluginId, pluginVersion: lease.pluginVersion,
            agentId: lease.agentId, localAgentId: lease.localAgentId,
            occurrenceId: lease.occurrenceId, sourceCustody: lease.sourceCustody,
            externalSessions: lease.externalSessions, isCurrent: lease.isCurrent,
            retirementSignal: lease.retirementSignal,
        })]))
        : undefined;
    if (bootstrap.entry === 'plugin') {
        const selected = registry?.targetRegistrations.find(({ pluginId, registration }) => (
            pluginId === bootstrap.payload.pluginId
            && registration.family === 'backgroundServices'
            && registration.localId === bootstrap.payload.localId
        ));
        if (!selected || selected.registration.family !== 'backgroundServices') {
            await registry?.dispose();
            throw new Error('background_service_process_runner_unavailable');
        }
        const runner: BackgroundServiceRunner = selected.registration.value;
        return {
            run: async (context) => {
                if (!('plugin' in context)) throw new Error('background_service_process_plugin_context_unavailable');
                await run(context, () => runner(context));
            },
            dispose: async () => { await registry?.dispose(); },
        };
    }
    try {
        if (!options.loadHostEntry) throw new Error('background_service_process_host_entry_unavailable');
        const entry = await options.loadHostEntry(bootstrap.entryId);
        return {
            run: async (context) => await run(context, () => entry.run({
                signal: context.signal,
                services: Object.fromEntries(Object.entries(context.services)),
                ...(readers ? { agentRuntimesByAgentId: readers } : {}),
            }, bootstrap.payload)),
            dispose: async () => { await registry?.dispose(); },
        };
    } catch (error) {
        await registry?.dispose();
        throw error;
    }
}
