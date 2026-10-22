import { createHash } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { MachineStoragePolicyV1Schema, MachineStorageScanGetResultV1Schema, type MachineStorageScanGetInputV1 } from '@happier-dev/protocol/storage/storageV1';
import { openProtectedSqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { createStorageScanIndex } from './scan/scanIndex';
import { createStorageService, type StorageOperationActor } from './storageService';

// Observe the genuine OS boundary; classification and index queries stay real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, realpath: vi.fn(actual.realpath), readdir: vi.fn(actual.readdir), open: vi.fn(actual.open) };
});

const actor: StorageOperationActor = { accountId: 'owner', kind: 'person', custodianAccountId: 'owner',
    assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };

async function retainedFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-read-')));
    const home = join(root, 'home'); const scanRoot = join(root, 'cache'); const system = join(root, 'system');
    await Promise.all([mkdir(home), mkdir(scanRoot), mkdir(system)]);
    const children = Array.from({ length: 22 }, (_, index) => join(scanRoot, `folder-${index}`));
    await Promise.all(children.map(path => mkdir(path)));
    await mkdir(join(home, 'logs'));
    await Promise.all(Array.from({ length: 650 }, (_, index) => writeFile(join(home, 'logs', `${index}.log`), 'fixture')));
    const volume = { id: 'retained', mountPath: root, usedBytes: 0 };
    const index = createStorageScanIndex({ activeServerDir: home });
    await index.initialize([volume], true);
    const state = index.begin({ volumeId: volume.id, root: scanRoot, target: { folderPath: scanRoot }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
    index.ingest(volume.id, { v: 1, type: 'dir', id: scanRoot, name: 'cache', allocatedBytes: 0, logicalBytes: 0,
        items: 1, mtimeMs: 2000, flags: { atLeast: true }, children: [], files: [],
        folded: { items: 0, allocatedBytes: 0, logicalBytes: 0 },
        ageGroupBytes: { unknown: 0, months3: 0, months6: 0, months12: 0 }, complete: false });
    const db = openProtectedSqliteDatabaseSync(join(home, 'storage', 'scans', `${createHash('sha256').update(volume.id).digest('hex')}.sqlite`));
    // Reopened normalized index, as in the settlement fixture: 22 folders and
    // 31,108 retained file facts. No file contents or per-file JS objects needed.
    const files = 1414; const last = 1 + children.length * (files + 1); const firstFile = children.length + 2;
    const folderPrefix = join(scanRoot, 'folder-').replaceAll("'", "''");
    db.exec(`BEGIN;
        WITH RECURSIVE ids(i) AS (VALUES(2) UNION ALL SELECT i+1 FROM ids WHERE i<${last})
        INSERT INTO paths(ref,path) SELECT i,CASE WHEN i<${firstFile} THEN '${folderPrefix}'||(i-2)
            ELSE '${folderPrefix}'||((i-${firstFile})/${files})||'${sep}file-'||i END FROM ids;
        INSERT INTO entries SELECT ref,CASE WHEN ref<${firstFile} THEN 1 ELSE 2+(ref-${firstFile})/${files} END,
            CASE WHEN ref<${firstFile} THEN 'folder-'||(ref-2) ELSE 'file-'||ref END,
            CASE WHEN ref<${firstFile} THEN 'folder' ELSE 'file' END,
            CASE WHEN ref<${firstFile} THEN ${files * 81920} ELSE 81920 END,2000,
            CASE WHEN ref<${firstFile} THEN ${files + 1} ELSE 1 END,1,
            '{"logicalBytes":0,"size":{"freesBytes":0,"sharedBytes":0,"sharedExtentsUnmeasured":false,"atLeast":false},"flags":{"happier":false,"protection":"none","atLeast":false,"inUse":false},"childCount":0}',1,0
            FROM paths WHERE ref>1;
        INSERT INTO dirs SELECT path,1,100,0,0,0,0,${files * 81920},1,0,1,1 FROM paths WHERE ref BETWEEN 2 AND ${firstFile - 1};
        INSERT INTO coverage SELECT id,100,1 FROM dirs WHERE complete=1;
        INSERT INTO allocation_observations SELECT ref,ref,'physical:'||ref,81920,2000,1 FROM paths WHERE ref>=${firstFile};
        UPDATE entries SET allocated=${children.length * files * 81920},items=${last} WHERE ref=1;
        COMMIT;`);
    db.close(); index.finish(volume.id, 'cancelled'); index.close();
    let held = children[0];
    // Real process inventories repeat cwd/executable facts for descendants.
    const processPaths = Array.from({ length: 1800 }, (_, i) => join(root, 'work', `project-${i % 180}`));
    const service = createStorageService({ machineId: 'machine', homeDir: root,
        catalog: { happyHomeDir: home, activeServerDir: home, tempRoot: join(root, 'no-temp'),
            readProjects: () => ({ status: 'ready', projects: [] }),
            readInUsePaths: () => ({ reliable: true, paths: [...processPaths, held],
                sessions: processPaths.map((path, i) => ({ path, sessionId: `session-${i % 180}` })) }) },
        readPolicy: () => MachineStoragePolicyV1Schema.parse({ wholeDiskEnabled: true }),
        readStorageProtectionFacts: () => ({ systemPaths: [system] }),
        readVolumes: () => [{ id: volume.id, label: 'Volume', mount: root, totalBytes: 10_000_000_000, availableBytes: 5_000_000_000 }] });
    await service.initialize();
    return { root, home, system, children, scanId: state.scanId, service, setHeld: (path: string) => { held = path; },
        request: { machineId: 'machine', scanId: state.scanId, view: { tab: 'folders', depth: 1, sort: { by: 'size', direction: 'desc' } } } satisfies MachineStorageScanGetInputV1,
        dispose: async () => { service.dispose(); await rm(root, { recursive: true, force: true }); } };
}

it('shares one fresh physical protection rule set across a retained 31k-item page', async () => {
    const fixture = await retainedFixture();
    const resolution = vi.mocked(filesystem.realpath);
    try {
        const read = async () => {
            resolution.mockClear();
            const page = MachineStorageScanGetResultV1Schema.parse(await fixture.service.scanGet(fixture.request, { actor }));
            return { page, resolutions: resolution.mock.calls.filter(([path]) => String(path) === fixture.system).length };
        };
        const first = await read(); fixture.setHeld(fixture.children[1]); const second = await read();
        expect(first.page.nodes).toHaveLength(22);
        expect(first.page.root).toMatchObject({ size: { allocatedBytes: 22 * 1414 * 81920 }, items: 31131 });
        expect(first.page.nodes.find(node => node.nodeId === fixture.children[0])?.flags).toMatchObject({ protection: 'keep', inUse: true });
        expect(second.page.nodes.find(node => node.nodeId === fixture.children[0])?.flags).toMatchObject({ protection: 'none', inUse: false });
        expect(second.page.nodes.find(node => node.nodeId === fixture.children[1])?.flags).toMatchObject({ protection: 'keep', inUse: true });
        expect([first.resolutions, second.resolutions]).toEqual([1, 1]);
        const paged: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await fixture.service.scanGet({ ...fixture.request,
                view: { ...fixture.request.view, pageSize: 7, ...(cursor ? { cursor } : {}) } }, { actor });
            paged.push(...page.nodes.map(node => node.nodeId)); cursor = page.nextCursor;
        } while (cursor);
        expect(paged).toEqual(first.page.nodes.map(node => node.nodeId));
    } finally { await fixture.dispose(); }
}, 60_000);

it('settles a real scan Cancel while retained list and summary reads await filesystem work', async () => {
    const fixture = await retainedFixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>(done => { resolve = done; });
        return { promise, resolve };
    };
    const projectionEntered = deferred(); const projectionRelease = deferred();
    const listEntered = deferred(); const listRelease = deferred();
    const summaryEntered = deferred(); const summaryRelease = deferred();
    const summaryController = new AbortController();
    let listFinished = false; let summaryFinished = false; let holdSummary = false;
    let list: Promise<unknown> | undefined; let summary: Promise<unknown> | undefined;
    const open = vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (String(path).endsWith('prior.ndjson')) { projectionEntered.resolve(); await projectionRelease.promise; }
        return handle;
    });
    const resolution = vi.mocked(filesystem.realpath).mockImplementation(async (path, options) => {
        const result = await actual.realpath(path, options);
        if (String(path) === fixture.system) { listEntered.resolve(); await listRelease.promise; }
        return result;
    });
    const directory = vi.mocked(filesystem.readdir).mockImplementation(async (path, options) => {
        const result = await actual.readdir(path, options);
        if (holdSummary && String(path) === join(fixture.home, 'logs')) { summaryEntered.resolve(); await summaryRelease.promise; }
        return result;
    });
    try {
        const running = await fixture.service.scanStart({ machineId: 'machine', target: { folderPath: join(fixture.root, 'cache') }, resume: true }, { actor });
        await projectionEntered.promise;
        list = fixture.service.scanGet(fixture.request, { actor }).finally(() => { listFinished = true; });
        await listEntered.promise;
        holdSummary = true;
        summary = fixture.service.summary({ signal: summaryController.signal }).catch(error => error).finally(() => { summaryFinished = true; });
        await summaryEntered.promise;
        const cancel = fixture.service.scanCancel({ machineId: 'machine', scanId: running.scanId }, { actor });
        projectionRelease.resolve();
        const stopped = await cancel;
        expect(stopped.status).toBe('cancelled');
        expect(stopped.progress).toMatchObject({ sizedBytes: 22 * 1414 * 81920, items: 31131 });
        expect(listFinished).toBe(false); expect(summaryFinished).toBe(false);
        summaryController.abort(); listRelease.resolve(); summaryRelease.resolve();
        expect(MachineStorageScanGetResultV1Schema.parse(await list).nodes).toHaveLength(22);
        expect(await summary).toMatchObject({ name: 'AbortError' });
    } finally {
        projectionRelease.resolve(); listRelease.resolve(); summaryRelease.resolve(); summaryController.abort();
        await Promise.allSettled([list, summary]);
        open.mockImplementation(actual.open); resolution.mockImplementation(actual.realpath); directory.mockImplementation(actual.readdir);
        await fixture.dispose();
    }
}, 60_000);
