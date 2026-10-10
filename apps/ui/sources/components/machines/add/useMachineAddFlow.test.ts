import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerId, setActiveServerId, upsertServerProfile, removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { useMachineAddFlow, useMachineAddDraftRow, discardMachineAdd } from './useMachineAddFlow';
import { readMachineAddFlowDraft, updateMachineAddFlowDraft } from './machineAddFlowStore';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';

// Native navigation is an external boundary; this test never navigates.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
vi.mock('expo-router/build/link/href', () => ({ resolveHref: vi.fn() }));
vi.mock('@/config', () => ({ config: { variant: 'production', identityVariant: 'stable' } }));
// Canonical UI presentation boundaries; internal task/feed/arrival decisions remain real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

afterEach(async () => { await act(async () => discardMachineAdd()); vi.useRealTimers(); standardCleanup(); });
describe('machine add flow lifetime', () => {
    it('resumes its canonical SSH password prompt after remount and waits for the Home feed, not just task success', async () => {
        const previous = storage.getState();
        const previousServerId = getActiveServerId();
        const home = await upsertServerProfile({ serverUrl: 'https://ssh-flow.example.test', name: 'SSH Home' });
        const manual = createManualSystemTaskRunner('native');
        vi.stubGlobal('isTauri', true); // Desktop identity is an environment boundary; paths remain real.
        try {
            await setActiveServerId(home.id);
            storage.setState({ settingsScope: { serverId: home.id, accountId: 'fixture-account' }, machineListByServerId: { [home.id]: [] } });
            const first = await renderHook(() => useMachineAddFlow({ runner: manual.runner, initialPath: 'ssh' }));
            await act(async () => { first.getCurrent().ssh.setDraft({ ...first.getCurrent().ssh.draft, host: 'build-box', password: 'fixture-first-password' }); });
            await act(async () => { first.getCurrent().startSsh(); first.getCurrent().startSsh(); });
            const taskId = readMachineAddFlowDraft().sshTask?.taskId;
            expect(taskId).toBeTruthy();
            await act(async () => manual.emitEvent(taskId!, { type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: 'build-box' } }));
            expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { password: 'fixture-first-password' });
            await first.unmount();
            await act(async () => manual.emitEvent(taskId!, { type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: 'build-box' } }));
            const resumed = await renderHook(() => useMachineAddFlow({ runner: manual.runner }));
            expect(resumed.getCurrent().run?.prompt).toMatchObject({ kind: 'ssh.password' });
            await act(async () => { resumed.getCurrent().ssh.setDraft({ ...resumed.getCurrent().ssh.draft, password: 'fixture-password' }); });
            await act(async () => resumed.getCurrent().continueSshPrompt());
            expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { password: 'fixture-password' });
            await act(async () => manual.emitResult(taskId!, { protocolVersion: 1, taskId: taskId!, ok: true, data: { machineId: 'ssh-joined' } }));
            expect(resumed.getCurrent().arrived).toBeNull();
            expect(resumed.getCurrent().watch.status).toBe('watching');
            await act(async () => storage.setState({ machineListByServerId: { [home.id]: [createMachineFixture({ id: 'ssh-joined', activeAt: Date.now() })] } }));
            expect(resumed.getCurrent().arrived?.machineId).toBe('ssh-joined');
            expect(manual.bridge.start.mock.calls.filter(([spec]) => spec.kind === 'remote.ssh.bootstrapMachine.v1')).toHaveLength(1);
            await resumed.unmount();
        } finally {
            await act(async () => discardMachineAdd());
            storage.setState(previous);
            await setActiveServerId(previousServerId);
            await removeServerProfile(home.id);
            vi.unstubAllGlobals();
        }
    });
    it('cancels an OS start that resolves after Discard instead of resurrecting its draft', async () => {
        const previous = storage.getState();
        const previousServerId = getActiveServerId();
        const home = await upsertServerProfile({ serverUrl: 'https://pending-flow.example.test', name: 'Pending Home' });
        const manual = createManualSystemTaskRunner('native');
        let finishStart!: (id: string) => void;
        const pendingStart = new Promise<string>((resolve) => { finishStart = resolve; });
        const originalStart = manual.bridge.start.getMockImplementation()!;
        manual.bridge.start.mockImplementation((spec) => spec.kind === 'remote.ssh.bootstrapMachine.v1' ? pendingStart : originalStart(spec));
        vi.stubGlobal('isTauri', true);
        try {
            await setActiveServerId(home.id);
            storage.setState({ settingsScope: { serverId: home.id, accountId: 'fixture-account' }, machineListByServerId: { [home.id]: [] } });
            const hook = await renderHook(() => useMachineAddFlow({ runner: manual.runner, initialPath: 'ssh' }));
            await act(async () => hook.getCurrent().ssh.setDraft({ ...hook.getCurrent().ssh.draft, host: 'pending-box' }));
            await act(async () => hook.getCurrent().startSsh());
            expect(hook.getCurrent().run?.running).toBe(true);
            await act(async () => discardMachineAdd());
            await act(async () => finishStart('pending-ssh-task'));
            expect(manual.bridge.cancel).toHaveBeenCalledWith('pending-ssh-task');
            expect(hook.getCurrent().draftRow).toBeNull();
            expect(hook.getCurrent().watch.status).toBe('idle');
            await hook.unmount();
        } finally {
            await act(async () => discardMachineAdd());
            storage.setState(previous);
            await setActiveServerId(previousServerId);
            await removeServerProfile(home.id);
            vi.unstubAllGlobals();
        }
    });
    it('projects the retained SSH run in the rail without mounting the flow or reacting to password edits', async () => {
        const manual = createManualSystemTaskRunner('native');
        let renders = 0;
        const row = await renderHook(() => { renders++; return useMachineAddDraftRow(); });
        expect(row.getCurrent()).toBeNull();
        const taskId = await manual.runner.start({ protocolVersion: 1, kind: 'remote.ssh.bootstrapMachine.v1', params: {
            ssh: { target: 'box', auth: 'password' }, relay: { relayUrl: 'https://rail.test', webappUrl: 'https://rail.test' }, channel: 'stable', serviceMode: 'user', knownHostsMode: 'app',
        } });
        await act(async () => updateMachineAddFlowDraft((draft) => ({ ...draft, path: 'ssh', sshDraft: { ...draft.sshDraft, host: 'box' }, sshTask: { runner: manual.runner, taskId, starting: false, startError: null } })));
        expect(row.getCurrent()).toMatchObject({ title: 'box', tone: 'running' });
        const beforePassword = renders;
        await act(async () => updateMachineAddFlowDraft((draft) => ({ ...draft, sshDraft: { ...draft.sshDraft, password: 'secret' } })));
        expect(renders).toBe(beforePassword);
        await act(async () => manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: false, error: { code: 'connection-failed', message: 'Connection refused' } }));
        expect(row.getCurrent()?.tone).toBe('failed');
        await act(async () => discardMachineAdd());
        expect(row.getCurrent()).toBeNull();
        await row.unmount();
    });
    it('keeps its Home and arrival baseline when the presenter leaves and remounts', async () => {
        const previous = storage.getState();
        const home = await upsertServerProfile({ serverUrl: 'https://flow-home.example.test', name: 'Flow Home' });
        let discard: (() => void) | undefined;
        try {
            storage.setState({ machineListByServerId: { [home.id]: [createMachineFixture({ id: 'existing', activeAt: Date.now() })] } });
            const first = await renderHook(() => useMachineAddFlow({ serverId: home.id }));
            discard = first.getCurrent().discard;
            await act(async () => { first.getCurrent().choosePath('anotherComputer'); first.getCurrent().startWatching(); });
            const startedAtMs = first.getCurrent().watch.startedAtMs;
            expect(first.getCurrent().watch.status).toBe('watching');
            await first.unmount();
            storage.setState({ machineListByServerId: { [home.id]: [
                createMachineFixture({ id: 'existing', activeAt: Date.now() }),
                createMachineFixture({ id: 'new-computer', activeAt: Date.now() }),
            ] } });
            const resumed = await renderHook(() => useMachineAddFlow({ serverId: home.id }));
            expect(resumed.getCurrent().path).toBe('anotherComputer');
            expect(resumed.getCurrent().watch).toMatchObject({ status: 'arrived', startedAtMs });
            expect(resumed.getCurrent().arrived?.machineId).toBe('new-computer');
            await act(async () => resumed.getCurrent().discard());
            expect(resumed.getCurrent().watch.status).toBe('idle');
            await resumed.unmount();
        } finally {
            await act(async () => discard?.());
            storage.setState(previous);
            await removeServerProfile(home.id);
        }
    });
    it('reports not-seeing after five minutes without abandoning the watch, and discard stops it', async () => {
        const previous = storage.getState();
        const home = await upsertServerProfile({ serverUrl: 'https://flow-clock.example.test', name: 'Clock Home' });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        let discard: (() => void) | undefined;
        try {
            storage.setState({ machineListByServerId: { [home.id]: [] } });
            const hook = await renderHook(() => useMachineAddFlow({ serverId: home.id }));
            discard = hook.getCurrent().discard;
            await act(async () => { hook.getCurrent().choosePath('anotherComputer'); hook.getCurrent().startWatching(); });
            await act(async () => { vi.advanceTimersByTime(5 * 60_000 - 1); });
            expect(hook.getCurrent().watch.notSeeing).toBe(false);
            await act(async () => { vi.advanceTimersByTime(1); });
            expect(hook.getCurrent().watch).toMatchObject({ status: 'watching', notSeeing: true });
            await act(async () => hook.getCurrent().discard());
            expect(hook.getCurrent().watch).toMatchObject({ status: 'idle', notSeeing: false });
            await act(async () => storage.setState({ machineListByServerId: { [home.id]: [createMachineFixture({ id: 'late', activeAt: Date.now() })] } }));
            expect(hook.getCurrent().watch.status).toBe('idle');
            await hook.unmount();
        } finally {
            await act(async () => discard?.());
            vi.useRealTimers();
            storage.setState(previous);
            await removeServerProfile(home.id);
        }
    });
});
