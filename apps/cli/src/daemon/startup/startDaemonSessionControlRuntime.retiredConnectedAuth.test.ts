import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { logger } from '@/ui/logger';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { startDaemonControlServer } from '../controlServer';
import type { TrackedSession } from '../types';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';

// Replace only the loopback HTTP listener; startup and generation owners stay real.
vi.mock('@/daemon/controlServer', () => ({
    startDaemonControlServer: vi.fn(async () => ({ port: 44321, stop: async () => {} })),
}));

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
afterEach(() => {
    envScope.restore();
    reloadConfiguration();
    vi.restoreAllMocks();
});

it.each(['retained', 'removed'] as const)('skips connected credential reconciliation after runner exit leaves %s tracking custody', async (tracking) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-retired-connected-auth-'));
    envScope.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const registry = new ConnectedServiceRuntimeRegistry();
    const retiredPid = 2147482901;
    const activePid = 2147482902;
    const retiredSessionId = 'session-retired-connected-auth';
    const activeSessionId = 'session-active-connected-auth';
    const metadata = createTestMetadata({ hostPid: retiredPid, startedBy: 'daemon', happyHomeDir: home });
    const retired: TrackedSession = {
        pid: retiredPid, startedBy: 'daemon', happySessionId: retiredSessionId,
        happySessionMetadataFromLocalWebhook: metadata,
        // The exit owner marks this before disposing the Session purpose lease,
        // while durable exit settlement may still retain the tracked entry.
        reportMarkerCustody: { pending: Promise.resolve(), retiring: true },
    };
    const active: TrackedSession = {
        pid: activePid, startedBy: 'daemon', happySessionId: activeSessionId,
        happySessionMetadataFromLocalWebhook: { ...metadata, hostPid: activePid },
    };
    const trackedSessions = new Map([[retiredPid, retired], [activePid, active]]);
    const credentials = { token: 'fixture-daemon', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } } satisfies StoredCredentials;
    const mutationCustody = createDaemonSessionMutationCustody({ credentials });
    const runtime = await startDaemonSessionControlRuntime({
        machineId: 'machine-retired-connected-auth', serverId: configuration.activeServerId,
        serverBaseUrl: configuration.apiServerUrl,
        credentials, daemonSessionMutationCustody: mutationCustody,
        api: {} as never,
        connectedServiceRuntimeRegistry: registry,
        connectedServicesMaterializationBaseDir: join(home, 'connected-services'),
        getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
        pidToTrackedSession: trackedSessions, pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(),
        pidToSpawnWebhookTimeout: new Map(), getApiMachineForSessions: () => null,
        spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
        connectedServicesRestartRequestedPids: new Set(),
        startupTerminalRecovery: { disconnectedTerminalHostCandidates: [], unresolvedTerminalHostSessionIds: [] },
        beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {}, processEnv: {},
    });
    try {
        // Home HTTP is the true external boundary. An active target reaches it;
        // a retired target must never rematerialize using a disposed purpose lease.
        const accountReads = vi.spyOn(axios, 'get').mockRejectedValue(new Error('fixture Home unavailable'));
        const diagnostics = vi.spyOn(logger, 'debug');
        const register = (pid: number, sessionId: string) => registry.registerTarget({
            pid, sessionId, agentId: 'claude', materializationKey: 'csm_' + sessionId,
            connectedServicesBindingsRaw: {
                v: 2, bindingsByServiceId: {
                    'happier.agent.claude/claude-subscription': {
                        source: 'connected', selection: 'profile', profileId: 'subscription',
                    },
                },
            },
        });
        register(retiredPid, retiredSessionId);
        if (tracking === 'removed') trackedSessions.delete(retiredPid);
        const control = vi.mocked(startDaemonControlServer).mock.calls.at(-1)?.[0];
        const mcpClosed = await control!.agentRuntimeDaemonServices!.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({
            v: 1,
            context: { token: 'a'.repeat(43), sessionId: activeSessionId },
            operation: { kind: 'mcp.request_auth.close', requestId: 'close-mcp', materializationId: 'retired-mcp' },
        }), {
            sessionId: activeSessionId, trackedSession: active,
            retainedAgent: { pluginId: 'happier.agent.claude' },
        } as Parameters<NonNullable<NonNullable<typeof control>['agentRuntimeDaemonServices']>['dispatch']>[1]);
        expect(mcpClosed).toEqual({ ok: true, result: { kind: 'mcp.request_auth.closed' } });
        await control!.onHappySessionWebhook(retiredSessionId, metadata);
        // Enqueue the active target after the asynchronous follow-up. Its terminal
        // diagnostic proves the same reconciliation queue drained the earlier work.
        await new Promise<void>((resolve) => setImmediate(resolve));
        register(activePid, activeSessionId);
        await vi.waitFor(() => expect(diagnostics.mock.calls.some(([message, detail]) => (
            message === '[DAEMON RUN] Failed to reconcile connected-service group generation after runtime registration'
            && typeof detail === 'object' && detail !== null && Reflect.get(detail, 'pid') === activePid
        ))).toBe(true));
        expect(accountReads).toHaveBeenCalledTimes(1);
        expect(diagnostics.mock.calls.some(([message, detail]) => (
            message === '[DAEMON RUN] Failed to reconcile session startup follow-up'
            && typeof detail === 'object' && detail !== null && Reflect.get(detail, 'sessionId') === retiredSessionId
        ))).toBe(false);
    } finally {
        await runtime.stopControlServer();
        await mutationCustody.close();
        await rm(home, { recursive: true, force: true });
    }
});
