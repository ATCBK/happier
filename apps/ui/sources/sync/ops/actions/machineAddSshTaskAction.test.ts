import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { storage } = await import('@/sync/domains/state/storageStore');
vi.mock('expo-router/build/link/href', () => ({ resolveHref: vi.fn() }));
vi.mock('@/config', () => ({ config: { variant: 'production', identityVariant: 'stable' } }));
// This native rendering package is outside the task process and never renders here.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
vi.mock('@/text', async () => ({ ...(await import('@/dev/testkit/mocks/text')).createTextModuleMock() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const { createMachineConnectionActionDeps } = await import('./machineConnectionActionDeps');

afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });
describe('SSH machine Action task lifetime', () => {
    it('shares its retained task with the UI, refuses secret author input and cancels the exact task', async () => {
        await harness.reset();
        const serverId = await harness.addHome({ name: 'SSH Home', serverUrl: 'https://ssh.example', serverIdentityId: 'srv_ssh-home', accountId: 'alice' });
        storage.setState({ settingsScope: { serverId, accountId: 'alice' }, machineListByServerId: { [serverId]: [] } });
        const manual = createManualSystemTaskRunner('native');
        vi.stubGlobal('isTauri', true);
        const deps = createMachineConnectionActionDeps({ runner: manual.runner });
        const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId };
        const started = await executor.execute('machines.add.ssh.start', { serverId, host: 'build-box', authMode: 'password' }, context);
        expect(started).toEqual({ ok: true, result: { taskId: expect.any(String) } });
        if (!started.ok || !started.result || typeof started.result !== 'object' || !('taskId' in started.result) || typeof started.result.taskId !== 'string') throw new Error('No task');
        const taskId = started.result.taskId;
        const { readMachineAddFlowDraft, discardMachineAddFlowDraft } = await import('@/components/machines/add/machineAddFlowStore');
        try {
            expect(readMachineAddFlowDraft().sshTask?.taskId).toBe(taskId);
            manual.emitEvent(taskId, { type: 'prompt', message: 'Trust this host?', data: {
                kind: 'ssh.trustHost', host: 'build-box', fingerprint: 'SHA256:host-key', keyType: 'ssh-ed25519', existingFingerprint: null,
            } });
            expect(await executor.execute('machines.add.ssh.respond', { taskId, answer: { kind: 'ssh.trustHost', trusted: true } }, context))
                .toEqual({ ok: true, result: { taskId } });
            expect(manual.bridge.respond).toHaveBeenLastCalledWith(taskId, { trusted: true });
            manual.bridge.respond.mockClear();
            manual.emitEvent(taskId, { type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: 'build-box' } });
            expect(await executor.execute('machines.add.ssh.status', { taskId }, context)).toMatchObject({ ok: true, result: { awaitingInput: true, prompt: { kind: 'ssh.password' } } });
            expect(await executor.execute('machines.add.ssh.respond', { taskId, answer: { kind: 'ssh.password', password: 'secret' } }, { ...context, surface: 'agent' })).toMatchObject({ ok: false });
            expect(manual.bridge.respond).not.toHaveBeenCalled();
            expect(await executor.execute('machines.add.ssh.cancel', { taskId }, context)).toEqual({ ok: true, result: { taskId } });
            expect(manual.bridge.cancel).toHaveBeenCalledWith(taskId);
            expect(await executor.execute('machines.add.ssh.status', { taskId }, context)).toMatchObject({ ok: true, result: { awaitingInput: false, prompt: null } });
            storage.setState({ settingsScope: { serverId, accountId: 'bob' } });
            expect(await executor.execute('machines.add.ssh.respond', { taskId, answer: { kind: 'ssh.trustHost', trusted: true } }, context))
                .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        } finally { discardMachineAddFlowDraft(); }
    });
});
