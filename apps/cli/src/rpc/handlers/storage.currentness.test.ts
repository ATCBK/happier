import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createStorageScanIndex } from '@/storage/scan/scanIndex';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MachineStoragePolicyV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { createDaemonStorageRoutes, registerDaemonStorageRpcHandlers } from './storage';

const filesystemBoundary = vi.hoisted<{ beforeRead?: (path: string) => Promise<void> }>(() => ({}));
// Hold only the OS file read. Pile serialization, identity checks and writes stay real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
        await filesystemBoundary.beforeRead?.(String(args[0]));
        return actual.lstat(...args);
    } };
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

// Only Home admission and file logging are substituted. The dispatcher, routes,
// lazy service, scan lifecycle, runner and persisted index are the real owners.
async function fixture() {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-currentness-')));
    const target = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
    const index = createStorageScanIndex({ activeServerDir: home });
    await index.initialize([{ id: 'volume', mountPath: home, usedBytes: 0 }], true);
    const state = index.begin({ volumeId: 'volume', root: home, target: { folderPath: home }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
    index.finish('volume', 'cancelled'); index.close();
    const authority = { valid: true, calls: 0 };
    const depsEntered = deferred(); const releaseDeps = deferred();
    let holdDeps = false;
    let failDeps = false;
    let constructions = 0;
    const routes = createDaemonStorageRoutes({ target: () => target, readOwnSessionIds: () => new Set(), deps: async () => {
        constructions += 1;
        depsEntered.resolve();
        if (holdDeps) await releaseDeps.promise;
        if (failDeps) throw new Error('Fixture storage initialization failed');
        return { catalog: { happyHomeDir: join(home, 'absent'), activeServerDir: home, tempRoot: join(home, 'tmp') },
            readVolumes: () => [{ id: 'volume', mount: home, label: 'Fixture', totalBytes: 1000, availableBytes: 900 }],
            readPolicy: () => MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: true }) };
    } });
    const manager = new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
        encryptionMode: 'plain', logger: () => {}, authorizeRequest: async () => {
            authority.calls += 1;
            return authority.valid ? { ok: true } : { ok: false, error: 'denied', errorCode: 'RPC_FORBIDDEN' };
        } });
    registerDaemonStorageRpcHandlers(manager, routes);
    const call = (method: string, params: Record<string, unknown> = {}) => manager.handleRequest({ method: `${target.machineId}:${method}`,
        params: { machineId: target.machineId, ...params }, callerAuthority: 'present_user',
        machineAdmission: { machineId: target.machineId, installationId: target.installationId,
            custodianAccountId: target.custodianAccountId, actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' } });
    const pilePath = join(home, 'storage', 'piles', `${createHash('sha256').update('owner').digest('hex')}.json`);
    return { state, routes, authority, call, pilePath, depsEntered, releaseDeps, holdDeps: () => { holdDeps = true; },
        failDeps: () => { failDeps = true; },
        constructions: () => constructions,
        async dispose() { releaseDeps.resolve(); routes.dispose(); await rm(home, { recursive: true, force: true }); } };
}

afterEach(() => { filesystemBoundary.beforeRead = undefined; vi.restoreAllMocks(); });
describe('storage RPC verification boundaries', () => {
    it('keeps the dispatcher denial ahead of lazy storage construction', async () => {
        const f = await fixture(); f.authority.valid = false;
        try {
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, { scanId: f.state.scanId })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(f.authority.calls).toBe(1);
            expect(f.constructions()).toBe(0);
        } finally { await f.dispose(); }
    });
    it('reaches cancellation with only dispatcher and pre-effect verification', async () => {
        const f = await fixture();
        let atEntry = 0;
        vi.spyOn(logger, 'infoFile').mockImplementation(message => {
            if (message === '[storage-scan] cancel-entry') atEntry = f.authority.calls;
        });
        try {
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, { scanId: f.state.scanId })).toMatchObject({ status: 'cancelled' });
            expect(atEntry).toBe(2);
            expect(f.authority.calls).toBe(3);
        } finally { await f.dispose(); }
    });
    it('denies cancellation revoked while lazy service dependencies are awaited', async () => {
        const f = await fixture(); f.holdDeps();
        const entries: string[] = [];
        vi.spyOn(logger, 'infoFile').mockImplementation(message => { entries.push(message); });
        try {
            const pending = f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, { scanId: f.state.scanId });
            await f.depsEntered.promise;
            f.authority.valid = false; f.releaseDeps.resolve();
            expect(await pending).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(entries).not.toContain('[storage-scan] cancel-entry');
        } finally { await f.dispose(); }
    });
    it('withholds the cancellation result when authority is revoked after runner entry', async () => {
        const f = await fixture(); let reachedRunner = false;
        vi.spyOn(logger, 'infoFile').mockImplementation(message => {
            if (message === '[storage-scan] cancel-entry') { reachedRunner = true; f.authority.valid = false; }
        });
        try {
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, { scanId: f.state.scanId })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(reachedRunner).toBe(true);
        } finally { await f.dispose(); }
    });
    it('verifies a passive scan read only at dispatch and disclosure', async () => {
        const f = await fixture();
        try {
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, { scanId: f.state.scanId })).toMatchObject({ state: { scanId: f.state.scanId } });
            expect(f.authority.calls).toBe(2);
        } finally { await f.dispose(); }
    });
    it('withholds a read revoked during lazy service initialization', async () => {
        const f = await fixture(); f.holdDeps();
        try {
            const pending = f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, { scanId: f.state.scanId });
            await f.depsEntered.promise;
            f.authority.valid = false; f.releaseDeps.resolve();
            expect(await pending).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(f.authority.calls).toBe(2);
        } finally { await f.dispose(); }
    });
    it('withholds initialization errors when authority was revoked during the failed await', async () => {
        const f = await fixture(); f.holdDeps(); f.failDeps();
        try {
            const pending = f.call(RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, { scanId: f.state.scanId });
            await f.depsEntered.promise;
            f.authority.valid = false; f.releaseDeps.resolve();
            expect(await pending).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
        } finally { await f.dispose(); }
    });
    it('verifies a pile read only before disclosure and a pile write once before persistence', async () => {
        const f = await fixture();
        try {
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_PILE_GET)).toMatchObject({ items: [] });
            expect(f.authority.calls).toBe(2);
            f.authority.calls = 0;
            expect(await f.call(RPC_METHODS.DAEMON_STORAGE_PILE_SET, { clear: true })).toMatchObject({ items: [] });
            expect(f.authority.calls).toBe(3);
        } finally { await f.dispose(); }
    });
    it('does not persist a pile change revoked during the store read', async () => {
        const f = await fixture(); const entered = deferred(); const release = deferred();
        filesystemBoundary.beforeRead = async path => { if (path === f.pilePath) { entered.resolve(); await release.promise; } };
        try {
            const pending = f.call(RPC_METHODS.DAEMON_STORAGE_PILE_SET, { clear: true });
            await entered.promise;
            f.authority.valid = false; release.resolve();
            expect(await pending).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            filesystemBoundary.beforeRead = undefined;
            await expect(readFile(f.pilePath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally { release.resolve(); await f.dispose(); }
    });
});
