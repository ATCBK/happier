// Native Windows replay bundles current source for node:test; no installed release is produced.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrashStore, resolveTrashOsUserId } from './trashStore.ts';
import { createActivityLog } from '../../daemon/guard/activityLog.ts';
import { createManagedSessionDirectories } from '../../session/creation/managedSessionDirectories.ts';
import { sessionFolders } from '../categories/sessionFolders.ts';
import { writeProtectedLocalStateFileAtomic } from '../../utils/fs/protectedLocalState.ts';
import { createStorageMaintenance } from '../maintenance/storageMaintenance.ts';
import { createLogRetentionOwner } from '../../utils/logs/logRetention.ts';
import { createBrowserRecordingDaemonService } from '../../daemon/browser/recording/service.ts';
import { createBrowserRecordingSessionMediaWriter } from '../../daemon/browser/recording/sessionMediaWriter.ts';
import { createTransferPathAllowanceRegistry } from '../../transfers/targets/createTransferPathAllowanceRegistry.ts';
import { MachineStoragePolicyV1Schema } from '@happier-dev/protocol/storage/storageV1';

test('native Trash: restart, restore, protected manifest, read-only empty, and actor receipt', async () => {
    assert.ok(process.env.HAPPIER_TEST_TRASH_PAYLOAD_DIR, 'native helper payload directory is required');
    const originalExecutable = Object.getOwnPropertyDescriptor(process, 'execPath');
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-trash-native-')));
    Object.defineProperty(process, 'execPath', { ...originalExecutable,
        value: join(process.env.HAPPIER_TEST_TRASH_PAYLOAD_DIR, process.platform === 'win32' ? 'happier.exe' : 'happier') });
    try {
        const home = join(scratch, 'home'); const source = join(scratch, 'cache');
        await mkdir(home); await mkdir(source); await mkdir(join(source, 'nested'));
        const bytes = Buffer.alloc(32768, 9); await writeFile(join(source, 'nested', 'bytes'), bytes);
        const activityLog = await createActivityLog({ activeServerDir: home, resourceSummary: { reportAutomaticAction() {} } });
        const deps = { happyHomeDir: home, osUserId: await resolveTrashOsUserId(),
            target: { machineId: 'native-machine', serverId: 'native-home' }, readVolumes: () => [{ id: 'fixture', mount: scratch }],
            activityLog, attributionFor: accountId => ({ serverId: 'native-home', machineId: 'native-machine', installationId: 'fixture', accountId }),
            classifyRestorePath: async () => null, readEmptyAfterDays: () => 7 };
        const input = { path: source, batchId: 'native-batch', title: 'Native fixture',
            size: { allocatedBytes: 0, freesBytes: 0, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false },
            movedBy: { accountId: 'alice', kind: 'person' } };
        const store = createTrashStore(deps); const prepared = await store.prepare(input); const moved = await prepared.commit();
        assert.ok(moved.size.allocatedBytes >= bytes.length);
        const restarted = createTrashStore(deps); assert.equal((await restarted.list()).length, 1);
        assert.equal((await restarted.restore({}, { actorAccountId: 'bob' })).outcomes[0].status, 'refused');
        assert.equal((await restarted.restore({}, { actorAccountId: 'alice' })).outcomes[0].status, 'restored');
        assert.deepEqual(await readFile(join(source, 'nested', 'bytes')), bytes);
        await chmod(join(source, 'nested', 'bytes'), 0o444); await chmod(join(source, 'nested'), 0o555);
        const second = await restarted.prepare(input); await second.commit();
        assert.equal((await restarted.empty({}, { actorAccountId: 'bob', custodianAccountId: 'owner' })).outcomes[0].status, 'refused');
        const emptied = await restarted.empty({}, { actorAccountId: 'owner', custodianAccountId: 'owner' });
        assert.equal(emptied.outcomes[0].status, 'deleted'); assert.ok(emptied.freedBytes > 0);
        await assert.rejects(lstat(second.payloadPath), { code: 'ENOENT' });
        const receipt = (await activityLog.list({ range: 'today' })).entries.find(row => row.kind === 'trash_emptied');
        assert.equal(receipt.attribution.accountId, 'owner'); assert.equal(receipt.freedBytes, emptied.freedBytes);
        assert.equal((await restarted.list()).length, 0);
        const owner = createManagedSessionDirectories({ activeServerDir: home });
        const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'native-crash' });
        await owner.bind({ allocationId: allocation.allocationId, sessionId: 'native-session' });
        await writeFile(join(allocation.directory, 'bytes'), bytes);
        const ownerData = { kind: 'allocation', allocationId: allocation.allocationId };
        const categoryDeps = { happyHomeDir: home, activeServerDir: home, managedSessionDirectories: owner };
        const managedDeps = { ...deps, resolveOwnerAdapter: (_category, data) => sessionFolders.adapterForEntry(data, categoryDeps) };
        const managed = createTrashStore(managedDeps);
        const retained = await managed.prepare({ ...input, path: allocation.directory, categoryId: 'sessionFolders', ownerData });
        const adapter = await sessionFolders.adapterForEntry(ownerData, categoryDeps);
        await retained.commit(adapter.retire);
        const manifestPath = join(retained.payloadPath, '..', 'entry.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.phase = 'restoring'; manifest.restorePath = allocation.directory;
        await writeProtectedLocalStateFileAtomic(manifestPath, JSON.stringify(manifest));
        await rename(retained.payloadPath, allocation.directory);
        await createTrashStore(managedDeps).reconcile();
        assert.equal((await owner.listRecords({ includeTrashed: true }))[0].inTrash, undefined);
        assert.equal((await owner.resolveForSession({ sessionId: 'native-session', path: allocation.directory })).ok, true);
        assert.deepEqual(await readFile(join(allocation.directory, 'bytes')), bytes);
        const emptyCrash = await managed.prepare({ ...input, path: allocation.directory, categoryId: 'sessionFolders', ownerData });
        await emptyCrash.commit(adapter.retire);
        const emptyManifestPath = join(emptyCrash.payloadPath, '..', 'entry.json');
        const emptyManifest = JSON.parse(await readFile(emptyManifestPath, 'utf8'));
        emptyManifest.phase = 'emptying';
        await writeProtectedLocalStateFileAtomic(emptyManifestPath, JSON.stringify(emptyManifest));
        await rm(emptyCrash.payloadPath, { recursive: true });
        await createTrashStore(managedDeps).reconcile();
        assert.deepEqual(await owner.listRecords({ includeTrashed: true }), []);
        const interrupted = await owner.materializeForFreshSpawn({ sessionCreationTag: 'native-retire-crash' });
        await owner.bind({ allocationId: interrupted.allocationId, sessionId: 'native-retire-session' });
        await writeFile(join(interrupted.directory, 'bytes'), bytes);
        const interruptedData = { kind: 'allocation', allocationId: interrupted.allocationId };
        const preparing = await managed.prepare({ ...input, path: interrupted.directory, categoryId: 'sessionFolders', ownerData: interruptedData });
        await rename(interrupted.directory, preparing.payloadPath);
        await createTrashStore(managedDeps).reconcile();
        assert.deepEqual((await owner.listRecords({ includeTrashed: true }))[0].inTrash, { payloadPath: preparing.payloadPath });
    } finally {
        Object.defineProperty(process, 'execPath', originalExecutable);
        await rm(scratch, { recursive: true, force: true });
    }
});

test('native maintenance: actual log age, existing Never policy change, busy scan edges and recording freed-byte receipt', async () => {
    const originalExecutable = Object.getOwnPropertyDescriptor(process, 'execPath');
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-maintenance-native-')));
    Object.defineProperty(process, 'execPath', { ...originalExecutable,
        value: join(process.env.HAPPIER_TEST_TRASH_PAYLOAD_DIR, process.platform === 'win32' ? 'happier.exe' : 'happier') });
    let maintenance;
    try {
        const day = 86_400_000; let clock = Date.now(); let idle = false; let power = false; let scans = 0;
        const home = join(scratch, 'home'); const logsDir = join(home, 'logs'); await mkdir(logsDir, { recursive: true });
        const current = join(logsDir, 'current.log'); const old = join(logsDir, 'old.log');
        for (const path of [current, old]) { await writeFile(path, Buffer.alloc(8192, 7)); await utimes(path, new Date(clock - 40 * day), new Date(clock - 40 * day)); }
        let policy = MachineStoragePolicyV1Schema.parse({ trashEmptyAfterDays: null });
        const listeners = new Set(); const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
        const changed = () => { for (const listener of listeners) listener(); };
        const errors = []; const automatic = [];
        const activityLog = await createActivityLog({ activeServerDir: home, nowMs: () => clock, resourceSummary: { reportAutomaticAction: value => automatic.push(value) } });
        const store = createTrashStore({ happyHomeDir: home, osUserId: await resolveTrashOsUserId(), target: { machineId: 'native-machine' },
            readVolumes: () => [{ id: 'fixture', mount: scratch }], activityLog,
            attributionFor: accountId => ({ serverId: 'native-home', machineId: 'native-machine', installationId: 'fixture', accountId }),
            classifyRestorePath: async () => null, readEmptyAfterDays: () => policy.trashEmptyAfterDays, nowMs: () => clock });
        const source = join(home, 'cache'); await mkdir(source); await writeFile(join(source, 'bytes'), Buffer.alloc(8192, 9));
        clock -= 8 * day;
        const entry = await (await store.prepare({ path: source, batchId: 'native-maintenance', title: 'Retained',
            size: { allocatedBytes: 0, freesBytes: 0, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false }, movedBy: { accountId: 'other-account', kind: 'person' } })).commit();
        clock += 8 * day;
        const captured = join(home, 'capture.webm');
        const video = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]), Buffer.alloc(8192, 7)]);
        const recordings = createBrowserRecordingDaemonService({ now: () => clock, captureAdapters: [{ captureKind: 'streamFrameCapture',
            start: async () => ({ status: 'started' }), stop: async () => ({ durationMs: 2_000, byteSize: video.length, frameCount: 24, fps: 12,
                mimeType: 'video/webm', source: { kind: 'local-file', path: captured, fileNameHint: 'capture.webm' } }), discard: async () => {} }],
            mediaWriter: createBrowserRecordingSessionMediaWriter({ workingDirectory: home, pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
                resolveSessionMediaTarget: recording => ({ sessionId: 'native-recording', messageLocalId: recording.recordingId }) }) });
        maintenance = createStorageMaintenance({ readPolicy: () => policy, subscribePolicy: subscribe, subscribeVolumes: subscribe,
            isIdle: async () => idle, subscribeIdle: subscribe, isOnPower: () => power, subscribePower: subscribe,
            getTrashStore: async () => store, logs: createLogRetentionOwner({ happyHomeDir: home, currentLogPaths: () => [current], onError: error => errors.push(error) }),
            recordings, runScheduledScan: async () => { scans++; }, activityLog, actorAccountId: 'custodian', onError: error => errors.push(error), nowMs: () => clock });
        await maintenance.start(); await assert.rejects(lstat(old), { code: 'ENOENT' }); assert.equal((await readFile(current)).length, 8192);
        assert.equal((await store.read(entry.entryId)).emptiesAt, null);
        policy = { ...policy, trashEmptyAfterDays: 1 }; changed(); await maintenance.requestPass(); assert.deepEqual(await store.list(), []);
        const due = new Date(clock + 60_000); due.setSeconds(0, 0);
        policy = { ...policy, wholeDiskEnabled: true, scheduledScan: { weekday: due.getDay(), time: `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`, onlyOnPower: true } };
        changed(); await maintenance.requestPass(); clock = due.getTime(); await maintenance.requestPass(); assert.equal(scans, 0);
        idle = true; power = true; changed(); await maintenance.requestPass(); assert.equal(scans, 1);
        await writeFile(captured, video);
        assert.equal((await recordings.startRecording({ browserRecordingEnabled: true, recordingId: 'native-recording', browserSessionId: 'browser', viewId: 'view', profileId: 'profile',
            targetKind: 'streamedBrowser', adapterKind: 'streamedBrowserSurface', renderEngineKind: 'streamedSurface', captureKind: 'streamFrameCapture', fidelity: 'streamFrame',
            navigationGeneration: 1, mimeType: 'video/webm', retentionClass: 'preSend',
            captureSource: { kind: 'machineLiveStream', streamFamily: 'browser.streamed', sourceId: 'stream', targetMachineId: 'native-machine' },
            recordingCapabilities: { enabled: true, attachmentsEnabled: true, available: true, supportedCaptureKinds: ['streamFrameCapture'], supportedMimeTypes: ['video/webm'],
                supportedAdapterKinds: ['streamedBrowserSurface'], maxDurationMs: 30_000, maxBytes: 16_000_000, maxFps: 12, audioSupported: false, cursorOverlaySupported: true,
                actionTimelineChaptersSupported: true, supportedRetentionClasses: ['preSend'], disabledReasons: [], policyDeniedReasons: [] } })).status, 'started');
        assert.equal((await recordings.stopRecording({ recordingId: 'native-recording', stoppedAtMs: clock + 2_000, navigationGenerationEnd: 2, expiresAtMs: clock + 60_000 })).status, 'finalized');
        const recordingPath = recordings.listStorageRecordings()[0].path; await unlink(captured);
        await maintenance.requestPass(); clock += 60_000; await maintenance.requestPass(); await assert.rejects(lstat(recordingPath), { code: 'ENOENT' });
        const lines = (await activityLog.list({ range: 'today' })).entries.filter(row => row.kind === 'housekeeping');
        assert.equal(lines.length, 3); assert.ok(lines.every(row => row.freedBytes > 0));
        assert.equal(lines.find(row => row.subject.recordings === 1).subject.recordings, 1);
        assert.deepEqual(errors, []); assert.deepEqual(automatic, []);
    } finally { maintenance?.stop(); Object.defineProperty(process, 'execPath', originalExecutable); await rm(scratch, { recursive: true, force: true }); }
});
