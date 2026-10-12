import { describe, expect, it } from 'vitest';

import { resolveTemporaryComputerLaunchBlock } from './temporaryComputerLaunchReadiness';

describe('Temporary computer launch readiness', () => {
    it('reports no block when every creator producer is satisfied', () => {
        expect(resolveTemporaryComputerLaunchBlock({ ready: true, gaps: [] })).toBeNull();
    });

    it('names the exact missing producer so the creator can offer real recovery', () => {
        expect(resolveTemporaryComputerLaunchBlock({
            ready: false,
            gaps: ['team_credential_model_unselected'],
        })).toBe('team_credential_model_unselected');
        expect(resolveTemporaryComputerLaunchBlock({
            ready: false,
            gaps: ['agent_managed_install_undeclared'],
        })).toBe('agent_managed_install_undeclared');
    });

    it('reports the Agent install gap before a credential gap, because the model picker cannot fix it', () => {
        expect(resolveTemporaryComputerLaunchBlock({
            ready: false,
            gaps: ['team_credential_model_unselected', 'agent_managed_install_undeclared'],
        })).toBe('agent_managed_install_undeclared');
        expect(resolveTemporaryComputerLaunchBlock({
            ready: false,
            gaps: ['broker_selection_unavailable', 'team_credential_resource_unavailable'],
        })).toBe('team_credential_resource_unavailable');
    });

    it('fails closed with a typed block when readiness is false but no gap was recorded', () => {
        expect(resolveTemporaryComputerLaunchBlock({ ready: false, gaps: [] }))
            .toBe('broker_selection_unavailable');
    });

    it('ignores stale gaps once readiness is satisfied', () => {
        expect(resolveTemporaryComputerLaunchBlock({
            ready: true,
            gaps: ['team_credential_model_unselected'],
        })).toBeNull();
    });

    it.each([
        // A Team-resource Connected Service stays bound to an owner the endpoint
        // cannot reach, so Send must block while the composer is still editable
        // rather than letting the strict launch manifest reject it after the
        // package has been assembled and handed to someone else.
        ['connectedServices', {
            profileId: null,
            capabilitySelection: null,
            connectedServices: { v: 2, bindingsByServiceId: {
                'happier.service.github/github': { source: 'connected', selection: 'profile', profileId: 'work' },
                'happier.service.linear/linear': { source: 'team_resource', resourceId: 'resource-acme' },
            } },
        }],
    ] as const)('blocks the exact unsupported selected authoring field %s even when creator producers are ready', (field, authoring) => {
        expect(resolveTemporaryComputerLaunchBlock({ ready: true, gaps: [], authoring }))
            .toBe(`authoring_${field}_unsupported`);
    });

    it('keeps explicit MCP selection and endpoint-native Connected Service bindings launchable', () => {
        expect(resolveTemporaryComputerLaunchBlock({
            ready: true,
            gaps: [],
            authoring: {
                profileId: null,
                capabilitySelection: { mcp: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['server-a'],
                    forceExcludeServerIds: [],
                } },
                connectedServices: {
                    v: 2,
                    bindingsByServiceId: {
                        'happier.service.github/github': { source: 'native' },
                    },
                },
            },
        })).toBeNull();
    });

    it('blocks a selected-Agent provider environment override before launch', () => {
        expect(resolveTemporaryComputerLaunchBlock({
            ready: true,
            gaps: [],
            authoring: { environmentVariables: { HAPPIER_CODEX_PROVIDER_API_KEY: 'direct-secret' } },
            selectedAgentProviderOwnedEnvironmentKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY'],
        })).toBe('authoring_environmentVariables_unsupported');
    });
});
