import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

import { useLocalRelayRuntimeControl, runRelayRuntimeUninstallTask } from './useLocalRelayRuntimeControl';
import { bindPersonalHomeRelocationTaskContinuation } from './personalHomeRelocationTaskContinuation';
import { buildRemoteSshManageHostSystemTaskSpec } from '@/components/systemTasks/specs/remoteSsh/buildRemoteSshManageHostSystemTaskSpec';
import { Modal } from '@/modal';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ScriptedSpec = { kind: string; params: Record<string, unknown> };
type ResolvePayload = { data?: unknown; message?: string };

function createScriptedRunnerHarness() {
    const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
    const startedSpecs: ScriptedSpec[] = [];
    const startedTaskIds: string[] = [];
    const subscribedTaskIds: string[] = [];
    const responses: { taskId: string; answer: unknown }[] = [];
    const startMock = vi.fn(async (spec: unknown) => {
        const parsed = spec as ScriptedSpec;
        startedSpecs.push(parsed);
        const taskId = `task_${startedTaskIds.length + 1}:${parsed.kind}`;
        startedTaskIds.push(taskId);
        return taskId;
    });
    const runner: SystemTaskRunner = createSystemTaskRunner({
        bridge: {
            start: startMock,
            async subscribe(taskId, listenerSet) {
                subscribedTaskIds.push(taskId);
                listeners.set(taskId, listenerSet);
                if (taskId.endsWith('relay.runtime.status.v1')) {
                    listenerSet.onResult({ protocolVersion: 1, taskId, ok: true, data: { installed: true, version: '1', relayUrl: 'http://127.0.0.1:43123', healthy: true, dataPresent: true, purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' }, anonymousSignupEnabled: false, service: { active: true, enabled: true } } });
                }
                return () => {
                    listeners.delete(taskId);
                };
            },
            async cancel() {},
            async respond(taskId, answer) { responses.push({ taskId, answer }); },
        },
    });
    function resolveResult(taskId: string, ok: boolean, payload: ResolvePayload = {}): void {
        listeners.get(taskId)?.onResult(ok
            ? { protocolVersion: 1, taskId, ok: true, ...(payload.data !== undefined ? { data: payload.data } : {}) }
            : {
                protocolVersion: 1,
                taskId,
                ok: false,
                error: { code: 'operation_failed', ...(payload.message ? { message: payload.message } : {}) },
            });
    }
    function emitEvent(taskId: string, payload: unknown): void {
        listeners.get(taskId)?.onEvent(payload);
    }
    async function start<R>(run: () => Promise<R>): Promise<{ promise: Promise<R>; taskId: string }> {
        let promise!: Promise<R>;
        let taskId = '';
        await act(async () => {
            promise = run();
            await new Promise((resolve) => setTimeout(resolve, 0));
            taskId = startedTaskIds[startedTaskIds.length - 1] ?? '';
        });
        return { promise, taskId };
    }
    async function settle<R>(started: { promise: Promise<R>; taskId: string }, ok: boolean, payload: ResolvePayload = {}): Promise<R> {
        let result!: R;
        await act(async () => {
            resolveResult(started.taskId, ok, payload);
            result = await started.promise;
        });
        return result;
    }
    return { runner, listeners, startedSpecs, startedTaskIds, subscribedTaskIds, responses, startMock, start, settle, emitEvent };
}

it('a native UI relocation answers SSH trust without displacing its descriptor publication continuation', async () => {
    const harness = createScriptedRunnerHarness();
    const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));
    const descriptor = { v: 1, operationId: 'native-ui-relocation' };
    const continuation = bindPersonalHomeRelocationTaskContinuation(async () => ({ descriptor }));
    const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const spec = buildRemoteSshManageHostSystemTaskSpec({ action: 'personalHome.relocate', channel: 'preview',
        sshTarget: 'dev@private.example', sshPort: '', sshAuth: 'agent', knownHostsMode: 'app', serviceMode: 'user',
        relayRuntime: { channel: 'preview', mode: 'user' },
        personalHomeRelocation: { operationId: 'native-ui-relocation', destinationMachineId: 'saved-host', sourceDescriptorRevision: 1 },
    });
    let taskId: string | null = null;
    await act(async () => { taskId = await getCurrent().startExternalOperation(spec, { promptContinuation: continuation }); });
    expect(taskId).not.toBeNull();
    const issuedTaskId = taskId!;
    try {
        await act(async () => {
            harness.emitEvent(issuedTaskId, { protocolVersion: 1, taskId: issuedTaskId, type: 'prompt', tsMs: 1,
                data: { kind: 'ssh.trustHost', host: 'private.example', fingerprint: 'SHA256:native-key' } });
        });
        expect(confirm).toHaveBeenCalled();
        expect(harness.responses).toContainEqual({ taskId: issuedTaskId, answer: { trusted: true } });
        await act(async () => {
            harness.emitEvent(issuedTaskId, { protocolVersion: 1, taskId: issuedTaskId, type: 'prompt', tsMs: 2,
                data: { kind: 'personal_home.publish_relocation_descriptor.v1' } });
        });
        expect(harness.responses).toContainEqual({ taskId: issuedTaskId, answer: { descriptor } });
    } finally {
        confirm.mockRestore();
        await standardCleanup();
    }
});

const BASE_PARAMS = {
    target: { kind: 'local' },
    channel: 'stable',
    mode: 'user',
    purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
};

const BACKUP_RESULT_DATA = {
    path: '/tmp/home-backup.tar',
    sha256: 'abc123',
    archiveBytes: 8192,
    manifest: {
        format: 'happier-personal-home-backup',
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        homeServerIdentityId: 'home-identity-1',
        entries: [
            { path: 'database/home.sqlite', size: 10, sha256: 'h1' },
            { path: 'secrets/handy-master-secret.txt', size: 5, sha256: 'h2' },
        ],
    },
};

const VERIFY_RESULT_DATA = {
    archiveBytes: 4096,
    manifest: {
        format: 'happier-personal-home-backup',
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        homeServerIdentityId: 'home-identity-1',
        entries: [],
    },
    identityMatchesCurrentHome: 'match',
};

describe('useLocalRelayRuntimeControl Personal Home operations', () => {
    beforeEach(() => {
        standardCleanup();
    });

    it('preserves the canonical retained-data fact in its relay status projection', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(getCurrent().status?.dataPresent).toBe(true);
    });

    it('preserves restore recovery inspection and routes explicit recovery through the restore kind', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));
        const inspect = await harness.start(() => getCurrent().refreshInspection());
        await harness.settle(inspect, true, { data: {
            running: false, identity: null, masterSecret: {}, layout: {},
            storage: { destinationEmpty: false, ownedErasePaths: [] },
            restoreRecovery: { status: 'rollback_available', affectedTargets: ['/data/home', '/data/home.rollback'] },
        } });
        expect(getCurrent().inspection?.restoreRecovery).toEqual({ status: 'rollback_available', affectedTargets: ['/data/home', '/data/home.rollback'] });
        const recovery = await harness.start(() => getCurrent().recoverPersonalHomeRestore());
        await harness.settle(recovery, true, { data: { outcome: 'rolled_back', restartedHome: true } });
        expect(harness.startedSpecs.find((spec) => spec.kind === 'relay.runtime.personal_home.restore.v1')?.params).toEqual({ ...BASE_PARAMS, action: 'recover' });
    });

    it('preserves an unknown restore destination inspection instead of treating it as non-empty', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));
        const inspect = await harness.start(() => getCurrent().refreshInspection());
        await harness.settle(inspect, true, { data: {
            running: false, identity: null, masterSecret: {}, layout: {},
            storage: { ownedErasePaths: [] },
            restoreRecovery: { status: 'none', affectedTargets: [] },
        } });

        expect(getCurrent().inspection?.destinationEmpty).toBeNull();
    });

    it('returns an explicit failed inspection outcome without replacing the last inspected facts', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));
        const initial = await harness.start(() => getCurrent().refreshInspection());
        const initialOutcome = await harness.settle(initial, true, { data: {
            running: false, identity: null, masterSecret: {}, layout: {},
            storage: { destinationEmpty: false, ownedErasePaths: [] },
            restoreRecovery: { status: 'none', affectedTargets: [] },
        } });
        expect(initialOutcome).toMatchObject({ status: 'inspected', inspection: { destinationEmpty: false } });

        const failed = await harness.start(() => getCurrent().refreshInspection());
        const failedOutcome = await harness.settle(failed, false, { message: 'Home inspection failed at the database boundary.' });

        expect(failedOutcome).toEqual({ status: 'failed', message: 'Home inspection failed at the database boundary.' });
        expect(getCurrent().inspection?.destinationEmpty).toBe(false);
        expect(getCurrent().lastErrorMessage).toBe('Home inspection failed at the database boundary.');
    });

    it('projects only canonical durable relocation recovery facts from inspection', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));
        const inspect = await harness.start(() => getCurrent().refreshInspection());
        await harness.settle(inspect, true, { data: {
            running: false, identity: null, masterSecret: {}, layout: {},
            storage: { destinationEmpty: false, ownedErasePaths: [] },
            restoreRecovery: { status: 'none', affectedTargets: [] },
            relocationRecovery: {
                status: 'recovery_available',
                operationId: 'relocation-1',
                destinationMachineId: 'managed-host-1',
                sourceDescriptorRevision: 7,
                primaryAction: 'finish_move',
                secondaryAction: 'return_to_source',
            },
        } });
        expect(getCurrent().inspection?.relocationRecovery).toEqual({
            operationId: 'relocation-1',
            destinationMachineId: 'managed-host-1',
            sourceDescriptorRevision: 7,
            primaryAction: 'finish_move',
            secondaryAction: 'return_to_source',
        });
    });

    it('keeps relocation recovery available when publication left no safe return action', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));
        const inspect = await harness.start(() => getCurrent().refreshInspection());
        await harness.settle(inspect, true, { data: {
            running: false, identity: null, masterSecret: {}, layout: {},
            storage: { destinationEmpty: false, ownedErasePaths: [] },
            restoreRecovery: { status: 'none', affectedTargets: [] },
            relocationRecovery: {
                status: 'recovery_available',
                operationId: 'relocation-1',
                destinationMachineId: 'managed-host-1',
                sourceDescriptorRevision: 7,
                primaryAction: 'finish_move',
            },
        } });
        expect(getCurrent().inspection?.relocationRecovery).toEqual({
            operationId: 'relocation-1',
            destinationMachineId: 'managed-host-1',
            sourceDescriptorRevision: 7,
            primaryAction: 'finish_move',
        });
    });

    it('preserves completed-restore cleanup diagnostics without exposing restore choices', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));
        const inspect = await harness.start(() => getCurrent().refreshInspection());
        await harness.settle(inspect, true, { data: {
            running: false, identity: null, masterSecret: {}, layout: {},
            storage: { destinationEmpty: false, ownedErasePaths: [] },
            restoreRecovery: { status: 'finalization_available', affectedTargets: ['/data/home', '/data/home.rollback'] },
        } });
        expect(getCurrent().inspection?.restoreRecovery).toEqual({ status: 'finalization_available', affectedTargets: ['/data/home', '/data/home.rollback'] });
        expect('finalizePersonalHomeRestore' in getCurrent()).toBe(false);

        await act(async () => {
            expect(await getCurrent().recoverPersonalHomeRestore()).toBeNull();
        });
        expect(harness.startedSpecs.every((spec) => spec.kind !== 'relay.runtime.personal_home.restore.v1')).toBe(true);
    });

    it('starts erase without a caller-owned confirmation fact and retains its terminal result', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        // Mount only auto-starts the status task.
        expect(harness.startedSpecs.map((spec) => spec.kind)).toEqual(['relay.runtime.status.v1']);

        const erase = await harness.start(() => getCurrent().erasePersonalHomeData());
        expect(erase.taskId).toContain('relay.runtime.personal_home.erase.v1');
        await harness.settle(erase, true, { data: { removedPaths: ['/data/a', '/data/b'], stoppedRunningHome: true } });

        const eraseSpec = harness.startedSpecs.find((spec) => spec.kind === 'relay.runtime.personal_home.erase.v1');
        expect(eraseSpec?.params).toEqual(BASE_PARAMS);
        expect(getCurrent().lastOperation).toEqual({
            operation: 'erase',
            erase: {
                outcome: 'completed',
                removedPaths: ['/data/a', '/data/b'],
                remainingOwnedPaths: [],
                remainingUnknownPaths: [],
                stoppedRunningHome: true,
                inspectionComplete: true,
                inspectionError: null,
                error: null,
            },
        });
        // The terminal snapshot is retained so completed steps stay visible.
        expect(getCurrent().operationSnapshot?.taskId).toBe(erase.taskId);
        expect(getCurrent().operationSnapshot?.result?.ok).toBe(true);
    });

    it('retains exact partial erase facts instead of presenting all-or-nothing success', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));
        const erase = await harness.start(() => getCurrent().erasePersonalHomeData());
        await harness.settle(erase, true, {
            data: {
                outcome: 'partial',
                removedPaths: ['/data/home.sqlite'],
                remainingOwnedPaths: ['/data/files'],
                remainingUnknownPaths: ['/data/operator-note'],
                stoppedRunningHome: true,
                inspectionComplete: true,
                inspectionError: null,
                error: 'The files directory could not be removed.',
            },
        });

        expect(getCurrent().lastOperation).toEqual({
            operation: 'erase',
            erase: {
                outcome: 'partial',
                removedPaths: ['/data/home.sqlite'],
                remainingOwnedPaths: ['/data/files'],
                remainingUnknownPaths: ['/data/operator-note'],
                stoppedRunningHome: true,
                inspectionComplete: true,
                inspectionError: null,
                error: 'The files directory could not be removed.',
            },
        });
    });

    it('retains irreversible erase success when only post-delete inspection needs attention', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));
        const erase = await harness.start(() => getCurrent().erasePersonalHomeData());
        await harness.settle(erase, true, {
            data: {
                outcome: 'completed_with_cleanup_attention',
                removedPaths: ['/data/home.sqlite', '/data/files'],
                remainingOwnedPaths: [],
                remainingUnknownPaths: [],
                stoppedRunningHome: true,
                inspectionComplete: false,
                inspectionError: 'Post-delete storage inspection failed.',
            },
        });

        expect(getCurrent().lastOperation).toEqual({
            operation: 'erase',
            erase: {
                outcome: 'completed_with_cleanup_attention',
                removedPaths: ['/data/home.sqlite', '/data/files'],
                remainingOwnedPaths: [],
                remainingUnknownPaths: [],
                stoppedRunningHome: true,
                inspectionComplete: false,
                inspectionError: 'Post-delete storage inspection failed.',
                error: null,
            },
        });
    });

    it('keeps the retained operation snapshot subscribed when a later action becomes active', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        const erase = await harness.start(() => getCurrent().erasePersonalHomeData());
        await act(async () => {
            await getCurrent().runTask('relay.runtime.restart.v1');
        });
        await act(async () => {
            harness.emitEvent(erase.taskId, {
                protocolVersion: 1,
                taskId: erase.taskId,
                tsMs: 1,
                type: 'prompt',
                stepId: 'personal_home.confirm_erase',
                message: 'Confirm erase',
                data: { kind: 'personal_home.confirm_erase.v1', paths: ['/locked/home.sqlite'], estimatedBytes: 42 },
            });
        });

        expect(getCurrent().operationSnapshot?.awaitingInput).toBe(true);
    });

    it('cannot start restore without a successful verify of the same archive plus explicit confirmation', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        const noVerification = {
            archivePath: '/other.tar',
            identityMatchesCurrentHome: 'match',
            homeServerIdentityId: 'home-identity-1',
            format: 'happier-personal-home-backup',
            version: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            archiveBytes: 4096,
        };
        // Same-attempt evidence must match the requested archive.
        await act(async () => {
            await getCurrent().restorePersonalHomeBackup({ archivePath: '/a.tar', overwriteConfirmed: true, verification: noVerification });
        });
        expect(harness.startedSpecs.every((spec) => spec.kind !== 'relay.runtime.personal_home.restore.v1')).toBe(true);

        const verify = await harness.start(() => getCurrent().verifyPersonalHomeBackup({ archivePath: '/a.tar' }));
        expect(verify.taskId).toContain('relay.runtime.personal_home.verify_backup.v1');
        const verification = await harness.settle(verify, true, { data: VERIFY_RESULT_DATA });
        expect(verification?.archivePath).toBe('/a.tar');
        expect(verification?.identityMatchesCurrentHome).toBe('match');
        expect(verification).toMatchObject({
            archiveBytes: 4096,
            createdAt: '2026-01-01T00:00:00.000Z',
            format: 'happier-personal-home-backup',
            version: 1,
        });

        const inspect = await harness.start(() => getCurrent().refreshInspection());
        await harness.settle(inspect, true, { data: {
            running: true, identity: null, masterSecret: {}, layout: {},
            storage: { destinationEmpty: false, ownedErasePaths: [] },
            restoreRecovery: { status: 'none', affectedTargets: [] },
        } });

        await act(async () => {
            // A different archive than the verified one is refused.
            await getCurrent().restorePersonalHomeBackup({ archivePath: '/b.tar', overwriteConfirmed: true, verification: verification! });
            // The verified archive without explicit overwrite confirmation is refused.
            await getCurrent().restorePersonalHomeBackup({ archivePath: '/a.tar', overwriteConfirmed: false, verification: verification! });
        });
        expect(harness.startedSpecs.every((spec) => spec.kind !== 'relay.runtime.personal_home.restore.v1')).toBe(true);

        const restore = await harness.start(() => getCurrent().restorePersonalHomeBackup({ archivePath: '/a.tar', overwriteConfirmed: true, verification: verification! }));
        expect(restore.taskId).toContain('relay.runtime.personal_home.restore.v1');
        await harness.settle(restore, true, {
            data: {
                outcome: 'rolled_back',
                rollbackPaths: ['/safe/home.sqlite.rollback'],
                error: 'health check failed',
                recoveryArchive: {
                    path: '/safe/backups/personal-home-pre-restore.tar',
                    sha256: 'recovery-sha256',
                    archiveBytes: 16384,
                    manifest: {
                        format: 'happier-personal-home-backup',
                        version: 1,
                        createdAt: '2026-01-02T00:00:00.000Z',
                        homeServerIdentityId: 'home-identity-1',
                        entries: [],
                    },
                },
            },
        });

        const restoreSpec = harness.startedSpecs.find((spec) => spec.kind === 'relay.runtime.personal_home.restore.v1');
        expect(restoreSpec?.params).toEqual({
            ...BASE_PARAMS,
            archivePath: '/a.tar',
            confirmOverwrite: true,
            expectedHomeServerIdentityId: 'home-identity-1',
        });
        expect(getCurrent().lastOperation).toEqual({
            operation: 'restore',
            restore: {
                outcome: 'rolled_back',
                error: 'health check failed',
                recoveryArchive: {
                    path: '/safe/backups/personal-home-pre-restore.tar',
                    bytes: 16384,
                    sha256: 'recovery-sha256',
                    homeServerIdentityId: 'home-identity-1',
                    createdAt: '2026-01-02T00:00:00.000Z',
                    homeNeedsAttention: false,
                    cleanupRequired: null,
                    verified: true,
                },
            },
        });
    });

    it('fails restore closed after a failed verification of the same archive', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        const verify = await harness.start(() => getCurrent().verifyPersonalHomeBackup({ archivePath: '/broken.tar' }));
        expect(await harness.settle(verify, false, { message: 'hash mismatch' })).toBeNull();

        expect(harness.startedSpecs.every((spec) => spec.kind !== 'relay.runtime.personal_home.restore.v1')).toBe(true);
    });

    it('starts the exact backup kind, consumes the verified result facts, and refreshes inspect/status', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        const backup = await harness.start(() => getCurrent().backupPersonalHome({ outputPath: ' /tmp/home-backup.tar ' }));
        expect(backup.taskId).toContain('relay.runtime.personal_home.backup.v1');
        await harness.settle(backup, true, { data: BACKUP_RESULT_DATA });

        const backupSpec = harness.startedSpecs.find((spec) => spec.kind === 'relay.runtime.personal_home.backup.v1');
        expect(backupSpec?.params).toEqual({
            ...BASE_PARAMS,
            outputPath: '/tmp/home-backup.tar',
        });
        expect(getCurrent().lastOperation).toEqual({
            operation: 'backup',
            backup: {
                path: '/tmp/home-backup.tar',
                bytes: 8192,
                sha256: 'abc123',
                homeServerIdentityId: 'home-identity-1',
                createdAt: '2026-01-01T00:00:00.000Z',
                homeNeedsAttention: false,
                cleanupRequired: null,
            },
        });

        const kindsAfter = harness.startedSpecs.map((spec) => spec.kind);
        expect(kindsAfter).toContain('relay.runtime.personal_home.inspect.v1');
        expect(kindsAfter.filter((kind) => kind === 'relay.runtime.status.v1').length).toBeGreaterThanOrEqual(2);
    });

    it('backs up to the canonical default destination when no path was chosen', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        const backup = await harness.start(() => getCurrent().backupPersonalHome());
        expect(backup.taskId).toContain('relay.runtime.personal_home.backup.v1');
        await harness.settle(backup, true, { data: BACKUP_RESULT_DATA });

        const backupSpec = harness.startedSpecs.find((spec) => spec.kind === 'relay.runtime.personal_home.backup.v1');
        expect(backupSpec?.params).toEqual(BASE_PARAMS);
        expect(backupSpec?.params.outputPath).toBeUndefined();
    });

    it('can defer the lease-held inspection refresh while a caller composes backup with another operation', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        const backup = await harness.start(() => getCurrent().backupPersonalHome({ refreshAfterSuccess: false }));
        await harness.settle(backup, true, { data: BACKUP_RESULT_DATA });

        expect(harness.startedSpecs.filter((spec) => spec.kind === 'relay.runtime.personal_home.inspect.v1')).toHaveLength(0);
    });

    it('parses inspection facts from the inspect task result', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        const inspect = await harness.start(() => getCurrent().refreshInspection());
        expect(inspect.taskId).toContain('relay.runtime.personal_home.inspect.v1');
        const facts = await harness.settle(inspect, true, {
            data: {
                purpose: 'personal-home',
                running: true,
                identity: { homeServerIdentityId: 'home-identity-1', schemaVersion: '7' },
                masterSecret: { present: true, fingerprint: 'fp' },
                layout: {
                    dataDir: '/home/.happier/self-host/data',
                    logsDir: '/home/.happier/self-host/logs',
                    backupsDir: '/home/.happier/self-host/data/backups',
                },
                storage: {
                    databasePresent: true,
                    databaseBytes: 2048,
                    publicFilesPresent: true,
                    privateFilesPresent: true,
                    backupsCount: 3,
                    backupsCountComplete: false,
                    destinationEmpty: false,
                    latestBackup: {
                        path: '/home/.happier/self-host/data/backups/personal-home-2026-02-02T03-04-05-006Z.tar',
                        createdAt: '2026-02-02T03:04:05.006Z',
                        archiveBytes: 4096,
                    },
                },
            },
        });

        expect(facts).toEqual({
            status: 'inspected',
            inspection: {
                homeServerIdentityId: 'home-identity-1',
            schemaVersion: '7',
            running: true,
            masterSecretPresent: true,
            databasePresent: true,
            databaseBytes: 2048,
            backupsCount: 3,
            backupsCountComplete: false,
            latestBackup: {
                path: '/home/.happier/self-host/data/backups/personal-home-2026-02-02T03-04-05-006Z.tar',
                createdAt: '2026-02-02T03:04:05.006Z',
                archiveBytes: 4096,
            },
            layoutPaths: {
                dataDir: '/home/.happier/self-host/data',
                configDir: '',
                logsDir: '/home/.happier/self-host/logs',
                backupsDir: '/home/.happier/self-host/data/backups',
            },
            ownedErasePaths: [],
            restoreRecovery: { status: 'none', affectedTargets: [] },
            relocationRecovery: null,
            estimatedOwnedBytes: null,
            estimatedOwnedBytesComplete: true,
            estimatedOwnedBytesReason: null,
                destinationEmpty: false,
            },
        });
        expect(facts.status).toBe('inspected');
        if (facts.status !== 'inspected') throw new Error('Expected a successful inspection result.');
        expect(getCurrent().inspection).toEqual(facts.inspection);
    });

    it('projects the verified backup result facts the Settings surface must disclose, including the manifest timestamp', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        const backup = await harness.start(() => getCurrent().backupPersonalHome());
        const result = await harness.settle(backup, true, { data: BACKUP_RESULT_DATA });

        expect(result).toEqual({
            path: '/tmp/home-backup.tar',
            bytes: 8192,
            sha256: 'abc123',
            homeServerIdentityId: 'home-identity-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            homeNeedsAttention: false,
            cleanupRequired: null,
        });
        expect(getCurrent().lastOperation).toEqual({ operation: 'backup', backup: result });
    });

    it('tracks the active operation kind so progress can be judged against its typed cancellation boundary', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        expect(getCurrent().activeOperationSpec).toBeNull();
        const backup = await harness.start(() => getCurrent().backupPersonalHome());
        expect(getCurrent().activeOperationSpec?.kind).toBe('relay.runtime.personal_home.backup.v1');
        await harness.settle(backup, true, { data: BACKUP_RESULT_DATA });
        // The retained terminal snapshot keeps its kind so the progress card stays truthful.
        expect(getCurrent().activeOperationSpec?.kind).toBe('relay.runtime.personal_home.backup.v1');
        await act(async () => {
            getCurrent().dismissOperationResult();
        });
        expect(getCurrent().activeOperationSpec).toBeNull();
    });

    it('runs the safe runtime uninstall through the canonical task bridge and surfaces typed failure', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        const uninstall = await harness.start(() => runRelayRuntimeUninstallTask(harness.runner));
        const uninstallSpec = harness.startedSpecs.find((spec) => spec.kind === 'relay.runtime.uninstall.v1');
        expect(uninstallSpec?.params).toMatchObject({ target: { kind: 'local' } });
        await expect(harness.settle(uninstall, true, { data: { uninstalled: true } })).resolves.toBe(true);

        const incomplete = await harness.start(() => runRelayRuntimeUninstallTask(harness.runner));
        await expect(harness.settle(incomplete, true, { data: { uninstalled: false } })).rejects.toThrow('did not confirm');

        const failing = await harness.start(() => runRelayRuntimeUninstallTask(harness.runner));
        await expect(harness.settle(failing, false, { message: 'service stop failed' })).rejects.toThrow('service stop failed');
    });

    it('keeps subscriptions task-id scoped and dismisses the retained operation snapshot on request', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        const backup = await harness.start(() => getCurrent().backupPersonalHome());
        await harness.settle(backup, true, { data: BACKUP_RESULT_DATA });

        // Every subscription belongs to a task this hook actually started.
        for (const taskId of harness.subscribedTaskIds) {
            expect(harness.startedTaskIds).toContain(taskId);
        }

        expect(getCurrent().operationSnapshot?.taskId).toBe(backup.taskId);
        await act(async () => {
            getCurrent().dismissOperationResult();
        });
        expect(getCurrent().operationSnapshot).toBeNull();
        expect(getCurrent().lastOperation).toBeNull();
    });

    it('surfaces operation failures through the error message while retaining the failed snapshot', async () => {
        const harness = createScriptedRunnerHarness();
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({ runner: harness.runner }));

        const backup = await harness.start(() => getCurrent().backupPersonalHome());
        expect(await harness.settle(backup, false, { message: 'sqlite_snapshot_unstable' })).toBeNull();

        expect(getCurrent().lastErrorMessage).toBe('sqlite_snapshot_unstable');
        expect(getCurrent().operationSnapshot?.taskId).toBe(backup.taskId);
        expect(getCurrent().operationSnapshot?.result?.ok).toBe(false);
        // A failed operation schedules no success refresh.
        expect(harness.startedSpecs.every((spec) => spec.kind !== 'relay.runtime.personal_home.inspect.v1')).toBe(true);
    });

    it('exposes cancel for task ids without owning a second runner', async () => {
        const harness = createScriptedRunnerHarness();
        const cancelMock = vi.fn(async () => {});
        const { getCurrent } = await renderHook(() => useLocalRelayRuntimeControl({
            runner: { ...harness.runner, cancel: cancelMock },
        }));

        await act(async () => {
            await getCurrent().cancelTask('task_manual:relay.runtime.stop.v1');
        });
        expect(cancelMock).toHaveBeenCalledWith('task_manual:relay.runtime.stop.v1');
    });

});
