import { describe, expect, it } from 'vitest';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { createSessionFixture } from '@/dev/testkit';
import { buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';

import {
    CONNECTED_SERVICES_BINDINGS_KEY,
    parseConnectedServicesBindingsByServiceIdFromAgentOptionState,
    parseConnectedServicesServiceBinding,
} from './connectedServicesAgentOptionStateBindings';

describe('retained Agent-option Team bindings', () => {
    it('recovers a configuration seed envelope and lets a newer explicit editor selection win', () => {
        const serviceId = 'happier.agent.claude/claude-subscription';
        const connectedServices = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
            [serviceId]: { source: 'connected', selection: 'profile', profileId: 'work' },
        } });
        const seed = buildNewSessionTempDataFromSessionConfiguration({
            session: createSessionFixture({ metadata: { path: '/repo', host: 'test',
                flavor: 'claude', connectedServices } }),
            machineId: 'machine-target',
        });
        const seededOptions = seed.backendNewSessionOptionStateByTargetKey?.['agent:happier.agent.claude/claude'];
        expect(seededOptions).toBeDefined();
        expect(ConnectedServiceBindingsV2Schema.parse(seededOptions?.connectedServices)).toEqual(connectedServices);
        const read = (agentOptionState: Record<string, unknown>) =>
            parseConnectedServicesBindingsByServiceIdFromAgentOptionState({ agentOptionState });
        expect(read(seededOptions!)).toEqual({ [serviceId]: { source: 'connected', profileId: 'work' } });
        expect(read({ ...seededOptions, [CONNECTED_SERVICES_BINDINGS_KEY]: { [serviceId]: { source: 'native' } } }))
            .toEqual({ [serviceId]: { source: 'native' } });
        expect(read({ connectedServices, [CONNECTED_SERVICES_BINDINGS_KEY]: null })).toEqual({});
        expect(read({ connectedServices: { ...connectedServices, v: 99 } })).toEqual({});
        // Observed 0.2 editor persistence uses scalar service keys and V1
        // bindings; the established protocol ingress owns their translation.
        expect(read({ [CONNECTED_SERVICES_BINDINGS_KEY]: {
            'claude-subscription': { source: 'connected', profileId: 'work' },
        } })).toEqual({ [serviceId]: { source: 'connected', profileId: 'work' } });
        expect(read({ [CONNECTED_SERVICES_BINDINGS_KEY]: {
            [serviceId]: { source: 'native' },
            'claude-subscription': { source: 'connected', profileId: 'work' },
        } })).toEqual({ [serviceId]: { source: 'native' } });
    });
    it('projects a direct disclosed member without relaxing authored binding admission or identity checks', () => {
        const binding = {
            source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'direct', retired: true,
            disclosedMember: {
                service: { pluginId: 'acme.provider', localId: 'gateway', retired: true },
                accountId: 'work', retired: true,
            },
        };
        const read = (value: unknown) => parseConnectedServicesBindingsByServiceIdFromAgentOptionState({
            agentOptionState: { [CONNECTED_SERVICES_BINDINGS_KEY]: { 'acme.provider/gateway': value } },
        });
        expect(read(binding)).toEqual({
            'acme.provider/gateway': {
                source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'direct',
                disclosedMember: { service: { pluginId: 'acme.provider', localId: 'gateway' }, accountId: 'work' },
            },
        });
        expect(parseConnectedServicesServiceBinding(binding)).toBeNull();
        expect(read({ ...binding, disclosedMember: { ...binding.disclosedMember, accountId: ' ' } })).toEqual({});
        expect(read({ ...binding, disclosedMember: { ...binding.disclosedMember, service: { pluginId: 42, localId: 'gateway' } } })).toEqual({});
        expect(read({ ...binding, deliveryMode: 'unknown' })).toEqual({});
    });

    it('retains brokered resource identity but rejects a known disclosed-member mismatch', () => {
        const read = (value: unknown) => parseConnectedServicesBindingsByServiceIdFromAgentOptionState({
            agentOptionState: { [CONNECTED_SERVICES_BINDINGS_KEY]: { service: value } },
        });
        const binding = { source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered', retired: true };
        expect(read(binding)).toEqual({ service: { source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered' } });
        expect(parseConnectedServicesServiceBinding(binding)).toBeNull();
        expect(read({ ...binding, disclosedMember: { service: { pluginId: 'acme.provider', localId: 'gateway' }, accountId: 'work' } })).toEqual({});
        expect(read({ ...binding, resourceId: '' })).toEqual({});
    });
});
