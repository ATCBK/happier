import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { openProtectedSqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { createStorageScanIndex } from './scanIndex';
import { seedRetainedScanIndex } from './scanIndex.retained.testkit';

it('projects completed nodes from one prepared snapshot while preserving trusted facts and child-first order', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'scan-completed-projection-'));
    const volumeId = 'projection'; const root = '/retained'; const index = createStorageScanIndex({ activeServerDir });
    await index.initialize([], true);
    await index.begin({ volumeId, root, target: { volumeId }, usedBytes: 0,
        fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } } });
    const db = openProtectedSqliteDatabaseSync(join(activeServerDir, 'storage', 'scans', `${createHash('sha256').update(volumeId).digest('hex')}.sqlite`));
    try {
        seedRetainedScanIndex(db, root, 399);
        // The bulk fixture uses flat path labels to keep its construction cheap.
        // Give this projection fixture real hierarchy before testing child order.
        db.exec(`CREATE TEMP TABLE projection_paths AS WITH RECURSIVE tree(ref,path) AS (
                SELECT ref,'${root}' FROM entries WHERE parent IS NULL
                UNION ALL SELECT e.ref,t.path||'/'||e.ref FROM entries e JOIN tree t ON e.parent=t.ref)
            SELECT * FROM tree;
            UPDATE dirs SET id=(SELECT path FROM projection_paths WHERE ref=CASE WHEN dirs.id='${root}' THEN 1 ELSE CAST(substr(dirs.id,${root.length + 2}) AS INTEGER) END);
            UPDATE coverage SET path=(SELECT path FROM projection_paths WHERE ref=CASE WHEN coverage.path='${root}' THEN 1 ELSE CAST(substr(coverage.path,${root.length + 2}) AS INTEGER) END);
            UPDATE paths SET path=(SELECT path FROM projection_paths WHERE projection_paths.ref=paths.ref);
            DROP TABLE projection_paths;`);
        index.finish(volumeId, 'complete');
        db.exec(`UPDATE dirs SET materialized=0,enumerated=1,scanned=24 WHERE id='${root}/2/24';
            UPDATE dirs SET materialized=2,scanned=25 WHERE id='${root}/2/25';
            UPDATE dirs SET materialized=1,scanned=26 WHERE id='${root}/2/26';
            UPDATE entries SET visible=0 WHERE ref IN (25,26);
            UPDATE dirs SET complete=0 WHERE id='${root}/2/27';
            UPDATE dirs SET materialized=0,enumerated=1,scanned=2 WHERE id='${root}/2';
            DELETE FROM dirs WHERE id='${root}/2/28';`);
        const rawPath = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([255])]);
        const byteId = `bytes:${rawPath.toString('base64')}`;
        const exemplar = index.readNode(`${root}/2/24/200`)!.node;
        const byteNode = { ...exemplar, nodeId: byteId, parentId: root, name: 'odd', nameBytes: '/w==' };
        db.prepare('INSERT INTO nodes(id,parent,name,kind,allocated,changed,items,visible,data) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(byteId, root, byteNode.name, byteNode.kind, byteNode.size.allocatedBytes, byteNode.changedAt, byteNode.items, 1, JSON.stringify(byteNode));
        const expected = [...index.iterateCompletedNodes()];
        // 399 seeded nodes + the raw-byte entry, minus each of the two
        // ineligible directories and its two files. Ordinary leaves must stay.
        expect(expected).toHaveLength(399 + 1 - 2 * (1 + 2));
        expect(expected.some(node => node.path === `${root}/2/24/200`)).toBe(true);
        expect(expected).toEqual(expected.map(node => index.readNode(node.path)));
        expect(index.readNode(`${root}/2/28`)).toMatchObject({ complete: true, materialized: false, summarized: false, scannedAt: 2 });
        expect(expected.some(node => node.path === `${root}/2/28`)).toBe(false);
        expect(expected.find(node => node.path === `${root}/2/24`)).toMatchObject({ complete: true, materialized: false, summarized: true, scannedAt: 24 });
        expect(expected.find(node => node.path === `${root}/2/25`)).toMatchObject({ complete: true, materialized: true, summarized: false, scannedAt: 25 });
        expect(expected.find(node => node.path === `${root}/2/26`)).toMatchObject({ complete: true, materialized: false, summarized: false, scannedAt: 26 });
        expect(expected.some(node => node.path === `${root}/2/27`)).toBe(false);
        expect(expected.find(node => node.path === byteId)?.pathBytes).toEqual(rawPath);
        const { DatabaseSync } = await import('node:sqlite'); const prepare = DatabaseSync.prototype.prepare;
        let prepares = 0; let stateReads = 0;
        const preparation = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql) {
            prepares++; const statement = prepare.call(this, sql);
            if (sql === 'SELECT value FROM meta WHERE key=?') {
                const get = statement.get;
                statement.get = function (...args: (SQLInputValue | Record<string, SQLInputValue>)[]) {
                    if (args[0] === 'state') stateReads++;
                    const result: ReturnType<typeof get> = Reflect.apply(get, statement, args); return result;
                };
            }
            return statement;
        });
        try {
            for (const wholeDisk of [false, true]) {
                prepares = 0; stateReads = 0;
                const actual = [...(wholeDisk ? index.iterateWholeDiskCandidates() : index.iterateCompletedNodes())];
                expect(actual).toEqual(expected);
                const positions = new Map(actual.map((node, position) => [node.path, position]));
                for (const [position, node] of actual.entries()) {
                    const parentPosition = positions.get(node.node.parentId ?? '');
                    if (parentPosition !== undefined) expect(position).toBeLessThan(parentPosition);
                }
                expect(stateReads).toBe(1);
                // Preparing an iterator and its fixed projection statements is
                // independent of how many retained facts it returns.
                expect(prepares).toBeLessThan(actual.length);
            }
        } finally { preparation.mockRestore(); }
    } finally { db.close(); index.close(); await rm(activeServerDir, { recursive: true, force: true }); }
});
