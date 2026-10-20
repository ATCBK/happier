import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import type { ConnectedAccountPurposeDefaultsIntent } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';

/** Adapt the setup form's displayed choice to the existing Account purpose-default Action. */
export function buildAgentSetupCredentialIntents(input: Readonly<{
    agent: Pick<MachineAgent, 'agentId' | 'signIn'>;
    machineId: string;
    /** Null selects the Agent's own login for every service it accepts. */
    serviceId: string | null;
}>): readonly ConnectedAccountPurposeDefaultsIntent[] {
    const services = input.serviceId === null
        ? input.agent.signIn.connectedServices
        : input.agent.signIn.connectedServices.filter(service => service.serviceId === input.serviceId);
    if (input.serviceId !== null && services.length === 0) throw new Error('agent_connected_service_unavailable');
    return services.map(service => {
        const identity = parseQualifiedPluginContributionKey(service.serviceId);
        if (!identity) throw new Error('agent_connected_service_unavailable');
        // The inventory displays its first healthy profile; persist that exact account, not a service-wide fallback.
        const profile = service.profiles?.find(profile => profile.healthy);
        if (input.serviceId !== null && (!service.connected || !service.healthy || !profile)) {
            throw new Error('connected_account_unavailable');
        }
        return { kind: 'service', input: {
            agentId: input.agent.agentId, machineId: input.machineId, service: identity,
            selection: input.serviceId === null ? { source: 'native' }
                : { source: 'connected', selection: 'profile', profileId: profile!.profileId },
        } };
    });
}
