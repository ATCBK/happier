import { buildMachineAgentInventoryKey, type MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import type { MachineAgent, MachineAgentConnectedService, MachineAgentSignIn } from './machineAgentTypes';
import { resolveMachineAgentState } from './resolveMachineAgentState';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServicesAccountGroupOptionsByServiceId } from '@happier-dev/agents';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { areTeamResourceConnectedServiceSelectionsEqual } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';

const NATIVE_LOGIN = { login_terminal: 'terminal', status_only: 'statusOnly', manual_only: 'manual', unsupported: 'unsupported' } as const;

export function resolveMachineAgentSignIn(input: Readonly<{
    native: MachineAgentInventoryItem['signIn'];
    connectedServices: readonly MachineAgentConnectedService[];
    /** Omitted only for raw availability; inventory/Session readers pass their selection (null for native). */
    credentialBindings?: ConnectedServiceBindingsV2 | null;
    /** An unread Account default must not be represented as native or as any available account. */
    credentialBindingsReady?: boolean;
    groupOptionsByServiceId?: ConnectedServicesAccountGroupOptionsByServiceId;
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    /** Services replaced by the admitted selected Provider's Agent adapter. */
    suppressedServiceIds?: ReadonlySet<string>;
}>): MachineAgentSignIn {
    const services = input.connectedServices.filter(service => !input.suppressedServiceIds?.has(service.serviceId));
    const selected = input.credentialBindings === undefined ? services : services.map((service) => {
        const binding = input.credentialBindings?.bindingsByServiceId[service.serviceId];
        if (!binding || binding.source === 'native') return { ...service, connected: false, healthy: false };
        if (binding.source === 'team_resource') {
            const resource = input.teamCredentialResources?.find((resource) => resource.id === binding.resourceId
                && resource.readiness.kind === 'available'
                && resource.connectedServiceSelections.some((selection) => selection.resourceId === binding.resourceId
                    && areTeamResourceConnectedServiceSelectionsEqual(selection, binding)));
            return { ...service, connected: true, healthy: Boolean(resource) };
        }
        const profileId = binding.selection === 'profile' ? binding.profileId
            : input.groupOptionsByServiceId?.[service.serviceId]?.find((group) => group.groupId === binding.groupId)?.activeProfileId;
        const profile = service.profiles?.find((profile) => profile.profileId === profileId);
        return { ...service, connected: Boolean(profile), healthy: profile?.healthy === true, profileLabel: profile?.profileLabel ?? null };
    });
    const connected = selected.find((service) => service.connected && service.healthy);
    const selectedBindings = Object.entries(input.credentialBindings?.bindingsByServiceId ?? {})
        .filter(([serviceId, binding]) => binding.source !== 'native' && !input.suppressedServiceIds?.has(serviceId));
    const usesConnected = selectedBindings.length > 0;
    // Absent profile rows mean the projection could not evaluate authentication,
    // unlike an evaluated empty list or a known unhealthy selected profile.
    const unknown = selectedBindings.some(([serviceId, binding]) => {
        const service = input.connectedServices.find((service) => service.serviceId === serviceId);
        return !service || (binding.source === 'connected' && service.profiles === undefined);
    });
    const status = input.credentialBindingsReady === false ? 'unknown'
        : connected ? 'signedIn' : usesConnected ? unknown ? 'unknown' : 'signedOut' : input.native.status;
    const rejected = status === 'signedOut' ? selectedBindings.flatMap(([serviceId, binding]) => {
        if (binding.source !== 'connected') return [];
        const profileId = binding.selection === 'profile' ? binding.profileId
            : input.groupOptionsByServiceId?.[serviceId]?.find(group => group.groupId === binding.groupId)?.activeProfileId;
        const profile = input.connectedServices.find(service => service.serviceId === serviceId)?.profiles
            ?.find(profile => profile.profileId === profileId);
        return profile?.reconnectRequired ? [{ serviceId, profileId: profile.profileId }] : [];
    })[0] : undefined;
    return {
        ...(rejected ? { connectedAccountFailure: { code: 'connected_service_credential_reconnect_required' as const, ...rejected } } : {}),
        native: input.native,
        status,
        via: status === 'signedIn' && connected
            ? { kind: 'connected', serviceId: connected.serviceId, title: connected.title, profileLabel: connected.profileLabel }
            : status === 'signedIn' ? { kind: 'native', accountLabel: input.native.accountLabel ?? null } : null,
        nativeLogin: NATIVE_LOGIN[input.native.loginSupport],
        connectedServices: input.connectedServices,
    };
}

export type MachineAgentCredentialSelection = Readonly<{
    credentialBindings: ConnectedServiceBindingsV2 | null;
    providerRoute?: Readonly<{ ready: boolean; suppressedConnectedServiceIds: readonly string[] }> | null;
}> & Pick<Parameters<typeof resolveMachineAgentSignIn>[0], 'credentialBindingsReady' | 'groupOptionsByServiceId' | 'teamCredentialResources'>;

/** Account-default inventory and explicit Session selection share the same credential decision. */
export function projectMachineAgentForCredential(agent: MachineAgent | null | undefined, selection: MachineAgentCredentialSelection): MachineAgent | null {
    if (!agent) return null;
    const suppressedServiceIds = new Set((selection.providerRoute?.ready ? selection.providerRoute.suppressedConnectedServiceIds : [])
        .map(resolveQualifiedConnectedAccountServiceKey).filter((key): key is string => key !== null));
    // Suppression must cover the Agent's actual accepted authentication services,
    // not merely a same-named service belonging to another plugin.
    const authenticationRequired = (agent.signIn.native?.required !== false && agent.signIn.connectedServices.length === 0)
        || agent.signIn.connectedServices.some(service => !suppressedServiceIds.has(service.serviceId))
        || Object.keys(selection.credentialBindings?.bindingsByServiceId ?? {}).some(serviceId => !suppressedServiceIds.has(serviceId));
    const signIn = resolveMachineAgentSignIn({
        native: agent.signIn.native ?? { status: agent.signIn.via?.kind === 'connected' ? 'unknown' : agent.signIn.status, loginSupport: 'unsupported' },
        connectedServices: agent.signIn.connectedServices,
        ...selection,
        suppressedServiceIds,
    });
    return { ...agent, signIn, state: resolveMachineAgentState({ ...agent, signIn,
        // An unread default can make authentication unknown without withdrawing known installation facts.
        known: !agent.unavailableReason && (agent.installed || (agent.state !== 'unknown' && agent.state !== 'checking')),
        checking: agent.state === 'checking',
        credentialRouteReady: selection.providerRoute?.ready, authenticationRequired }) };
}

export function projectMachineAgent(input: Readonly<{
    agentId: string;
    definitionId?: string;
    title: string;
    facts: MachineAgentInventoryItem | null;
    checking: boolean;
    stale: boolean;
    staleReason?: MachineAgent['staleReason'];
    unavailableReason?: MachineAgent['unavailableReason'];
    connectedServices: readonly MachineAgentConnectedService[];
    credentialSelection?: MachineAgentCredentialSelection;
    job: MachineAgent['job'];
    dependencyTitlesByKey?: Readonly<Record<string, string>>;
}>): MachineAgent {
    const facts = input.facts;
    const agent = {
        agentId: input.agentId, title: input.title,
        ...(input.definitionId ? { definitionId: input.definitionId } : {}),
        ...(facts?.managed !== undefined ? { managed: facts.managed } : {}),
        ...(facts?.fit ? { fit: facts.fit } : {}),
        installed: facts?.installed ?? false,
        version: facts?.version ?? null, latestVersion: facts?.latestVersion ?? null,
        update: facts?.update ?? null,
        signIn: resolveMachineAgentSignIn({ native: facts?.signIn ?? { status: 'unknown', loginSupport: 'unsupported' }, connectedServices: input.connectedServices }),
        platform: facts?.platform ?? { supported: true as const },
        install: { ...(facts?.install ?? { available: false, mode: 'none' as const, sizeBytes: null, guideUrl: null }), requiresVendorConsent: facts?.install.mode === 'vendor_recipe' },
        dependencies: (facts?.dependencies ?? []).map((dependency) => ({ ...dependency, title: input.dependencyTitlesByKey?.[dependency.key] ?? dependency.key })),
        job: input.job, stale: input.stale || Boolean(input.unavailableReason),
        ...(input.stale || input.unavailableReason
            ? { staleReason: input.staleReason ?? (input.unavailableReason ? 'error' as const : 'offline' as const) }
            : {}),
        ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
    };
    const projected = { ...agent, state: resolveMachineAgentState({ ...agent, known: facts !== null && !input.unavailableReason, checking: input.checking }) };
    // The credential projection receives a concrete Agent, so its null-input branch is unreachable.
    return input.credentialSelection ? projectMachineAgentForCredential(projected, input.credentialSelection)! : projected;
}

/** Keep unchanged agent rows and nested facts stable across refresh and unrelated agent updates. */
export function reconcileMachineAgents(previous: readonly MachineAgent[], incoming: readonly MachineAgent[]): readonly MachineAgent[] {
    const previousById = new Map(previous.map((agent) => [buildMachineAgentInventoryKey(agent), agent]));
    const reconciled = incoming.map((agent) => {
        const prior = previousById.get(buildMachineAgentInventoryKey(agent));
        return prior && JSON.stringify(prior) === JSON.stringify(agent) ? prior : Object.freeze(agent);
    });
    return previous.length === reconciled.length && reconciled.every((agent, index) => agent === previous[index]) ? previous : Object.freeze(reconciled);
}
