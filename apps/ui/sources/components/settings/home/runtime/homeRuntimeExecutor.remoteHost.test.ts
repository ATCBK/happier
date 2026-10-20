import { afterEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import type { SystemTaskBridge } from '@/components/systemTasks/types';

const desktop = vi.hoisted(() => ({ bridge: null as SystemTaskBridge | null }));
// Replace the native OS transport, not the shared runner or its lifecycle facade.
vi.mock('@/components/systemTasks/createTauriSystemTaskBridge', () => ({ createTauriSystemTaskBridge: () => {
    if (!desktop.bridge) throw new Error('SSH Home native task boundary was not installed');
    return desktop.bridge;
} }));

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Native presentation boundaries use the same setup as neighboring Home suites;
// admission, catalog scope, credentials and task completion keep the real store.
installSettingsViewCommonModuleMocks({ storage: 'real' });
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
const nativeTasks = createManualSystemTaskRunner();
desktop.bridge = nativeTasks.bridge;
await loadSyncSingletonForTests();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

const loadModules = async () => {
    const runtime = await import('@/components/systemTasks/systemTasksRuntime');
    const catalog = await import('@/sync/store/settings/remoteHostCatalogSnapshot');
    const executor = await import('./homeRuntimeExecutor');
    await import('@/sync/ops/actions/defaultActionExecutor');
    return { runtime, catalog, executor };
};
const modules = await loadModules();

afterEach(async () => {
    await standardCleanup();
    for (const { taskId } of modules.runtime.getSystemTasksRunner().listActiveTasks!()) {
        nativeTasks.emitResult(taskId, { protocolVersion: 1, taskId, ok: false,
            error: { code: 'test_fixture_ended', message: 'Native test fixture ended' } });
    }
    await connection?.dispose();
    connection = null;
    modules.catalog.resetRemoteHostCatalogSnapshotsForTests();
    await home.reset();
});

async function prepareHome() {
    const { runtime, catalog: { applyRemoteHostCatalogSnapshot }, executor: { restartHomeRuntime } } = modules;
    const serverId = await home.addHome({ name: 'SSH Home', serverUrl: 'https://ssh-home.test', accountId: 'account', currentAccount: true });
    const scope = { serverId, accountId: 'account' };
    const host = { id: 'home-host', name: 'Home host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
        linkedRelayProfileId: serverId, linkedMachineId: null,
        ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
    const catalog = { status: 'ready' as const, revision: 4, hosts: [host], diagnostics: [] };
    home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
        content: { t: 'plain', v: { v: 1, hosts: [host] } } } });
    home.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: { 'remote_hosts.relay.restart': { approvalRequiredSurfaces: ['ui'] } } },
    } } } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
    home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
    home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
    const emptySessions = SessionListQueryResponseV1Schema.parse({
        sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
    });
    home.answer(serverId, '/v2/sessions', { body: emptySessions });
    home.answer(serverId, '/v2/sessions/query', { body: emptySessions });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://ssh-home.test', { serverId });
    if (!credentials) throw new Error('SSH Home credentials were not stored');
    connection = await restoreServerAccountForTest({ serverUrl: 'https://ssh-home.test', accountId: 'account', credentials, request: home.request });
    applyRemoteHostCatalogSnapshot(scope, catalog, true);
    nativeTasks.bridge.start.mockClear();
    const manual = { ...nativeTasks, runner: runtime.getSystemTasksRunner() };
    return { serverId, scope, host, manual, restartHomeRuntime };
}

it.each([true, false, 'reject', 'cancel', 'observation_failed'] as const)('joins the real SSH approval and task lifecycle before accepting runtime health (%s)', async (healthy) => {
    const { serverId, scope, host, manual, restartHomeRuntime } = await prepareHome();
    let settled = false;
    let observed: Awaited<ReturnType<typeof restartHomeRuntime>> | undefined;
    let approval: Exclude<ActionApprovalRegistration, string> | undefined;
    const restarting = restartHomeRuntime({ kind: 'remote_host', host, hostName: host.name, scope, catalogRevision: 4 },
        { serverId, secretMaterialAllowed: false, onApprovalPending: (registration: ActionApprovalRegistration) => {
            if (typeof registration === 'string') throw new Error('Restart must retain its result continuation');
            approval = registration;
        } }).then(outcome => { settled = true; observed = outcome; return outcome; });
    await waitForHomeGovernance(() => {
        expect(approval !== undefined || observed !== undefined).toBe(true);
    });
    expect(observed).toBeUndefined();
    expect(approval).toBeDefined();
    expect(manual.runner.listActiveTasks!()).toHaveLength(0);
    const artifactId = approval!.artifactId;
    const denied = healthy === 'reject' || healthy === 'cancel';
    const decision = await decideApprovalAsInbox(serverId, artifactId, denied ? healthy : 'approve');
    expect(decision.ok).toBe(true);
    const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const captured = await captureActionAccountContext(serverId);
    const artifact = await captured.fetchArtifact(artifactId);
    captured.dispose();
    expect(artifact).not.toBeNull();
    if (denied) {
        approval!.onTerminal!(healthy === 'reject' ? 'rejected' : 'canceled', artifact);
        await expect(restarting).resolves.toMatchObject({ kind: 'cancelled' });
        expect(manual.runner.listActiveTasks!()).toHaveLength(0);
        return;
    }
    await approval!.onExecuted(artifact!);
    expect(manual.runner.listActiveTasks!(), JSON.stringify({ decision, observed })).toHaveLength(1);
    const taskId = manual.runner.listActiveTasks!()[0].taskId;
    expect(manual.bridge.start.mock.calls[0][0].params).toMatchObject({ action: 'relayRuntime.restart' });
    expect(settled).toBe(false);
    const result = { protocolVersion: 1 as const, taskId, ok: true as const, data: { action: 'relayRuntime.restart' } };
    manual.emitResult(taskId, result);
    await waitForHomeGovernance(() => expect(manual.bridge.start).toHaveBeenCalledTimes(2));
    const statusTaskId = manual.runner.listActiveTasks!().find(task => task.taskId !== taskId)!.taskId;
    expect(manual.bridge.start.mock.calls[1][0].params).toMatchObject({ action: 'relayRuntime.status' });
    expect(settled).toBe(false);
    const runtimeStatusResult = healthy === 'observation_failed'
        ? { protocolVersion: 1 as const, taskId: statusTaskId, ok: false as const, error: { code: 'status_failed', message: 'Cannot observe runtime' } }
        : { protocolVersion: 1 as const, taskId: statusTaskId, ok: true as const,
        data: { action: 'relayRuntime.status', relayRuntime: { installed: true, version: '0.3', relayUrl: 'https://ssh-home.test', healthy,
            service: { active: true, enabled: true } } } };
    manual.emitResult(statusTaskId, runtimeStatusResult);
    await expect(restarting).resolves.toMatchObject({ kind: healthy === 'observation_failed' ? 'outcome_unknown' : healthy ? 'restarted' : 'failed', taskId, result, runtimeStatusResult });
});

it.each([
    { surface: 'banner', decision: 'reject' },
    { surface: 'runtime', decision: 'cancel' },
] as const)('the $surface releases a $decision approval without reporting failed restart or reloading', async ({ surface, decision }) => {
    const { serverId, scope, host, manual } = await prepareHome();
    const { HomeRestartNowBanner, HomeRuntimeSection } = await import('./HomeRuntimeSections');
    const { Modal } = await import('@/modal');
    let approval: Exclude<ActionApprovalRegistration, string> | undefined;
    const refresh = vi.fn();
    const onRestarted = vi.fn();
    const context = { scope, homeName: 'SSH Home', projection: homeGovernanceProjectionFixture(), mutationsAvailable: true,
        approvalPending: false, refresh, requestApproval: (registration: ActionApprovalRegistration) => {
            if (typeof registration === 'string') throw new Error('Restart must retain its result continuation');
            approval = registration;
        } };
    const executor = { kind: 'remote_host' as const, host, hostName: host.name, scope, catalogRevision: 4 };
    const screen = await renderScreen(surface === 'banner'
        ? React.createElement(HomeRestartNowBanner, { context, executor, pendingCount: 1, onRestarted })
        : React.createElement(HomeRuntimeSection, { context, executor, release: { version: '0.3', flavor: 'light' }, onRestarted }));
    await screen.tree.pressByTestIdAsync(surface === 'banner' ? 'home-runtime-pending-restart.action' : 'home-runtime-restart');
    await waitForHomeGovernance(() => expect(approval).toBeDefined());
    expect(manual.runner.listActiveTasks!()).toHaveLength(0);
    const result = await decideApprovalAsInbox(serverId, approval!.artifactId, decision);
    expect(result.ok).toBe(true);
    const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const captured = await captureActionAccountContext(serverId);
    const artifact = await captured.fetchArtifact(approval!.artifactId);
    captured.dispose();
    const { act } = await import('react-test-renderer');
    await act(async () => approval!.onTerminal!(decision === 'reject' ? 'rejected' : 'canceled', artifact));
    expect(manual.runner.listActiveTasks!()).toHaveLength(0);
    expect(Modal.alertAsync).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(onRestarted).not.toHaveBeenCalled();
});
