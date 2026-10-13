import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionDescribeResponseSchema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionFixture, createPlainMachineRowFixture } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.stubGlobal('__DEV__', true);
vi.stubGlobal('self', globalThis);

// Install the real Home/Account transport fixture before importing store/Sync consumers.
const network = await installSessionOpsNetworkBoundary();
let targetHome: Awaited<ReturnType<typeof network.addHome>>;
let focusedHome: Awaited<ReturnType<typeof network.addHome>>;
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
const { assertActiveDaemonTargetSession, resolveVoiceAgentSessionFromState } = await import('./voiceAgentRunState');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');

function projection(terminal: boolean) {
    // A daemon response is an external fixture; its public strict schema owns the shape.
    return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1,
        projection: {
            v: 2,
            generation: 3,
            agentsById: {
                claude: {
                    id: 'claude',
                    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                    capabilities: {
                        ...(terminal ? { surfaces: ['terminal'] } : {}),
                        sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
                    },
                },
            },
            familiesById: {},
        },
    });
}

function seedTargetSession(overrides: Parameters<typeof createSessionFixture>[0] = {}) {
    const session = createSessionFixture({
        id: 'target-1', serverId: targetHome.id, active: true,
        metadata: { flavor: 'claude', machineId: 'machine-1', path: '/tmp/target' },
        ...overrides,
    });
    storage.setState({ sessions: { [session.id]: session }, sessionListIndexByServerId: {
        [targetHome.id]: [{ type: 'session', sessionId: session.id, serverId: targetHome.id, serverName: 'Target' }],
    } });
    return session;
}

describe('assertActiveDaemonTargetSession', () => {
    beforeEach(async () => {
        clearDaemonMergedProjectionCacheForTests();
        network.resetRequests();
        targetHome = await network.addHome('https://voice-target.example.test', 'account-a');
        focusedHome = await network.addHome('https://voice-focused.example.test', 'account-a');
        network.setHttpResponder(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/machines/machine-1') return Response.json({ machine: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' }) });
            return null;
        });
        await setActiveServer({ serverId: focusedHome.id });
        storage.setState({ sessions: {}, machines: {}, machineListByServerId: {}, sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} });
        seedTargetSession();
    });
    afterAll(() => network.dispose());

    it('admits a target whose own Home projects the terminal surface for its Agent', async () => {
        network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, projection(true));
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' })).resolves.toBeUndefined();
        expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE))
            .toMatchObject([{ targetId: 'machine-1', serverUrl: targetHome.serverUrl }]);
    });

    it('refuses a target whose projected Agent declares no terminal surface', async () => {
        network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, projection(false));
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' }))
            .rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED' });
    });

    it('fails closed when the target Home cannot project its Agent declarations', async () => {
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' }))
            .rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED' });
    });

    it('fails closed for an unreadable Agent identity even with a ready projection', async () => {
        seedTargetSession({ metadata: { machineId: 'machine-1', path: '/tmp/target' } });
        network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, projection(true));
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' }))
            .rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED' });
    });

    it('still reports inactive and offline targets after the capability check passes', async () => {
        network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, projection(true));
        seedTargetSession({ active: false });
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' }))
            .rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_SESSION_INACTIVE' });
        seedTargetSession({ presence: 'offline' });
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' }))
            .rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_SESSION_OFFLINE' });
    });

    it('does not use a direct Session row from another Home for an explicit target', () => {
        seedTargetSession({ serverId: focusedHome.id });
        storage.setState({ sessionListIndexByServerId: {} });
        expect(resolveVoiceAgentSessionFromState({ serverId: targetHome.id, sessionId: 'target-1' })).toBeNull();
    });

    it('fails closed when a bare Session ID is present on more than one Home', () => {
        storage.setState({ ordinarySessionListMembershipByServerId: {
            [targetHome.id]: ['target-1'], [focusedHome.id]: ['target-1'],
        } });
        expect(resolveVoiceAgentSessionFromState('target-1')).toBeNull();
    });
});
