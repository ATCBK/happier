import { describe, expect, it, vi } from 'vitest';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';

import { resolveAgentSessionStartBlockLine } from './agentSessionStartBlockLine';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const signedOutAgent = {
    agentId: 'claude', title: 'Claude', state: 'needsSignIn', installed: true,
    version: '1', latestVersion: '1', update: null,
    signIn: { status: 'signedOut', via: null, nativeLogin: 'terminal', connectedServices: [] },
    platform: { supported: true },
    install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null, requiresVendorConsent: false },
    dependencies: [], job: null, stale: false,
} satisfies MachineAgent;

const notInstalledAgent = { ...signedOutAgent, state: 'notInstalled', installed: false } satisfies MachineAgent;

describe('resolveAgentSessionStartBlockLine', () => {
    it('explains the selected revoked account and offers reconnect instead of native sign-in', () => {
        const reconnect = vi.fn();
        const line = resolveAgentSessionStartBlockLine({ machineName: 'Devbox',
            agent: { ...signedOutAgent, signIn: { ...signedOutAgent.signIn, connectedAccountFailure: {
                code: 'connected_service_credential_reconnect_required', serviceId: 'acme.agent/account', profileId: 'work',
            } } },
            connectedServicesRecoveryAction: { label: 'Reconnect', testID: 'new-session-agent-blocker.reconnect', onPress: reconnect },
        });
        expect(line?.text).toBe('connectedServices.diagnostics.status.connected_service_credential_reconnect_required');
        expect(line?.action.testID).toBe('new-session-agent-blocker.reconnect');
        expect(line?.secondaryAction).toBeUndefined();
        line?.action.onPress();
        expect(reconnect).toHaveBeenCalledOnce();
    });
    it('says nothing when the agent can start', () => {
        expect(resolveAgentSessionStartBlockLine({ agent: null, machineName: 'Devbox' })).toBeNull();
        expect(resolveAgentSessionStartBlockLine({ agent: { ...signedOutAgent, state: 'ready', signIn: { ...signedOutAgent.signIn, status: 'signedIn' } }, machineName: 'Devbox' })).toBeNull();
    });

    it('keeps the sign-in action visible but disabled while its consumer has no resolved destination', () => {
        const line = resolveAgentSessionStartBlockLine({ agent: signedOutAgent, machineName: 'Devbox', onSetUp: undefined });
        expect(line?.action).toMatchObject({ testID: 'new-session-agent-blocker.action', disabled: true });
        expect(line?.secondaryAction).toBeUndefined();
    });

    it('opens setup for the agent once its consumer has a resolved destination', () => {
        const openSetup = vi.fn();
        const line = resolveAgentSessionStartBlockLine({ agent: signedOutAgent, machineName: 'Devbox', onSetUp: openSetup });
        expect(line?.action.disabled).not.toBe(true);
        line?.action.onPress();
        expect(openSetup).toHaveBeenCalledWith(signedOutAgent);
    });

    it('leads with the one-tap connected account and keeps native sign-in as the second way forward', () => {
        // Orchestrator ruling 2026-10-11 (DESIGN-SESSION #17): switching to a healthy connected account is
        // immediate, so it is the primary; native sign-in stays reachable after it.
        const recover = vi.fn();
        const openSetup = vi.fn();
        const line = resolveAgentSessionStartBlockLine({ agent: signedOutAgent, machineName: 'Devbox', onSetUp: openSetup,
            connectedServicesRecoveryAction: { label: 'Use Claude (work)', onPress: recover, testID: 'new-session-agent-blocker.connected' } });
        expect(line?.action.testID).toBe('new-session-agent-blocker.connected');
        expect(line?.secondaryAction?.testID).toBe('new-session-agent-blocker.action');
        line?.action.onPress();
        expect(recover).toHaveBeenCalledOnce();
        line?.secondaryAction?.onPress();
        expect(openSetup).toHaveBeenCalledWith(signedOutAgent);
    });

    it('says a short cause on the line and keeps the machine in the detail, for a signed-out and a missing agent', () => {
        const signedOut = resolveAgentSessionStartBlockLine({ agent: signedOutAgent, machineName: 'Devbox', onSetUp: vi.fn() });
        expect(signedOut?.text).toContain('Claude');
        expect(signedOut?.text).not.toContain('Devbox');
        expect(signedOut?.detail).toContain('Devbox');
        const notInstalled = resolveAgentSessionStartBlockLine({ agent: notInstalledAgent, machineName: 'Devbox', onSetUp: vi.fn(),
            connectedServicesRecoveryAction: { label: 'Use Claude (work)', onPress: vi.fn() } });
        expect(notInstalled?.text).not.toContain('Devbox');
        expect(notInstalled?.detail).toContain('Devbox');
        // A connected account cannot install an agent: setup stays the only action.
        expect(notInstalled?.action.testID).toBe('new-session-agent-blocker.action');
        expect(notInstalled?.secondaryAction).toBeUndefined();
    });
});
