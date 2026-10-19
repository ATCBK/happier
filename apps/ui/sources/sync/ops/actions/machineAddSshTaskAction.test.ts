import { afterEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { SavedSecretResourceMaterialV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
vi.mock('expo-router/build/link/href', () => ({ resolveHref: vi.fn() }));
vi.mock('@/config', () => ({ config: { variant: 'production', identityVariant: 'stable' } }));
// This native rendering package is outside the task process and never renders here.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
vi.mock('@/text', async () => ({ ...(await import('@/dev/testkit/mocks/text')).createTextModuleMock() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();

afterEach(() => { standardCleanup(); publishAppliedActiveServerRuntimeAvailability(false); vi.unstubAllGlobals(); });
describe('SSH machine Action task lifetime', () => {
    it.each([
        { source: 'new', retireBeforeCompletion: false },
        { source: 'saved', retireBeforeCompletion: false },
        { source: 'saved', retireBeforeCompletion: true },
    ] as const)('keeps the completed $source host bound to its captured Account (retired: $retireBeforeCompletion)', async ({ source, retireBeforeCompletion }) => {
        await harness.reset();
        const serverId = await harness.addHome({ name: 'SSH Completion', serverUrl: `https://ssh-completion-${source}.test`, accountId: 'alice' });
        const scope = { serverId, accountId: 'alice' };
        storage.setState({ settingsScope: scope, profileScope: scope, machineListByServerId: { [serverId]: [] } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        const features = createRootLayoutFeaturesResponse({ features: { remoteHosts: { management: { enabled: true }, secretMaterial: { enabled: true } } } });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        const ref = formatSharedSavedSecretRefV1('ssh-password-fixture');
        const password = 'private-ssh-password-fixture';
        const host = { id: 'saved-box', name: 'Saved box', createdAt: 1, updatedAt: 2, lastUsedAt: null,
            ssh: { target: 'dev@build-box', authMode: 'password' as const, passwordSecretRef: ref } };
        const resource = SavedSecretResourceMaterialV1Schema.parse({ resourceId: 'ssh-password-fixture', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: password } },
            entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'SSH password', kind: 'password', encryptionMode: 'plain',
                ownerAccountId: 'alice', revision: 3, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
        harness.answer(serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: [resource] } });
        harness.answer(serverId, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
        harness.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
        harness.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
        harness.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
            content: { t: 'plain', v: { v: 1, hosts: source === 'saved' ? [host] : [] } } } });
        harness.answer(serverId, 'POST /v1/account/entity-rows/remote-hosts', { body: { status: 'updated', revision: 5, cursor: 1 } });
        const manual = createManualSystemTaskRunner('native');
        vi.stubGlobal('isTauri', true);
        const executor = createDefaultActionExecutor({ homeRuntimeRunner: manual.runner });
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId };
        const started = await executor.execute('machines.add.ssh.start', source === 'saved'
            ? { serverId, savedHostId: host.id, expectedHostRevision: 4 }
            : { serverId, host: 'build-box', username: 'dev', authMode: 'password' }, context);
        const { discardMachineAddFlowDraft } = await import('@/components/machines/add/machineAddFlowStore');
        try {
            expect(started).toMatchObject({ ok: true, result: { taskId: expect.any(String) } });
            if (!started.ok || !started.result || typeof started.result !== 'object' || !('taskId' in started.result) || typeof started.result.taskId !== 'string') throw new Error('No task');
            const taskId = started.result.taskId;
            if (source === 'saved') expect(manual.runner.getTaskSpec?.(taskId)).toMatchObject({ params: { ssh: { target: 'dev@build-box', password } } });
            expect(JSON.stringify(started)).not.toContain(password);
            const lifetime = captureActiveServerAccountScopeLifetime();
            expect(lifetime?.isCurrent()).toBe(true);
            if (retireBeforeCompletion) {
                // The canonical disconnect/reconnect producer retires the old run even for the same Account.
                publishAppliedActiveServerRuntimeAvailability(false);
                publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
                expect(lifetime?.isCurrent()).toBe(false);
                expect(captureActiveServerAccountScopeLifetime()).not.toBe(lifetime);
            }
            manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: true, data: { machineId: 'joined-box' } });
            if (retireBeforeCompletion) {
                // The HTTP boundary resolves in-process; one event-loop turn drains completion continuations.
                await setImmediate();
                expect(manual.runner.getSnapshot(taskId)?.result).toMatchObject({ ok: true });
                expect(harness.requestsFor('/v1/account/entity-rows/remote-hosts').filter(request => request.input !== null)).toEqual([]);
                return;
            }
            await vi.waitFor(() => {
                expect(harness.requestsFor('/v1/account/entity-rows/remote-hosts').map(request => request.input)).toContainEqual(expect.objectContaining({
                    mutation: expect.objectContaining({ expectedRevision: 4, content: { t: 'plain', v: { v: 1,
                        hosts: [expect.objectContaining({ linkedMachineId: 'joined-box', ...(source === 'saved' ? { id: host.id } : {}) })] } } }),
                }));
            });
        } finally { discardMachineAddFlowDraft(); }
    });

    it('refuses native SSH agent authentication before replacing the retained draft or starting a task', async () => {
        await harness.reset();
        const serverId = await harness.addHome({ name: 'Native SSH', serverUrl: 'https://native-ssh-auth.test', accountId: 'alice' });
        storage.setState({ settingsScope: { serverId, accountId: 'alice' } });
        const { readMachineAddFlowDraft, discardMachineAddFlowDraft } = await import('@/components/machines/add/machineAddFlowStore');
        discardMachineAddFlowDraft();
        const before = readMachineAddFlowDraft();
        const manual = createManualSystemTaskRunner('native');
        vi.stubGlobal('isTauri', true);
        const executor = createDefaultActionExecutor({ homeRuntimeRunner: manual.runner });
        try {
            expect(await executor.execute('machines.add.ssh.start', { serverId, host: 'build-box' }, { surface: 'ui', authority: 'present_user', serverId }))
                .toMatchObject({ ok: false, errorCode: 'ssh_auth_mode_unavailable' });
            expect(readMachineAddFlowDraft()).toBe(before);
            expect(manual.bridge.start).not.toHaveBeenCalled();
        } finally { discardMachineAddFlowDraft(); }
    });

    it('shares its retained task with the UI, refuses secret author input and cancels the exact task', async () => {
        await harness.reset();
        const serverId = await harness.addHome({ name: 'SSH Home', serverUrl: 'https://ssh.example', serverIdentityId: 'srv_ssh-home', accountId: 'alice' });
        storage.setState({ settingsScope: { serverId, accountId: 'alice' }, machineListByServerId: { [serverId]: [] } });
        const manual = createManualSystemTaskRunner('native');
        vi.stubGlobal('isTauri', true);
        const executor = createDefaultActionExecutor({ homeRuntimeRunner: manual.runner });
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
