import * as React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { beginAcpCatalogLoad, getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { projectMachineAgentConnectedServices } from '@/agents/machineAgents/machineAgentConnectedServices';
import { projectMachineAgent, projectMachineAgentForCredential } from '@/agents/machineAgents/machineAgentModel';
import { resolveAgentSessionStartBlockLine } from '@/components/machines/agents/agentSessionStartBlockLine';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

// Install HTTP/Socket boundaries before the real strip loads its store graph.
const network = await installSessionOpsNetworkBoundary();
afterAll(() => network.dispose());

describe('New Session loading target → launch admission → composer status', () => {
    let resolveAgentLaunchBlockedReasonForNewSession: typeof import('./newSessionAgentSelection').resolveAgentLaunchBlockedReasonForNewSession;
    let resolveNewSessionCreateAdmission: typeof import('../hooks/screenModel/newSessionCreateAdmission').resolveNewSessionCreateAdmission;
    let buildNewSessionLaunchStatus: typeof import('../hooks/screenModel/newSessionLaunchStatusBadges').buildNewSessionLaunchStatus;
    let SessionInstrumentStrip: typeof import('@/components/sessions/agentInput/instrumentStrip/SessionInstrumentStrip').SessionInstrumentStrip;
    beforeAll(async () => {
        ({ resolveAgentLaunchBlockedReasonForNewSession } = await import('./newSessionAgentSelection'));
        ({ resolveNewSessionCreateAdmission } = await import('../hooks/screenModel/newSessionCreateAdmission'));
        ({ buildNewSessionLaunchStatus } = await import('../hooks/screenModel/newSessionLaunchStatusBadges'));
        ({ SessionInstrumentStrip } = await import('@/components/sessions/agentInput/instrumentStrip/SessionInstrumentStrip'));
    });

    it('renders Checking from the Account catalog producer while admission remains blocked', async () => {
        const scope = { serverId: 'readiness-seam', accountId: 'readiness-account' };
        beginAcpCatalogLoad(scope);
        const reason = resolveAgentLaunchBlockedReasonForNewSession({
            backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review' },
            selectedBackendEntry: null, projectionPhase: 'ready',
            acpCatalog: getAcpCatalogSnapshot(scope)!.catalog,
            agentLabel: 'Review', selectedCredentialMachineAgent: null,
            machineAgentsStatus: 'ready', agentStartBlock: null,
        });
        const admission = resolveNewSessionCreateAdmission([{ ready: reason === null, reason: reason ?? '' }]);
        expect(admission.canCreate).toBe(false);
        const status = buildNewSessionLaunchStatus({
            isCreating: false, disabledReason: admission.disabledReason, translate: key => key,
        });
        const strip = await renderScreen(<SessionInstrumentStrip connectionStatus={status.line ? {
            text: status.line.text, color: 'gray', dotColor: 'gray',
        } : null} />);
        expect(strip.findHostByTestId('agent-input-connection-status-text')?.children).toContain('machineAgents.checking');
        await strip.unmount();
    });

    it('carries exact connected-account health into admission and the rendered reconnect action', async () => {
        const service = { pluginId: 'acme.agent', localId: 'account' };
        const connectedServices = projectMachineAgentConnectedServices({
            agents: [{ agentId: 'claude', connectedAccounts: [{ purpose: 'primary', service }] }],
            profile: { connectedServicesV2: [], connectedAccountsV4: ['healthy', 'revoked'].map(accountId => ({
                ref: { service, accountId }, status: accountId === 'healthy' ? 'refresh_failed_retryable' : 'needs_reauth',
                authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
                revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuv', scopes: [],
            })) },
            accountTransport: 'advertised-v4', now: 1000,
            entries: [{ service, serviceId: 'account', executable: true, connectCommand: 'connect', supportsOauth: true,
                projectedDescriptor: { id: 'account', serviceId: 'account', pluginId: service.pluginId, title: 'Work account',
                    provenance: 'external', sourceKind: 'installed', capabilities: [], diagnostics: [],
                    availability: { state: 'available', reason: 'resolved' }, authentication: { defaultModeId: 'oauth',
                        modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                            pkce: 'required', outcomeReconciliation: 'providerCheck' }] } } }],
        }).claude;
        const raw = projectMachineAgent({ agentId: 'claude', title: 'Claude', checking: false, stale: false, job: null,
            facts: { agentId: 'claude', title: 'Claude', installed: true, version: '1', latestVersion: null, update: { supported: false, command: null },
                signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, platform: { supported: true },
                install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] },
            connectedServices,
        });
        for (const profileId of ['healthy', 'revoked']) {
            const agent = projectMachineAgentForCredential(raw, { credentialBindings: { v: 2, bindingsByServiceId: {
                'acme.agent/account': { source: 'connected', selection: 'profile', profileId },
            } } });
            const reconnect = vi.fn();
            const block = resolveAgentSessionStartBlockLine({ agent, machineName: 'Devbox',
                connectedServicesRecoveryAction: { label: 'Reconnect', testID: 'reconnect-profile', onPress: reconnect } });
            const reason = resolveAgentLaunchBlockedReasonForNewSession({
                backendTarget: { kind: 'backend', backendId: 'claude' }, selectedBackendEntry: {
                    backendTarget: { kind: 'backend', backendId: 'claude' }, backendTargetKey: 'agent:happier.agent.claude/claude',
                    builtInAgentId: 'claude', agentId: 'claude', kind: 'builtInAgent',
                }, projectionPhase: 'ready', acpCatalog: null, agentLabel: 'Claude', selectedCredentialMachineAgent: agent,
                machineAgentsStatus: 'ready', agentStartBlock: block,
            });
            const admission = resolveNewSessionCreateAdmission([{ ready: reason === null, reason: reason ?? '' }]);
            expect(admission.canCreate).toBe(profileId === 'healthy');
            if (profileId === 'healthy') continue;
            const status = buildNewSessionLaunchStatus({ isCreating: false, disabledReason: admission.disabledReason,
                agentStartBlock: block, translate: key => key });
            const strip = await renderScreen(<SessionInstrumentStrip connectionStatus={status.line ? {
                text: status.line.text, color: 'gray', dotColor: 'gray', action: status.line.action,
            } : null} />);
            expect(strip.findHostByTestId('agent-input-connection-status-text')?.children)
                .toContain('connectedServices.diagnostics.status.connected_service_credential_reconnect_required');
            await strip.pressByTestId('reconnect-profile');
            expect(reconnect).toHaveBeenCalledOnce();
            await strip.unmount();
        }
    });
});
