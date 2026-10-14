import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentInstallJobSchema, DaemonAgentInstallStartRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), confirm: vi.fn() }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: boundary.confirm } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.rpc }));
// Unused HTTP boundary: native readiness never performs recipient-envelope work.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Unexpected recipient-envelope request'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { useAgentInstallJob } = await import('./installJobs/useAgentInstallJob');
const { useAgentSignIn } = await import('./signIn/useAgentSignIn');
const { useMachineAgentRowActions } = await import('@/components/machines/agents/useMachineAgentRowActions');
const { machineAgentInventoryStore } = await import('./machineAgentInventoryStore');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');

describe('readiness user intents through mounted Actions', () => {
    beforeEach(async () => { await home.reset(); boundary.rpc.mockReset(); boundary.confirm.mockReset(); boundary.confirm.mockResolvedValue(false); });
    afterEach(() => { standardCleanup(); vi.useRealTimers(); });

    async function target(machineId: string, agentId = 'codex') {
        const serverId = await home.addHome({ name: 'Readiness', serverUrl: 'https://readiness.test', accountId: 'alice' });
        return { serverId, machineId, agentId };
    }

    function installation(agentId: string) {
        let started = false;
        let cancelled = false;
        const job = AgentInstallJobSchema.parse({ jobId: 'readiness-job', agentId, intent: 'install', startedAt: 1,
            steps: [{ stepId: 'cli', label: 'Agent CLI', state: 'running' }], progress: [{ stepId: 'cli', bytesDone: 3, bytesTotal: 10 }],
            done: false, outcome: null });
        boundary.rpc.mockImplementation(async ({ method, payload }) => {
            if (method === 'daemon.agents.install.start') { DaemonAgentInstallStartRequestSchema.parse(payload); started = true; return { ok: true, jobId: job.jobId }; }
            if (method === 'daemon.agents.install.list') return { ok: true, jobs: started ? [job] : [] };
            if (method === 'daemon.agents.install.cancel') { cancelled = true; return { ok: true }; }
            if (method === 'daemon.agents.install.read') return { ok: true, steps: job.steps, progress: job.progress, events: [], nextCursor: 1,
                done: cancelled, outcome: cancelled ? { kind: 'failed', code: 'cancelled', stepId: 'cli', message: 'Cancelled' } : null };
            throw new Error(method);
        });
    }

    it.each(['install', 'update', 'uninstall'] as const)('a rejected %s confirmation starts no daemon job', async (intent) => {
        const addressed = await target(`rejected-${intent}`);
        installation(addressed.agentId);
        const hook = await renderHook(() => useAgentInstallJob(addressed));
        await act(async () => { await hook.getCurrent().start(intent, { consent: { vendorRecipe: true } }); });
        expect(boundary.confirm).toHaveBeenCalledOnce();
        expect(boundary.rpc.mock.calls.some(([request]) => request.method === 'daemon.agents.install.start')).toBe(false);
        expect(hook.getCurrent().job).toBeNull();
    });

    it('admitted install progress and cancellation remain in the same subscribed owner', async () => {
        const addressed = await target('admitted-install');
        installation(addressed.agentId); boundary.confirm.mockResolvedValue(true);
        const first = await renderHook(() => useAgentInstallJob(addressed));
        const second = await renderHook(() => useAgentInstallJob(addressed));
        await act(async () => { await first.getCurrent().start('install', { consent: { vendorRecipe: false } }); });
        await waitForHomeGovernance(() => expect(second.getCurrent().job).toMatchObject({ jobId: 'readiness-job', steps: [{ bytesDone: 3 }] }));
        home.answer(addressed.serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'machines.agents.install.cancel': { enabled: false } } },
        } } } });
        await act(async () => { await second.getCurrent().cancel(); });
        expect(boundary.rpc.mock.calls.some(([request]) => request.method === 'daemon.agents.install.cancel')).toBe(false);
        expect(first.getCurrent().job?.outcome).toBeNull();
        home.answer(addressed.serverId, '/v2/account/settings', { body: { version: 2, content: { t: 'plain', v: {} } } });
        await act(async () => { await second.getCurrent().cancel(); });
        await waitForHomeGovernance(() => expect(first.getCurrent().job?.outcome).toMatchObject({ code: 'cancelled' }));
        expect(boundary.confirm).toHaveBeenCalledTimes(2);
    });

    it.each(['install', 'update', 'retry'] as const)('row %s cannot bypass the confirmation owner', async (kind) => {
        const addressed = await target(`row-${kind}`); installation(addressed.agentId);
        const key = serverAccountScopedResourceKey({ serverId: addressed.serverId, accountId: 'alice' }, 'machine-agents', addressed.machineId);
        machineAgentInventoryStore.publish(key, { status: 'ready', lastCheckedAt: 1, items: [MachineAgentInventoryItemSchema.parse({
            agentId: addressed.agentId, title: 'Codex', installed: false, version: null, latestVersion: null,
            update: { supported: true, command: null }, signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
            platform: { supported: true }, install: { available: true, mode: 'vendor_recipe', sizeBytes: null, guideUrl: null }, dependencies: [],
        })] });
        const hook = await renderHook(() => useMachineAgentRowActions({ ...addressed, machineName: 'Dev box', onOpenForm: () => {} }));
        await act(async () => { hook.getCurrent()(machineAgentInventoryStore.read(key).agents[0], { kind }); });
        await waitForHomeGovernance(() => expect(boundary.confirm).toHaveBeenCalledOnce());
        expect(boundary.rpc.mock.calls.some(([request]) => request.method === 'daemon.agents.install.start')).toBe(false);
    });

    it('a rejected native sign-in confirmation opens no daemon terminal', async () => {
        const addressed = await target('rejected-sign-in');
        const hook = await renderHook(() => useAgentSignIn(addressed));
        await act(async () => { await hook.getCurrent().start(); });
        expect(boundary.confirm).toHaveBeenCalledOnce();
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(hook.getCurrent().phase).toBe('idle');
    });

    it('native start/check/restart/cancel honor admission and share the mounted sign-in custody', async () => {
        vi.useFakeTimers();
        boundary.confirm.mockResolvedValue(true);
        const addressed = await target('admitted-sign-in');
        let terminalId = 'first-login';
        let signedIn = false;
        boundary.rpc.mockImplementation(async ({ method }) => {
            if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: addressed.agentId } };
            if (method === 'daemon.terminal.ensure') return { ok: true, terminalId, reused: false };
            if (method === 'daemon.terminal.list') return { ok: true, terminals: [{ terminalId,
                terminalKey: `provider-login:${addressed.machineId}:${addressed.agentId}`, cwd: '/fixture', ended: false, exit: null }] };
            if (method === 'daemon.terminal.close') { terminalId = 'second-login'; return { ok: true }; }
            if (method === 'daemon.agents.signIn.status') return { status: signedIn ? 'signedIn' : 'signedOut', accountLabel: null, checkedAt: 1, nativeLogin: 'login_terminal', connectedServices: [] };
            throw new Error(method);
        });
        home.answer(addressed.serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'machines.agents.signIn.start': { enabled: false } } },
        } } } });
        const first = await renderHook(() => useAgentSignIn(addressed));
        const second = await renderHook(() => useAgentSignIn(addressed));
        await act(async () => { await first.getCurrent().start(); });
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(second.getCurrent().phase).toBe('idle');
        home.answer(addressed.serverId, '/v2/account/settings', { body: { version: 2, content: { t: 'plain', v: {} } } });
        await act(async () => { await first.getCurrent().start(); });
        expect(second.getCurrent()).toMatchObject({ phase: 'waiting', terminalId: 'first-login' });
        home.answer(addressed.serverId, '/v2/account/settings', { body: { version: 3, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'machines.agents.signIn.cancel': { enabled: false },
                'machines.agents.signIn.restart': { enabled: false }, 'machines.agents.signIn.status': { enabled: false } } },
        } } } });
        await act(async () => { await second.getCurrent().checkAgain(); await second.getCurrent().restart(); await first.getCurrent().cancel(); });
        expect(second.getCurrent()).toMatchObject({ phase: 'waiting', terminalId: 'first-login' });
        expect(boundary.rpc.mock.calls.some(([request]) => request.method === 'daemon.terminal.close')).toBe(false);
        expect(boundary.rpc.mock.calls.some(([request]) => request.method === 'daemon.agents.signIn.status')).toBe(false);
        home.answer(addressed.serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
        signedIn = true;
        await act(async () => { await second.getCurrent().checkAgain(); });
        expect(first.getCurrent()).toMatchObject({ phase: 'signedIn', terminalId: 'first-login' });
        await act(async () => { await second.getCurrent().restart(); });
        expect(first.getCurrent()).toMatchObject({ phase: 'waiting', terminalId: 'second-login' });
        await act(async () => { await first.getCurrent().cancel(); });
        expect(second.getCurrent()).toMatchObject({ phase: 'idle', terminalId: null });
    });
});
