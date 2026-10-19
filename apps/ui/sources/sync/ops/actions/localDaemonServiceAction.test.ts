import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { readLocalDaemonSharedState, publishLocalDaemonStatus } from '@/components/settings/machines/localControl/localDaemonSharedState';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { markUpdateCompletionsSeen, readUnseenUpdateCompletions } from '@/updates/updateCompletions';
import { buildUpdateItemId } from '@/updates/items/updateItem';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { setDesktopLoginStartMode } from '@/components/settings/desktop/desktopLoginStart';
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
vi.mock('expo-router/build/link/href', () => ({ resolveHref: vi.fn() }));
vi.mock('@/config', () => ({ config: { variant: 'production', identityVariant: 'stable' } }));
vi.mock('@/text', async () => ({ ...(await import('@/dev/testkit/mocks/text')).createTextModuleMock() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();

afterEach(() => { standardCleanup(); publishAppliedActiveServerRuntimeAvailability(false); vi.unstubAllGlobals(); });

const status: LocalDaemonStatusData = {
    serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'local-desktop',
    serviceAutostart: 'on-demand', managedServiceInstalled: true,
};

async function fixture(mode: 'tauri' | 'native' = 'tauri') {
    await harness.reset();
    const serverId = await harness.addHome({ name: 'Local service Home', serverUrl: 'https://service-home.test', serverIdentityId: 'srv_local-service', accountId: 'alice' });
    storage.setState({ settingsScope: { serverId, accountId: 'alice' }, profileScope: { serverId, accountId: 'alice' } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    const manual = createManualSystemTaskRunner(mode);
    publishLocalDaemonStatus(manual.runner, status);
    vi.stubGlobal('isTauri', true);
    const executor = createDefaultActionExecutor({ homeRuntimeRunner: manual.runner });
    return { serverId, manual, executor, context: { surface: 'ui', authority: 'present_user', serverId } as const };
}

describe('local daemon service Actions through the native task owner', () => {
    it.each([
        ['status', 'daemon.service.status.v1'], ['start', 'daemon.service.start.v1'],
        ['stop', 'daemon.service.stop.v1'], ['restart', 'daemon.service.restart.v1'],
        ['autostart.set', 'daemon.service.autostart.set.v1'], ['update', 'cli.update.v1'],
        ['disconnect', 'daemon.service.relay.disconnect.v1'],
    ] as const)('settles %s on the exact Home and publishes its native status', async (operation, kind) => {
        const { serverId, manual, executor, context } = await fixture();
        const actionId = `machines.local.service.${operation}` as const;
        const pending = executor.execute(actionId, { serverId, ...(operation === 'autostart.set' ? { autostart: 'at-login' } : {}) }, context);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe(kind));
        expect(manual.bridge.start.mock.calls[0]?.[0].params).toMatchObject({ target: { kind: 'local' }, mode: 'user' });
        if (operation === 'autostart.set') {
            expect(manual.bridge.start.mock.calls[0]?.[0].params).not.toHaveProperty('relayUrl');
        } else {
            expect(manual.bridge.start.mock.calls[0]?.[0].params).toMatchObject({ relayUrl: 'https://service-home.test', serverIdentityId: 'srv_local-service' });
        }
        if (operation === 'update') expect(readLocalDaemonSharedState(manual.runner).cliUpdate.taskId).toBe('personal-home-task-1');
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true,
            data: operation === 'status' ? status : operation === 'disconnect' ? { outcome: 'removed' } : {} });
        if (operation !== 'status') {
            await vi.waitFor(() => expect(manual.bridge.start.mock.calls[1]?.[0].kind).toBe('daemon.service.status.v1'));
            manual.emitResult('personal-home-task-2', { protocolVersion: 1, taskId: 'personal-home-task-2', ok: true,
                data: { ...status, serviceAutostart: operation === 'autostart.set' ? 'at-login' : 'on-demand' } });
        }
        expect(await pending).toMatchObject({ ok: true, result: operation === 'disconnect'
            ? { outcome: 'removed' } : { taskId: 'personal-home-task-1', result: { ok: true } } });
        expect(readLocalDaemonSharedState<LocalDaemonStatusData>(manual.runner).status?.serviceAutostart)
            .toBe(operation === 'autostart.set' ? 'at-login' : 'on-demand');
    });

    it('refuses a phone bridge and a mismatching Home before native mutation', async () => {
        const { serverId, manual, executor, context } = await fixture('native');
        expect(await executor.execute('machines.local.service.start', { serverId }, context)).toMatchObject({ ok: false, errorCode: 'local_service_unavailable' });
        expect(manual.bridge.start).not.toHaveBeenCalled();
        const desktop = await fixture();
        expect(await desktop.executor.execute('machines.local.service.start', { serverId: 'another-home' }, desktop.context))
            .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
        expect(desktop.manual.bridge.start).not.toHaveBeenCalled();
    });

    it('preserves native failure codes without reporting task failure as successful control', async () => {
        const { serverId, manual, executor, context } = await fixture();
        const pending = executor.execute('machines.local.service.restart', { serverId }, context);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.restart.v1'));
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: false,
            error: { code: 'service_restart_failed', message: 'Service manager refused restart' } });
        expect(await pending).toMatchObject({ ok: false, errorCode: 'service_restart_failed' });
        expect(manual.bridge.start.mock.calls).toHaveLength(1);
    });

    it('cancels the admitted service task when the invocation aborts', async () => {
        const { serverId, manual, executor, context } = await fixture();
        const controller = new AbortController();
        const pending = executor.execute('machines.local.service.start', { serverId }, { ...context, signal: controller.signal });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.start.v1'));
        controller.abort();
        await pending;
        expect(manual.bridge.cancel).toHaveBeenCalledWith('personal-home-task-1');
        expect(manual.bridge.start.mock.calls).toHaveLength(1);
    });

    it('cancels the admitted status readback when the invocation aborts after mutation', async () => {
        const { serverId, manual, executor, context } = await fixture();
        const controller = new AbortController();
        const pending = executor.execute('machines.local.service.start', { serverId }, { ...context, signal: controller.signal });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.start.v1'));
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: {} });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[1]?.[0].kind).toBe('daemon.service.status.v1'));
        controller.abort();
        await pending;
        expect(manual.bridge.cancel).toHaveBeenCalledWith('personal-home-task-2');
    });

    it('changes the common login mode while its signed-in Home runtime is offline without publishing another scope', async () => {
        const { serverId, manual, executor, context } = await fixture();
        publishAppliedActiveServerRuntimeAvailability(false);
        const pending = executor.execute('machines.local.service.autostart.set', { serverId, autostart: 'at-login' }, context);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.autostart.set.v1'));
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: {} });
        expect(await pending).toMatchObject({ ok: true, result: { taskId: 'personal-home-task-1' } });
        expect(manual.bridge.start.mock.calls).toHaveLength(1);
        expect(readLocalDaemonSharedState<LocalDaemonStatusData>(manual.runner).status?.serviceAutostart).toBe('on-demand');
    });

    it('keeps the existing desktop row readback on the current Home when global login-start settles after a Home switch', async () => {
        const { manual } = await fixture();
        const pending = setDesktopLoginStartMode(manual.runner, 'at-login');
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.autostart.set.v1'));
        await harness.addHome({ name: 'Current Home', serverUrl: 'https://current-service-home.test', accountId: 'bob' });
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: {} });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[1]?.[0].kind).toBe('daemon.service.status.v1'));
        const readback = manual.bridge.start.mock.calls[1]?.[0];
        manual.emitResult('personal-home-task-2', { protocolVersion: 1, taskId: 'personal-home-task-2', ok: true, data: status });
        await pending;
        expect(readback?.params).toMatchObject({ relayUrl: 'https://current-service-home.test' });
    });

    it('uses the shared CLI-update admission instead of starting a second update', async () => {
        const { serverId, manual, executor, context } = await fixture();
        const first = executor.execute('machines.local.service.update', { serverId }, context);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('cli.update.v1'));
        expect(await executor.execute('machines.local.service.update', { serverId }, context)).toMatchObject({ ok: false, errorCode: 'cli_update_in_progress' });
        expect(manual.bridge.start.mock.calls).toHaveLength(1);
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: false, error: { code: 'cli_not_managed', message: 'User-owned CLI' } });
        expect(await first).toMatchObject({ ok: false, errorCode: 'cli_not_managed' });
    });

    it('does not misreport native update launch failure as an update already running', async () => {
        const { serverId, manual, executor, context } = await fixture();
        manual.bridge.start.mockRejectedValueOnce(new Error('system_tasks_unavailable'));
        expect(await executor.execute('machines.local.service.update', { serverId }, context))
            .toMatchObject({ ok: false, errorCode: 'local_service_update_failed' });
        expect(readLocalDaemonSharedState(manual.runner).cliUpdate.starting).toBe(false);
    });

    it('records local-computer update completion for the initiating Home without attributing another Home machine id', async () => {
        const { serverId, manual, executor, context } = await fixture();
        const initiating = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice' };
        markUpdateCompletionsSeen(initiating);
        const otherId = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other-service-home.test', accountId: 'bob' });
        storage.setState({ settingsScope: { serverId: otherId, accountId: 'bob' }, profileScope: { serverId: otherId, accountId: 'bob' } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        publishLocalDaemonStatus(manual.runner, { ...status, machineId: 'other-home-machine' });
        const other = { serverId: resolveServerProfileScopeIdForIdentifier(otherId), accountId: 'bob' };
        markUpdateCompletionsSeen(other);
        const pending = executor.execute('machines.local.service.update', { serverId }, context);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('cli.update.v1'));
        expect(manual.bridge.start.mock.calls[0]?.[0].params).toMatchObject({ target: { kind: 'local' }, relayUrl: 'https://service-home.test' });
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: {} });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[1]?.[0].kind).toBe('daemon.service.status.v1'));
        manual.emitResult('personal-home-task-2', { protocolVersion: 1, taskId: 'personal-home-task-2', ok: true, data: status });
        expect(await pending).toMatchObject({ ok: true });
        expect(readUnseenUpdateCompletions(initiating).get(buildUpdateItemId('this-computer', { kind: 'happier-cli' }))).toBe('done');
        expect(readUnseenUpdateCompletions(initiating).has(buildUpdateItemId('other-home-machine', { kind: 'happier-cli' }))).toBe(false);
        expect(readUnseenUpdateCompletions(other).size).toBe(0);
        expect(readLocalDaemonSharedState<LocalDaemonStatusData>(manual.runner).status?.machineId).toBe('other-home-machine');
    });
});
