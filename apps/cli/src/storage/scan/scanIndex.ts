import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { STORAGE_CHART_MAX_DRAWABLE_NODES, DiskNodeV1Schema, DiskScanStateV1Schema, type DiskNodeV1, type DiskScanStateV1, type DiskScanViewV1, type MachineStorageScanGetResultV1 } from '@happier-dev/protocol/storage/storageV1';
import { openProtectedSqliteDatabaseSync, type SqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import type { NativeDiskScanRecord, NativeDiskScanSummary } from '../measure/nativeDiskMeasure';
import { dropScanRelations, scanDataTables, scanIndexSchema } from './scanIndexSchema';

export type StorageScanVolume = Readonly<{ id: string; mountPath: string; usedBytes: number; deviceId?: string; reservedBytes?: number; apfsContainerId?: string }>;
export type ScanAdmission = Readonly<{ volumeId: string; root: string; target: DiskScanStateV1['target'];
    usedBytes: number; reservedBytes?: number; apfsContainerId?: string; fullDiskAccess: DiskScanStateV1['fullDiskAccess']; resume?: boolean; relistOnly?: boolean }>;
export type TrustedDiskNode = Readonly<{ volumeId: string; scanId: string; path: string; pathBytes?: Buffer; node: DiskNodeV1; complete: boolean; materialized: boolean; summarized: boolean; scannedAt: number }>;
const valueRow = z.object({ value: z.string() });
const nodeRow = z.object({ id: z.string(), parent: z.nullable(z.string()), data: z.string() });
const dirRow = z.object({ id: z.string(), complete: z.number(), scanned: z.number(), threshold: z.number(), unknown: z.number(), months3: z.number(), months6: z.number(), months12: z.number() });
const pathRow = z.object({ path: z.string() });
type AllocationFact = NonNullable<Extract<NativeDiskScanRecord, { type: 'dir' }>['allocationFacts']>[number];
const dataTables = scanDataTables;
const schema = (namespace = '') => `
CREATE TABLE IF NOT EXISTS ${namespace}meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ${namespace}dirs(id TEXT PRIMARY KEY,complete INTEGER NOT NULL,scanned INTEGER NOT NULL,threshold INTEGER NOT NULL,unknown INTEGER NOT NULL,months3 INTEGER NOT NULL,months6 INTEGER NOT NULL,months12 INTEGER NOT NULL,enumerated INTEGER NOT NULL,ownLogical INTEGER,started INTEGER NOT NULL DEFAULT 0,materialized INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ${namespace}coverage(path TEXT PRIMARY KEY,scanned INTEGER NOT NULL,complete INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ${namespace}boundaries(path TEXT PRIMARY KEY,reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ${namespace}frontier(path TEXT PRIMARY KEY);`;
const StoredDiskScanStateV1Schema = createStoredReadSchema(DiskScanStateV1Schema);
const StoredDiskNodeV1Schema = createStoredReadSchema(DiskNodeV1Schema);
const activeTransactions = new WeakSet<SqliteDatabaseSync>();
// These fixed ingestion statements run for every streamed entry. Preparing a
// view write also compiles its normalization triggers; reuse that SQLite work
// for the connection rather than compiling it for millions of records.
const ingestStatements = new WeakMap<SqliteDatabaseSync, ReturnType<typeof prepareIngestStatements>>();
function prepareIngestStatements(db: SqliteDatabaseSync) {
    let validatedState: string | undefined;
    return {
        metadata: db.prepare('SELECT value FROM meta WHERE key=?'),
        assertAdmittedState() {
            const value = metadata(db, 'state');
            if (!value) throw new Error('Scan not admitted');
            // Remember only validation of these exact bytes, never a mutable
            // state projection. A changed value is read and validated again,
            // including changes committed by another SQLite connection.
            if (value !== validatedState) {
                StoredDiskScanStateV1Schema.parse(JSON.parse(value) as unknown);
                validatedState = value;
            }
        },
        entry: db.prepare('INSERT INTO nodes(id,parent,name,kind,allocated,changed,items,visible,data) VALUES(?,?,?,?,?,?,?,?,?)'),
        // Presentation is unchanged when only these private ingestion flags change.
        // Avoid reconstructing and compacting the whole view payload for them.
        observed: db.prepare('UPDATE entries SET seen=1,retained=0 WHERE ref=(SELECT ref FROM paths WHERE path=?)'),
        fact: db.prepare('INSERT INTO observations(owner,path,key,allocated,sort,mtime,ageIncluded) VALUES(?,?,?,?,?,?,?)'),
        child: db.prepare('SELECT 1 FROM nodes WHERE parent=? LIMIT 1'),
        deleteFacts: db.prepare('DELETE FROM observations WHERE owner=?'),
        deleteDirectory: db.prepare('DELETE FROM dirs WHERE id=?'),
        deleteCoverage: db.prepare('DELETE FROM coverage WHERE path=?'),
    };
}
function ingestion(db: SqliteDatabaseSync) {
    let statements = ingestStatements.get(db);
    if (!statements) { statements = prepareIngestStatements(db); ingestStatements.set(db, statements); }
    return statements;
}
function transaction<T>(db: SqliteDatabaseSync, effect: () => T): T {
    if (activeTransactions.has(db)) return effect();
    db.exec('BEGIN IMMEDIATE'); activeTransactions.add(db);
    try { const result = effect(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { activeTransactions.delete(db); }
}
function metadata(db: SqliteDatabaseSync, key: string): string | undefined {
    const value = ingestion(db).metadata.get(key); return value ? valueRow.parse(value).value : undefined;
}
function saveMetadata(db: SqliteDatabaseSync, key: string, value: string) { db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, value); }
function readState(db: SqliteDatabaseSync): DiskScanStateV1 | null {
    const value = metadata(db, 'state'); return value ? StoredDiskScanStateV1Schema.parse(JSON.parse(value) as unknown) : null;
}
function migrateEnumeration(db: SqliteDatabaseSync, table = 'dirs', namespace = '') {
    const columns = db.prepare(`PRAGMA ${namespace}table_info(${table})`).all().map(value => z.object({ name: z.string() }).parse(value).name);
    if (columns.length && !columns.includes('enumerated')) db.exec(`ALTER TABLE ${namespace}${table} ADD COLUMN enumerated INTEGER NOT NULL DEFAULT 0; UPDATE ${namespace}${table} SET enumerated=complete`);
    if (columns.length && !columns.includes('ownLogical')) db.exec(`ALTER TABLE ${namespace}${table} ADD COLUMN ownLogical INTEGER`);
    if (columns.length && !columns.includes('started')) db.exec(`ALTER TABLE ${namespace}${table} ADD COLUMN started INTEGER NOT NULL DEFAULT 0`);
    const nodes = table.replace('dirs', 'nodes');
    const nodeColumns = db.prepare(`PRAGMA ${namespace}table_info(${nodes})`).all().map(value => z.object({ name: z.string() }).parse(value).name);
    if (nodeColumns.length && !nodeColumns.includes('seen')) db.exec(`ALTER TABLE ${namespace}${nodes} ADD COLUMN seen INTEGER NOT NULL DEFAULT 0`);
    if (nodeColumns.length && !nodeColumns.includes('retained')) db.exec(`ALTER TABLE ${namespace}${nodes} ADD COLUMN retained INTEGER NOT NULL DEFAULT 0`);
    if (columns.length && !columns.includes('materialized')) db.exec(`ALTER TABLE ${namespace}${table} ADD COLUMN materialized INTEGER NOT NULL DEFAULT 0;
        UPDATE ${namespace}${table} SET materialized=enumerated`);
    if (table === 'dirs' && !namespace) db.exec(`UPDATE nodes SET retained=1 WHERE id IN
        (SELECT value FROM json_each(COALESCE((SELECT value FROM meta WHERE key='relistRetained'),'[]')));
        DELETE FROM meta WHERE key IN ('relistRetained','relistIngested');`);
    const observations = table.replace('dirs', 'observations');
    const observationColumns = db.prepare(`PRAGMA ${namespace}table_info(${observations})`).all().map(value => z.object({ name: z.string() }).parse(value).name);
    if (observationColumns.length && !observationColumns.includes('mtime')) db.exec(`ALTER TABLE ${namespace}${observations} ADD COLUMN mtime INTEGER NOT NULL DEFAULT 0`);
    if (observationColumns.length && !observationColumns.includes('ageIncluded')) db.exec(`ALTER TABLE ${namespace}${observations} ADD COLUMN ageIncluded INTEGER NOT NULL DEFAULT 0`);
}
function normalizeRelations(db: SqliteDatabaseSync, namespace = '', prefix = '') {
    const legacy = db.prepare(`SELECT type FROM ${namespace}sqlite_master WHERE name=?`).get(`${prefix}nodes`);
    if (legacy && z.object({ type: z.string() }).parse(legacy).type === 'table') {
        migrateEnumeration(db, `${prefix}dirs`, namespace);
        transaction(db, () => {
            db.exec(`ALTER TABLE ${namespace}${prefix}nodes RENAME TO ${prefix}legacy_nodes;
                ALTER TABLE ${namespace}${prefix}observations RENAME TO ${prefix}legacy_observations;
                ALTER TABLE ${namespace}${prefix}files RENAME TO ${prefix}legacy_files;
                DROP INDEX IF EXISTS ${namespace}${prefix}files_size; DROP INDEX IF EXISTS ${namespace}${prefix}files_age;
                DROP INDEX IF EXISTS ${namespace}${prefix}observations_key;`);
            db.exec(scanIndexSchema(namespace, prefix));
            db.exec(`INSERT INTO ${namespace}${prefix}nodes SELECT id,parent,name,
                CASE WHEN kind='file' AND id NOT IN (SELECT id FROM ${namespace}${prefix}legacy_files) THEN 'other' ELSE kind END,
                allocated,changed,items,visible,data,seen,retained FROM ${namespace}${prefix}legacy_nodes;
                INSERT INTO ${namespace}${prefix}observations SELECT * FROM ${namespace}${prefix}legacy_observations;
                DROP TABLE ${namespace}${prefix}legacy_nodes; DROP TABLE ${namespace}${prefix}legacy_observations;
                DROP TABLE ${namespace}${prefix}legacy_files;`);
        });
        // Reconcile the local index in place, including SQLite's existing free
        // pages and auto-vacuum mode. No rescan or discarded history is needed.
        db.exec(`VACUUM ${namespace ? namespace.slice(0, -1) : 'main'}`);
    } else db.exec(scanIndexSchema(namespace, prefix));
    migrateEnumeration(db, `${prefix}dirs`, namespace);
}
function directoryEvidence(nodes: string, dirs: string, id: string, column: 'complete' | 'enumerated'): string {
    // A summarized boundary proves the walked subtree without duplicating a
    // completed-directory payload for every hidden ancestry edge. An explicit
    // newer directory observation always takes precedence, including failure.
    return `COALESCE((SELECT ${column} FROM ${dirs} d WHERE d.id=${id}),(
        WITH RECURSIVE ancestors(id,parent,depth) AS (SELECT id,parent,0 FROM ${nodes} WHERE id=${id}
            UNION ALL SELECT p.id,p.parent,a.depth+1 FROM ${nodes} p JOIN ancestors a ON p.id=a.parent)
        SELECT d.complete FROM ancestors a JOIN ${dirs} d ON d.id=a.id
            WHERE d.materialized=0 AND d.enumerated=1 ORDER BY a.depth LIMIT 1),0)=1`;
}
function prepareComparisons(db: SqliteDatabaseSync, prior: string, selection?: Readonly<{ sql: string; args: readonly unknown[] }>) {
    const priorDirs = prior === 'baseline_nodes' ? 'baseline_dirs' : 'previous.dirs';
    const currentOwn = `NOT EXISTS(WITH RECURSIVE ancestors(id,parent,retained) AS (SELECT id,parent,retained FROM nodes WHERE id=n.id UNION ALL SELECT p.id,p.parent,p.retained FROM nodes p JOIN ancestors c ON p.id=c.parent) SELECT 1 FROM ancestors WHERE retained=1) AND CASE WHEN n.kind='folder' THEN ${directoryEvidence('nodes', 'dirs', 'n.id', 'complete')} ELSE json_extract(n.data,'$.flags.atLeast')=0 END`;
    const previousOwn = `CASE WHEN p.kind='folder' THEN ${directoryEvidence(prior, priorDirs, 'p.id', 'complete')} ELSE json_extract(p.data,'$.flags.atLeast')=0 END`;
    db.exec(`DROP TABLE IF EXISTS comparison_rows;
CREATE TEMP TABLE comparison_rows(id TEXT PRIMARY KEY,parent TEXT,kind TEXT,data TEXT,delta INTEGER,valid INTEGER,change TEXT);`);
    db.prepare(`INSERT INTO comparison_rows SELECT n.id,n.parent,n.kind,n.data,n.allocated-COALESCE(p.allocated,0),
 CASE WHEN p.id IS NULL THEN (${currentOwn}) AND (${directoryEvidence(prior, priorDirs, 'n.parent', 'enumerated')})
 ELSE (${currentOwn}) AND (${previousOwn}) END,
 CASE WHEN p.id IS NULL THEN 'appeared' WHEN n.allocated>p.allocated THEN 'grew' WHEN n.allocated<p.allocated THEN 'shrank' ELSE 'unchanged' END
 FROM nodes n LEFT JOIN ${prior} p ON p.id=n.id WHERE n.kind IN ('folder','file','package')${selection ? ` AND n.id IN (${selection.sql})` : ''}`).run(...(selection?.args ?? []));
    if (!selection) db.exec(`INSERT INTO comparison_rows SELECT p.id,p.parent,p.kind,p.data,-p.allocated,
 (${previousOwn}) AND (${directoryEvidence('nodes', 'dirs', 'p.parent', 'enumerated')}),'disappeared'
 FROM ${prior} p LEFT JOIN nodes n ON n.id=p.id WHERE n.id IS NULL AND p.kind IN ('folder','file','package');`);
    db.exec('CREATE INDEX comparison_parent ON comparison_rows(parent)');
}
function nodeFromNative(node: Extract<NativeDiskScanRecord, { type: 'dir' }>['children'][number], parent?: string): DiskNodeV1 {
    return { nodeId: node.id, ...(parent ? { parentId: parent } : {}), name: node.name, ...(node.nameBytes ? { nameBytes: node.nameBytes } : {}),
        kind: node.kind === 'symlink' || node.kind === 'other' ? 'file' : node.kind,
        size: { allocatedBytes: node.allocatedBytes, freesBytes: 0, sharedBytes: 0,
            sharedExtentsUnmeasured: node.flags.sharedExtentsUnmeasured ?? false, atLeast: node.flags.atLeast },
        logicalBytes: node.logicalBytes, items: node.items, changedAt: Math.max(0, node.mtimeMs),
        flags: { happier: false, protection: 'none', atLeast: node.flags.atLeast, inUse: false }, childCount: 0 };
}
function upsert(db: SqliteDatabaseSync, node: DiskNodeV1, visible = 1, nativeKind: string = node.kind) {
    ingestion(db).entry.run(node.nodeId, node.parentId ?? null,
        node.name, nativeKind, node.size.allocatedBytes, node.changedAt, node.items, visible, JSON.stringify(node));
}
function saveObservations(db: SqliteDatabaseSync, owner: string, producer: Readonly<{ allocationFacts?: readonly AllocationFact[] }>) {
    const facts = producer.allocationFacts;
    if (!facts) return;
    db.prepare('DELETE FROM observations WHERE owner=?').run(owner);
    for (const fact of facts) saveObservation(db, owner, fact);
}
function saveObservation(db: SqliteDatabaseSync, owner: string, fact: AllocationFact) {
    ingestion(db).fact.run(owner, fact.pathId, fact.key, fact.allocatedBytes,
        fact.pathId.startsWith('bytes:') ? Buffer.from(fact.pathId.slice(6), 'base64') : Buffer.from(fact.pathId), fact.mtimeMs, Number(fact.ageIncluded));
}
function removeSelectedNodes(db: SqliteDatabaseSync) {
    db.exec(`DELETE FROM observations WHERE owner IN (SELECT id FROM replacing);
        DELETE FROM nodes WHERE id IN (SELECT id FROM replacing);
        DELETE FROM dirs WHERE id IN (SELECT id FROM replacing);
        DELETE FROM coverage WHERE path IN (SELECT id FROM replacing);
        DELETE FROM frontier WHERE path IN (SELECT id FROM replacing); DROP TABLE replacing;`);
}
function startDirectory(db: SqliteDatabaseSync, id: string) {
    db.prepare('DELETE FROM observations WHERE owner=?').run(id);
    db.prepare('UPDATE nodes SET visible=0,seen=0 WHERE parent=?').run(id);
    db.prepare("DELETE FROM nodes WHERE parent=? AND kind='small-items'").run(id);
}
function ingestEntry(db: SqliteDatabaseSync, record: Extract<NativeDiskScanRecord, { type: 'dir-entry' }>) {
    const { node, parent, retained, visible, replaceFacts } = record;
    const statements = ingestion(db);
    if (replaceFacts && !retained) {
        // The native initial entry precedes child dir-start. A replaced directory
        // cannot inherit an obsolete subtree; final corrections never enter here.
        if (statements.child.get(node.id)) {
            db.exec('CREATE TEMP TABLE replacing(id TEXT PRIMARY KEY)');
            db.prepare(`INSERT INTO replacing WITH RECURSIVE subtree(id) AS (
                SELECT id FROM nodes WHERE parent=? UNION SELECT n.id FROM nodes n JOIN subtree p ON n.parent=p.id)
                SELECT id FROM subtree`).run(node.id);
            removeSelectedNodes(db);
        }
        statements.deleteFacts.run(node.id);
        statements.deleteDirectory.run(node.id);
        statements.deleteCoverage.run(node.id);
    }
    if (retained) {
        // Cached subtree facts remain dated to their actual observation, not this relist.
        db.prepare('UPDATE nodes SET visible=?,seen=1,retained=1 WHERE id=?').run(Number(visible), node.id);
        return;
    }
    const projected = nodeFromNative(node, parent);
    upsert(db, projected, Number(visible), node.kind);
    statements.observed.run(node.id);
}
function pruneUnseenEntries(db: SqliteDatabaseSync, parent: string) {
    db.exec('CREATE TEMP TABLE replacing(id TEXT PRIMARY KEY)');
    db.prepare(`INSERT INTO replacing WITH RECURSIVE subtree(id) AS (
        SELECT id FROM nodes WHERE parent=? AND kind NOT IN ('small-items','hidden-space','reserved') AND seen=0
        UNION SELECT n.id FROM nodes n JOIN subtree p ON n.parent=p.id) SELECT id FROM subtree`).run(parent);
    removeSelectedNodes(db);
}
const runnableFrontier = "SELECT path FROM frontier WHERE path NOT IN (SELECT value FROM json_each(COALESCE((SELECT value FROM meta WHERE key='skippedPaths'),'[]')))";
function hasStagedFrontier(db: SqliteDatabaseSync): boolean {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='frontier_replacement'").get());
}
function ingestDirectory(db: SqliteDatabaseSync, record: Extract<NativeDiskScanRecord, { type: 'dir' | 'dir-start' }>, now: number) {
    const started = db.prepare('SELECT started FROM dirs WHERE id=?').get(record.id);
    const initial = record.type === 'dir-start' || (!record.streamed && (!started || !z.object({ started: z.number() }).parse(started).started));
    if (initial) startDirectory(db, record.id);
    if (!record.streamed) {
        // Legacy array records enter the same entry/fact owner. The real native
        // stream never materializes these arrays in the daemon.
        db.prepare('UPDATE nodes SET visible=0 WHERE parent=?').run(record.id);
        saveObservations(db, record.id, record);
        for (const child of record.children) {
            const retained = record.retainedSubtrees?.includes(child.id) ?? false;
            ingestEntry(db, { v: 1, type: 'dir-entry', parent: record.id, node: child, visible: true, retained, replaceFacts: initial && !retained });
            if (!retained) saveObservations(db, child.id, child);
        }
        for (const child of record.files) {
            const visible = db.prepare('SELECT visible FROM nodes WHERE id=?').get(child.id);
            ingestEntry(db, { v: 1, type: 'dir-entry', parent: record.id, node: child,
                visible: Boolean(visible && z.object({ visible: z.number() }).parse(visible).visible), retained: false,
                replaceFacts: initial && !record.children.some(value => value.id === child.id) });
            saveObservations(db, child.id, child);
        }
        for (const id of record.directChildIds ?? []) db.prepare('UPDATE nodes SET seen=1 WHERE id=? AND parent=?').run(id, record.id);
        for (const id of record.retainedSubtrees ?? []) db.prepare('UPDATE nodes SET retained=1 WHERE id=? AND parent=?').run(id, record.id);
    }
    if (record.enumerated ?? record.complete) pruneUnseenEntries(db, record.id);
    const existing = db.prepare('SELECT parent,visible FROM nodes WHERE id=?').get(record.id);
    const previous = existing ? z.object({ parent: z.nullable(z.string()), visible: z.number() }).parse(existing) : undefined;
    const selectedRootParent = record.id === metadata(db, 'root') ? metadata(db, 'rootParent') : undefined;
    const self = nodeFromNative({ ...record, kind: 'folder' }, record.parent ?? previous?.parent ?? (selectedRootParent || undefined));
    const count = db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE parent=? AND visible=1 AND kind NOT IN ('small-items','hidden-space','reserved')").get(record.id);
    self.childCount = z.object({ count: z.number() }).parse(count).count + Number(record.folded.items > 0);
    upsert(db, self, previous?.visible ?? 1);
    db.prepare("DELETE FROM nodes WHERE parent=? AND kind='small-items'").run(record.id);
    if (record.folded.items > 0) upsert(db, { ...self, nodeId: `small-items:${record.id}`, parentId: record.id,
        name: 'Small items', kind: 'small-items', childCount: 0, items: record.folded.items, logicalBytes: record.folded.logicalBytes,
        size: { ...self.size, allocatedBytes: record.folded.allocatedBytes } });
    // Subtree coverage and the opened chart level are separate facts. A folded
    // folder can have complete allocation facts before its direct level is opened.
    const summarized = 'summarized' in record && record.summarized === true;
    const materialized = (record.enumerated ?? record.complete) && !summarized
        ? record.id === metadata(db, 'root') ? 2 : 1 : 0;
    db.prepare('INSERT OR REPLACE INTO dirs(id,complete,scanned,threshold,unknown,months3,months6,months12,enumerated,ownLogical,started,materialized) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(record.id, Number(record.complete), now,
        Math.floor(record.allocatedBytes / STORAGE_CHART_MAX_DRAWABLE_NODES), record.ageGroupBytes.unknown,
        record.ageGroupBytes.months3, record.ageGroupBytes.months6, record.ageGroupBytes.months12,
        Number(record.enumerated ?? record.complete), record.ownLogicalBytes ?? null, 1, materialized);
    db.prepare('INSERT OR REPLACE INTO coverage VALUES(?,?,?)').run(record.id, now, Number(record.complete));
    db.prepare('DELETE FROM frontier WHERE path=?').run(record.id);
    if (!record.complete) {
        db.prepare(`INSERT OR IGNORE INTO frontier SELECT n.id FROM nodes n LEFT JOIN dirs d ON d.id=n.id
            WHERE n.parent=? AND n.kind='folder' AND (d.id IS NULL OR d.complete=0)`).run(record.id);
        if (!db.prepare("SELECT 1 FROM nodes WHERE parent=? AND kind='folder' LIMIT 1").get(record.id)) db.prepare('INSERT OR IGNORE INTO frontier VALUES(?)').run(record.id);
    }
}
function reaggregate(db: SqliteDatabaseSync, now: number) {
    if (!db.prepare('SELECT 1 FROM observations LIMIT 1').get()) return;
    const monthThreshold = (months: number) => { const date = new Date(now); date.setMonth(date.getMonth() - months); return date.getTime(); };
    transaction(db, () => {
        // The native owner supplies physical component equivalence and raw-byte path order.
        // SQLite merely assigns the same lexical winner and rolls it through persisted parents.
        db.exec(`CREATE TEMP TABLE component_charges(id TEXT PRIMARY KEY,allocated INTEGER NOT NULL,unknown INTEGER,months3 INTEGER,months6 INTEGER,months12 INTEGER);
INSERT INTO component_charges SELECT owner,SUM(allocated),
 SUM(CASE WHEN ageIncluded=1 AND mtime<=1000 THEN allocated ELSE 0 END),
 SUM(CASE WHEN ageIncluded=1 AND mtime>=${monthThreshold(6)} AND mtime<${monthThreshold(3)} THEN allocated ELSE 0 END),
 SUM(CASE WHEN ageIncluded=1 AND mtime>=${monthThreshold(12)} AND mtime<${monthThreshold(6)} THEN allocated ELSE 0 END),
 SUM(CASE WHEN ageIncluded=1 AND mtime>1000 AND mtime<${monthThreshold(12)} THEN allocated ELSE 0 END)
 FROM (SELECT owner,allocated,mtime,ageIncluded,ROW_NUMBER() OVER(PARTITION BY key ORDER BY sort,owner) AS winner FROM observations) WHERE winner=1 GROUP BY owner;
CREATE TEMP TABLE subtree_allocations(id TEXT PRIMARY KEY,allocated INTEGER NOT NULL,unknown INTEGER,months3 INTEGER,months6 INTEGER,months12 INTEGER);
INSERT INTO subtree_allocations WITH RECURSIVE rollup(id,allocated,unknown,months3,months6,months12) AS (
 SELECT * FROM component_charges UNION ALL SELECT n.parent,r.allocated,r.unknown,r.months3,r.months6,r.months12 FROM rollup r JOIN nodes n ON n.id=r.id WHERE n.parent IS NOT NULL)
 SELECT id,SUM(allocated),SUM(unknown),SUM(months3),SUM(months6),SUM(months12) FROM rollup GROUP BY id;
UPDATE nodes SET allocated=COALESCE((SELECT allocated FROM subtree_allocations a WHERE a.id=nodes.id),0)
 WHERE kind NOT IN ('small-items','hidden-space','reserved');
UPDATE nodes SET data=json_set(data,'$.size.allocatedBytes',allocated) WHERE kind NOT IN ('small-items','hidden-space','reserved');
UPDATE dirs SET unknown=COALESCE((SELECT unknown FROM subtree_allocations a WHERE a.id=dirs.id),0),
 months3=COALESCE((SELECT months3 FROM subtree_allocations a WHERE a.id=dirs.id),0),
 months6=COALESCE((SELECT months6 FROM subtree_allocations a WHERE a.id=dirs.id),0),
 months12=COALESCE((SELECT months12 FROM subtree_allocations a WHERE a.id=dirs.id),0);
CREATE TEMP TABLE subtree_metadata(id TEXT PRIMARY KEY,logical INTEGER,items INTEGER,known INTEGER);
INSERT INTO subtree_metadata WITH RECURSIVE own(id,logical,items) AS (
 SELECT n.id,CASE WHEN n.kind='folder' AND d.id IS NOT NULL THEN d.ownLogical ELSE json_extract(n.data,'$.logicalBytes') END,
 CASE WHEN n.kind='folder' THEN 1 ELSE n.items END FROM nodes n LEFT JOIN dirs d ON d.id=n.id WHERE n.kind NOT IN ('small-items','hidden-space','reserved')),
 rollup(id,logical,items,known) AS (SELECT id,COALESCE(logical,0),items,logical IS NOT NULL FROM own
 UNION ALL SELECT n.parent,r.logical,r.items,r.known FROM rollup r JOIN nodes n ON n.id=r.id WHERE n.parent IS NOT NULL)
 SELECT id,SUM(logical),SUM(items),MIN(known) FROM rollup GROUP BY id;
UPDATE nodes SET items=COALESCE((SELECT items FROM subtree_metadata a WHERE a.id=nodes.id),items),
 data=json_set(data,'$.items',COALESCE((SELECT items FROM subtree_metadata a WHERE a.id=nodes.id),items)) WHERE kind='folder';
UPDATE nodes SET data=json_set(data,'$.logicalBytes',(SELECT logical FROM subtree_metadata a WHERE a.id=nodes.id)) WHERE kind='folder' AND EXISTS(SELECT 1 FROM subtree_metadata a WHERE a.id=nodes.id AND a.known=1);
UPDATE nodes SET allocated=COALESCE((SELECT SUM(c.allocated) FROM nodes c WHERE c.parent=nodes.parent AND c.visible=0 AND c.kind NOT IN ('small-items','hidden-space','reserved')),0) WHERE kind='small-items';
UPDATE nodes SET data=json_set(data,'$.size.allocatedBytes',allocated) WHERE kind='small-items';
DROP TABLE component_charges; DROP TABLE subtree_allocations; DROP TABLE subtree_metadata;`);
    });
}
function propagateIncompleteCoverage(db: SqliteDatabaseSync) {
    transaction(db, () => {
        db.exec('CREATE TEMP TABLE incomplete_nodes(id TEXT PRIMARY KEY)');
        db.prepare(`INSERT INTO incomplete_nodes WITH RECURSIVE incomplete(id) AS (
            SELECT n.id FROM nodes n WHERE n.kind='folder' AND NOT (${directoryEvidence('nodes', 'dirs', 'n.id', 'complete')})
            UNION SELECT id FROM nodes WHERE kind NOT IN ('folder','small-items','hidden-space','reserved') AND json_extract(data,'$.flags.atLeast')=1
            UNION SELECT ? WHERE ?<>'' AND NOT EXISTS(SELECT 1 FROM dirs WHERE id=? AND complete=1)
            UNION SELECT n.parent FROM nodes n JOIN incomplete c ON c.id=n.id WHERE n.parent IS NOT NULL)
            SELECT id FROM incomplete`).run(metadata(db, 'rootParent') ?? '', metadata(db, 'rootParent') ?? '', metadata(db, 'root') ?? '');
        db.exec(`UPDATE dirs SET complete=0 WHERE id IN (SELECT id FROM incomplete_nodes);
            UPDATE coverage SET complete=0 WHERE path IN (SELECT id FROM incomplete_nodes);
            UPDATE nodes SET data=json_set(data,'$.flags.atLeast',json('true'),'$.size.atLeast',json('true')) WHERE kind='folder' AND id IN (SELECT id FROM incomplete_nodes);
            DROP TABLE incomplete_nodes;`);
    });
}
function reclaimScanSpace(db: SqliteDatabaseSync) {
    // Completed, interrupted and failed replacements all retire unused current
    // paths. A retained baseline has its own paths and remains untouched.
    db.exec(`DELETE FROM paths WHERE ref NOT IN (SELECT ref FROM entries UNION SELECT parent FROM entries WHERE parent IS NOT NULL UNION SELECT owner FROM allocation_observations UNION SELECT path FROM allocation_observations); PRAGMA incremental_vacuum;`);
}
export function createStorageScanIndex(deps: Readonly<{ activeServerDir: string; nowMs?: () => number; readTrashBytes?: () => number }>) {
    const now = deps.nowMs ?? Date.now;
    const directory = join(deps.activeServerDir, 'storage', 'scans');
    const databases = new Map<string, SqliteDatabaseSync>();
    let closed = false;
    const fileName = (id: string) => `${createHash('sha256').update(id).digest('hex')}.sqlite`;
    const file = (id: string) => join(directory, fileName(id));
    const previousFile = (id: string) => join(directory, fileName(id).replace('.sqlite', '.previous.sqlite'));
    const dbFor = (id: string) => {
        if (closed) throw Object.assign(new Error('Scan index closed'), { code: 'closed' });
        let db = databases.get(id); if (!db) { db = openProtectedSqliteDatabaseSync(file(id)); db.exec('PRAGMA auto_vacuum=INCREMENTAL'); db.exec(schema()); normalizeRelations(db);
            if (metadata(db, 'baselineState')) normalizeRelations(db, '', 'baseline_');
            db.prepare("DELETE FROM meta WHERE key='previousAttached'").run(); saveMetadata(db, 'volumeId', id); databases.set(id, db); } return db;
    };
    function selected(scanId?: string) {
        let latest: { volumeId: string; db: SqliteDatabaseSync; state: DiskScanStateV1 } | undefined;
        for (const [volumeId, db] of databases) { const state = readState(db); if (!state) continue;
            if (scanId === state.scanId) return { volumeId, db, state };
            if (!scanId && (!latest || state.startedAt > latest.state.startedAt)) latest = { volumeId, db, state }; }
        return latest;
    }
    function trusted(volumeId: string, db: SqliteDatabaseSync, raw: unknown): TrustedDiskNode {
        const row = nodeRow.parse(raw); const node = StoredDiskNodeV1Schema.parse(JSON.parse(row.data) as unknown);
        const directoryId = node.kind === 'folder' ? row.id : row.parent;
        const directoryFact = db.prepare('SELECT * FROM dirs WHERE id=?').get(directoryId) ?? db.prepare(`
            WITH RECURSIVE ancestors(id,parent,depth) AS (SELECT id,parent,0 FROM nodes WHERE id=?
                UNION ALL SELECT p.id,p.parent,a.depth+1 FROM nodes p JOIN ancestors a ON p.id=a.parent)
            SELECT d.* FROM ancestors a JOIN dirs d ON d.id=a.id WHERE d.materialized=0 AND d.enumerated=1 ORDER BY a.depth LIMIT 1`).get(directoryId);
        const fact = directoryFact ? dirRow.parse(directoryFact) : undefined;
        const rawLevel = node.kind === 'folder' ? db.prepare('SELECT d.materialized,d.enumerated,n.visible FROM dirs d JOIN nodes n ON n.id=d.id WHERE d.id=?').get(row.id) : undefined;
        const level = rawLevel ? z.object({ materialized: z.number(), enumerated: z.number(), visible: z.number() }).parse(rawLevel) : undefined;
        return { volumeId, scanId: readState(db)!.scanId, path: row.id, node, complete: Boolean(fact?.complete),
            materialized: Boolean(level && (level.materialized === 2 || level.materialized === 1 && level.visible === 1)),
            summarized: Boolean(level && level.materialized === 0 && level.enumerated === 1), scannedAt: fact?.scanned ?? 0,
            ...(row.id.startsWith('bytes:') ? { pathBytes: Buffer.from(row.id.slice(6), 'base64') } : {}) };
    }
    function comparison(db: SqliteDatabaseSync) {
        return metadata(db, 'baselineState') ? 'baseline_nodes' : metadata(db, 'hasPrevious') === 'true' ? 'previous.nodes' : undefined;
    }
    function attachPrevious(volumeId: string, db: SqliteDatabaseSync) {
        if (metadata(db, 'hasPrevious') === 'true' && metadata(db, 'previousAttached') !== 'true') {
            db.prepare('ATTACH DATABASE ? AS previous').run(previousFile(volumeId)); normalizeRelations(db, 'previous.'); saveMetadata(db, 'previousAttached', 'true');
        }
    }
    return {
        async initialize(volumes: readonly StorageScanVolume[], enabled: boolean, activeScanIds: ReadonlySet<string> = new Set(), isCurrent: () => boolean = () => true) {
            if (!isCurrent() || closed) return;
            await mkdir(directory, { recursive: true, mode: 0o700 });
            if (!isCurrent() || closed) return;
            const present = new Set(enabled ? volumes.map(value => value.id) : []);
            for (const [id, db] of databases) if (!present.has(id)) { db.close(); databases.delete(id); }
            const keep = new Set([...present].flatMap(id => [fileName(id), fileName(id).replace('.sqlite', '.previous.sqlite')]));
            const entries = await readdir(directory); if (!isCurrent() || closed) return;
            for (const name of entries) {
                if (!isCurrent() || closed) return;
                if (!/^[a-f0-9]{64}(?:\.previous)?\.sqlite(?:-wal|-shm|-journal)?$/.test(name)) continue;
                if (!keep.has(name.replace(/-(wal|shm|journal)$/, ''))) await rm(join(directory, name), { force: true });
            }
            if (enabled) for (const volume of volumes) {
                // Reading existing state must not manufacture an index for an unscanned volume.
                if (!isCurrent() || closed) return;
                if (!entries.includes(fileName(volume.id))) continue;
                const db = dbFor(volume.id);
                const state = readState(db); if (state?.status === 'running' && !activeScanIds.has(state.scanId)) { state.status = 'interrupted'; saveMetadata(db, 'state', JSON.stringify(state)); }
            }
        },
        begin(input: ScanAdmission): DiskScanStateV1 {
            const db = dbFor(input.volumeId); const prior = readState(db);
            db.exec('DROP TABLE IF EXISTS frontier_replacement');
            if (input.resume && prior && prior.status !== 'complete') {
                prior.status = 'running'; delete prior.finishedAt; saveMetadata(db, 'state', JSON.stringify(prior)); return prior;
            }
            return transaction(db, () => {
                const priorRoot = db.prepare('SELECT parent FROM nodes WHERE id=?').get(input.root);
                saveMetadata(db, 'rootParent', priorRoot ? z.object({ parent: z.nullable(z.string()) }).parse(priorRoot).parent ?? '' : '');
                if (metadata(db, 'completeState') && !metadata(db, 'baselineState')) {
                    for (const table of dataTables) {
                        db.exec(`DROP TABLE IF EXISTS baseline_${table}; CREATE TABLE baseline_${table} AS SELECT * FROM ${table}`);
                    }
                    db.exec(scanIndexSchema('', 'baseline_'));
                    saveMetadata(db, 'baselineState', metadata(db, 'completeState')!);
                }
                // Folder replacement removes only known descendants, preserving the containing volume index.
                if (!input.relistOnly) {
                    db.exec('CREATE TEMP TABLE replacing(id TEXT PRIMARY KEY)');
                    db.prepare(`INSERT INTO replacing WITH RECURSIVE subtree(id) AS (SELECT ? UNION SELECT n.id FROM nodes n JOIN subtree p ON n.parent=p.id) SELECT id FROM subtree`).run(input.root);
                    removeSelectedNodes(db);
                }
                db.exec("DELETE FROM frontier; DELETE FROM boundaries; DELETE FROM meta WHERE key IN ('relistIngested','relistRetained')");
                db.exec('UPDATE dirs SET started=0');
                db.prepare('INSERT INTO frontier VALUES(?)').run(input.root);
                saveMetadata(db, 'root', input.root); db.prepare("DELETE FROM meta WHERE key='drawableNodes'").run();
                saveMetadata(db, 'skippedPaths', '[]');
                saveMetadata(db, 'usedBytes', String(input.usedBytes)); saveMetadata(db, 'reservedBytes', String(input.reservedBytes ?? 0));
                saveMetadata(db, 'apfsContainerId', input.apfsContainerId ?? '');
                const priorCoverage = metadata(db, 'baselineState') && db.prepare('SELECT scanned,complete FROM baseline_coverage WHERE path=?').get(input.root);
                const priorAt = priorCoverage ? z.object({ scanned: z.number(), complete: z.number() }).parse(priorCoverage) : undefined;
                const state: DiskScanStateV1 = { scanId: randomUUID(), target: input.target, status: 'running', startedAt: now(),
                    ...(priorAt?.complete ? { previousScanAt: priorAt.scanned } : {}),
                    progress: { sizedBytes: 0, usedBytes: input.usedBytes, items: 0 }, unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
                    fullDiskAccess: input.fullDiskAccess };
                saveMetadata(db, 'state', JSON.stringify(state)); return state;
            });
        },
        withIngestBatch(volumeId: string, consume: () => void): void { transaction(dbFor(volumeId), consume); },
        ingest(volumeId: string, record: NativeDiskScanRecord) {
            const db = dbFor(volumeId); ingestion(db).assertAdmittedState();
            if (record.type === 'progress') { const state = readState(db)!; state.progress = { ...state.progress, sizedBytes: record.sizedBytes, items: record.items,
                ...(record.currentPath ? { currentPath: record.currentPath } : {}), ...(record.stuckSinceMs === undefined ? {} : { stuckSinceMs: record.stuckSinceMs }) };
                saveMetadata(db, 'state', JSON.stringify(state)); return; }
            if (record.type === 'summary') return;
            if (record.type === 'frontier-start') { db.exec('DROP TABLE IF EXISTS frontier_replacement; CREATE TEMP TABLE frontier_replacement(path TEXT PRIMARY KEY)'); return; }
            if (record.type === 'frontier-item') {
                if (!hasStagedFrontier(db)) throw Object.assign(new Error('Native frontier stream not started'), { code: 'invalid_native_disk_output' });
                db.prepare('INSERT OR IGNORE INTO frontier_replacement VALUES(?)').run(record.path); return;
            }
            if (record.type === 'fact') { saveObservation(db, record.owner, record.fact); return; }
            if (record.type === 'dir-entry') { transaction(db, () => ingestEntry(db, record)); return; }
            if (record.type !== 'dir' && record.type !== 'dir-start') { if ('fullDiskAccess' in record) { const state = readState(db)!; state.fullDiskAccess = record.fullDiskAccess; saveMetadata(db, 'state', JSON.stringify(state)); } return; }
            transaction(db, () => {
                ingestDirectory(db, record, now());
            });
        },
        finish(volumeId: string, summary: NativeDiskScanSummary | DiskScanStateV1['status']) {
            const db = dbFor(volumeId); const state = readState(db); if (!state) return;
            reaggregate(db, now());
            propagateIncompleteCoverage(db);
            state.status = typeof summary === 'string' ? summary : summary.termination === 'completed' ? 'complete' : summary.termination;
            state.finishedAt = now(); delete state.progress.currentPath; delete state.progress.stuckSinceMs;
            if (typeof summary !== 'string') {
                state.unreadable = { counts: summary.unreadableCounts, examples: summary.unreadable };
                if (summary.apfsLocalSnapshotCount !== undefined) state.apfsLocalSnapshotCount = summary.apfsLocalSnapshotCount;
                else delete state.apfsLocalSnapshotCount;
                const aggregate = db.prepare('SELECT allocated,items FROM nodes WHERE id=?').get(metadata(db, 'root'));
                const total = aggregate ? z.object({ allocated: z.number(), items: z.number() }).parse(aggregate) : undefined;
                state.progress.sizedBytes = total?.allocated ?? summary.allocatedBytes; state.progress.items = total?.items ?? summary.items;
                transaction(db, () => {
                    if (summary.streamedFrontier) {
                        if (!hasStagedFrontier(db)) throw Object.assign(new Error('Native frontier stream not started'), { code: 'invalid_native_disk_output' });
                        db.exec('DELETE FROM frontier; INSERT INTO frontier SELECT path FROM frontier_replacement');
                    } else if (summary.pendingFrontier) { db.exec('DELETE FROM frontier'); for (const path of summary.pendingFrontier) db.prepare('INSERT OR IGNORE INTO frontier VALUES(?)').run(path); }
                    for (const boundary of [...summary.unreadable, ...summary.skipped]) db.prepare('INSERT OR REPLACE INTO boundaries VALUES(?,?)').run(boundary.path, boundary.reason);
                    const skipped = z.array(z.string()).parse(JSON.parse(metadata(db, 'skippedPaths') ?? '[]') as unknown);
                    saveMetadata(db, 'skippedPaths', JSON.stringify([...new Set([...skipped, ...summary.skipped.map(value => value.path)])]));
                });
            }
            db.exec('DROP TABLE IF EXISTS frontier_replacement');
            saveMetadata(db, 'state', JSON.stringify(state));
            if (state.status !== 'complete') { reclaimScanSpace(db); return; }
            if ('volumeId' in state.target) saveMetadata(db, 'wholeDiskRoot', metadata(db, 'root')!);
            const wholeRoot = metadata(db, 'wholeDiskRoot');
            if (wholeRoot) {
                const rootNode = db.prepare('SELECT id,parent,data FROM nodes WHERE id=?').get(wholeRoot);
                if (rootNode) {
                    const node = StoredDiskNodeV1Schema.parse(JSON.parse(nodeRow.parse(rootNode).data) as unknown);
                    const reserved = Number(metadata(db, 'reservedBytes') ?? 0);
                    const hidden = metadata(db, 'apfsContainerId') ? 0 : Math.max(0, Number(metadata(db, 'usedBytes') ?? 0) - reserved - node.size.allocatedBytes);
                    for (const [kind, size, name] of [['hidden-space', hidden, 'Hidden space'], ['reserved', reserved, 'Reserved']] as const) {
                        const id = `${kind}:${wholeRoot}`; db.prepare('DELETE FROM nodes WHERE id=?').run(id);
                        if (size > 0) upsert(db, { ...node, nodeId: id, parentId: wholeRoot, kind, name, logicalBytes: 0, items: 0, childCount: 0,
                            flags: { ...node.flags, protection: 'forbidden', atLeast: kind === 'hidden-space' }, size: { ...node.size, allocatedBytes: size, atLeast: kind === 'hidden-space' } });
                    }
                }
            }
            if (metadata(db, 'baselineState')) {
                if (metadata(db, 'previousAttached') === 'true') db.exec('DETACH DATABASE previous');
                const previousDb = openProtectedSqliteDatabaseSync(previousFile(volumeId)); previousDb.exec('PRAGMA auto_vacuum=INCREMENTAL'); previousDb.close();
                db.prepare('ATTACH DATABASE ? AS previous').run(previousFile(volumeId)); db.exec(schema('previous.')); normalizeRelations(db, 'previous.');
                transaction(db, () => {
                    for (const table of dataTables) db.exec(`DELETE FROM previous.${table}; INSERT INTO previous.${table} SELECT * FROM baseline_${table}`);
                    dropScanRelations(db, 'baseline_');
                    db.prepare('INSERT OR REPLACE INTO previous.meta VALUES(?,?)').run('state', metadata(db, 'baselineState')!);
                    db.prepare("DELETE FROM meta WHERE key='baselineState'").run(); saveMetadata(db, 'hasPrevious', 'true');
                    saveMetadata(db, 'previousAttached', 'true');
                });
            }
            saveMetadata(db, 'completeState', JSON.stringify(state));
            reclaimScanSpace(db);
            if (metadata(db, 'previousAttached') === 'true') db.exec('PRAGMA previous.incremental_vacuum');
        },
        state(scanId?: string) { return selected(scanId)?.state ?? null; },
        states(): readonly DiskScanStateV1[] { return [...databases.values()].map(readState).filter((state): state is DiskScanStateV1 => state !== null); },
        volumeId(scanId: string): string | undefined { return selected(scanId)?.volumeId; },
        readView(input: Readonly<{ scanId?: string; view?: DiskScanViewV1 }> = {}): MachineStorageScanGetResultV1 {
            const selection = selected(input.scanId); if (!selection) return { state: null, nodes: [], coverage: [] };
            const { db, state, volumeId } = selection; attachPrevious(volumeId, db);
            const view = input.view ?? { tab: 'folders', depth: 1 }; const pageSize = view.pageSize ?? STORAGE_CHART_MAX_DRAWABLE_NODES;
            const offset = view.cursor ? z.number().check(z.int(), z.nonnegative()).parse(Number(Buffer.from(view.cursor, 'base64url').toString())) : 0;
            const root = view.nodeId ?? metadata(db, 'root')!; const args: unknown[] = [];
            const table = view.tab === 'large' || view.tab === 'old' ? 'files' : 'nodes';
            let where = view.tab === 'folders' ? `id IN (WITH RECURSIVE drawn(id,depth) AS (SELECT id,1 FROM nodes WHERE parent=? AND visible=1 UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN drawn d ON n.parent=d.id WHERE n.visible=1 AND d.depth<?) SELECT id FROM drawn)` : '1';
            if (view.tab === 'folders') args.push(root, view.depth);
            if (view.tab === 'large' || view.tab === 'old') {
                where += ' AND allocated>=? AND parent IN (WITH RECURSIVE scope(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN scope p ON n.parent=p.id WHERE n.kind=\'folder\') SELECT id FROM scope)';
                args.push(view.minBytes ?? 0, root);
            }
            if (view.tab === 'old') {
                const threshold = new Date(now()); if (view.olderThanDays !== undefined) threshold.setTime(threshold.getTime() - view.olderThanDays * 86_400_000);
                else threshold.setMonth(threshold.getMonth() - (view.olderThanMonths ?? 3));
                where += ' AND changed>1000 AND changed<?'; args.push(threshold.getTime());
            }
            const query = view.query;
            if (view.tab === 'find') {
                where += " AND kind NOT IN ('small-items','hidden-space','reserved')";
                where += ' AND id IN (WITH RECURSIVE scope(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN scope p ON n.parent=p.id WHERE n.visible=1) SELECT id FROM scope)'; args.push(root);
                if (query?.name) { where += ' AND instr(lower(name),lower(?))>0'; args.push(query.name); }
                if (query?.kind) { where += ' AND kind=?'; args.push(query.kind); }
                if (query?.minBytes !== undefined) { where += ' AND allocated>=?'; args.push(query.minBytes); }
                if (query?.maxBytes !== undefined) { where += ' AND allocated<=?'; args.push(query.maxBytes); }
                if (query?.modifiedWithinDays !== undefined) { where += ' AND changed>1000 AND changed>=?'; args.push(now() - query.modifiedWithinDays * 86_400_000); }
            }
            const priorTable = comparison(db);
            const since = priorTable ? `(SELECT delta FROM comparison_rows c WHERE c.id=${table}.id AND c.valid=1 AND c.change NOT IN ('appeared','disappeared'))` : 'NULL';
            const columns = { name: 'name COLLATE NOCASE', size: 'allocated', items: 'items', changed: 'changed', since };
            const sort = view.sort ?? { by: view.tab === 'folders' || view.tab === 'find' ? 'name' : 'size', direction: view.tab === 'folders' || view.tab === 'find' ? 'asc' : 'desc' };
            if (priorTable && (sort.by === 'since' || view.tab === 'insights')) prepareComparisons(db, priorTable,
                view.tab === 'insights' ? undefined : { sql: `SELECT id FROM ${table} WHERE ${where}`, args: [...args] });
            const rank = view.tab === 'find' && query?.name ? 'CASE WHEN instr(lower(name),lower(?))=1 THEN 0 ELSE 1 END,' : '';
            if (rank) args.push(query!.name);
            const raw = db.prepare(`SELECT id,parent,data FROM ${table} WHERE ${where} ORDER BY ${rank}${sort.by === 'since' ? `(${since} IS NULL) ASC,` : ''}${columns[sort.by]} ${sort.direction},id ASC LIMIT ? OFFSET ?`).all(...args, pageSize + 1, offset);
            const hasMore = raw.length > pageSize;
            // Ordinary pages compare only their returned rows. Change ordering
            // compares its candidate scope; Insights alone requests removed rows.
            if (priorTable && sort.by !== 'since' && view.tab !== 'insights') prepareComparisons(db, priorTable,
                { sql: 'SELECT value FROM json_each(?)', args: [JSON.stringify(raw.slice(0, pageSize).map(value => nodeRow.parse(value).id))] });
            const nodes = raw.slice(0, pageSize).map(value => {
                const row = nodeRow.parse(value); const node = StoredDiskNodeV1Schema.parse(JSON.parse(row.data) as unknown);
                if (priorTable) {
                    const delta = db.prepare("SELECT delta FROM comparison_rows WHERE id=? AND valid=1 AND change NOT IN ('appeared','disappeared')").get(row.id);
                    if (delta) node.deltaSincePrevious = z.object({ delta: z.number() }).parse(delta).delta;
                } return node;
            });
            const coverage: MachineStorageScanGetResultV1['coverage'] = [];
            for (const path of new Set([root, ...nodes.map(node => node.kind === 'folder' ? node.nodeId : node.parentId ?? root)])) {
                const value = db.prepare('SELECT path,scanned,complete FROM coverage WHERE path=?').get(path); if (!value) continue;
                const row = z.object({ path: z.string(), scanned: z.number(), complete: z.number() }).parse(value); coverage.push({ path: row.path, scannedAt: row.scanned, complete: Boolean(row.complete) });
            }
            const rootRow = db.prepare('SELECT id,parent,data FROM nodes WHERE id=?').get(root);
            const selectedRoot = rootRow ? StoredDiskNodeV1Schema.parse(JSON.parse(nodeRow.parse(rootRow).data) as unknown) : undefined;
            const result: MachineStorageScanGetResultV1 = { state, nodes, coverage, ...(selectedRoot ? { root: selectedRoot } : {}), indexedAt: state.finishedAt ?? state.startedAt,
                ...(state.previousScanAt === undefined ? {} : { previousScanAt: state.previousScanAt }), ...(hasMore ? { nextCursor: Buffer.from(String(offset + pageSize)).toString('base64url') } : {}) };
            if (view.tab === 'find') {
                const threshold = db.prepare('SELECT MAX(threshold) AS threshold FROM dirs').get();
                result.findCoverageMinBytes = threshold ? z.object({ threshold: z.nullable(z.number()) }).parse(threshold).threshold ?? 0 : 0;
            }
            if (view.tab === 'insights') {
                const distinct = db.prepare(`SELECT n.id,n.parent,n.data FROM nodes n WHERE n.kind='folder' AND n.id<>? AND n.id IN
                    (WITH RECURSIVE scope(id) AS (SELECT ? UNION ALL SELECT c.id FROM nodes c JOIN scope p ON c.parent=p.id) SELECT id FROM scope)
                    AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.kind='folder' AND p.id<>? AND p.id=n.parent AND p.allocated>=n.allocated) ORDER BY n.allocated DESC,n.id LIMIT ?`).all(root, root, root, pageSize)
                    .map(value => StoredDiskNodeV1Schema.parse(JSON.parse(nodeRow.parse(value).data) as unknown));
                const changes: NonNullable<MachineStorageScanGetResultV1['insights']>['changes'] = { grew: [], shrank: [], appeared: [], disappeared: [] };
                let notComparableFolders = 0; let growthBytes = 0; let reclaimedBytes = 0;
                if (priorTable) {
                    const scope = 'WITH RECURSIVE scope(id) AS (SELECT ? UNION ALL SELECT n.id FROM comparison_rows n JOIN scope p ON n.parent=p.id) SELECT id FROM scope';
                    for (const change of ['grew', 'shrank', 'appeared', 'disappeared'] as const) {
                        for (const value of db.prepare(`SELECT data,delta FROM comparison_rows WHERE change=? AND valid=1 AND id<>? AND id IN (${scope}) ORDER BY ABS(delta) DESC,id LIMIT ?`).iterate(change, root, root, pageSize)) {
                            const row = z.object({ data: z.string(), delta: z.number() }).parse(value);
                            changes[change].push({ ...StoredDiskNodeV1Schema.parse(JSON.parse(row.data) as unknown), deltaSincePrevious: row.delta });
                        }
                    }
                    notComparableFolders = z.object({ count: z.number() }).parse(db.prepare(`SELECT COUNT(*) AS count FROM comparison_rows WHERE kind='folder' AND valid=0 AND id<>? AND id IN (${scope})`).get(root, root)).count;
                    const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN delta>0 THEN delta ELSE 0 END),0) AS growth,
                        COALESCE(SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END),0) AS reclaimed
                        FROM comparison_rows d WHERE valid=1 AND id<>? AND id IN (${scope}) AND NOT EXISTS (
                            WITH RECURSIVE parents(id) AS (SELECT d.parent UNION ALL SELECT p.parent FROM comparison_rows p JOIN parents a ON p.id=a.id WHERE p.parent IS NOT NULL)
                            SELECT 1 FROM parents a JOIN comparison_rows p ON p.id=a.id WHERE p.valid=1 AND p.id<>?)`).get(root, root, root);
                    const amounts = z.object({ growth: z.number(), reclaimed: z.number() }).parse(totals); growthBytes = amounts.growth; reclaimedBytes = amounts.reclaimed;
                }
                const dir = db.prepare('SELECT * FROM dirs WHERE id=?').get(root); const ages = dir ? dirRow.parse(dir) : { unknown: 0, months3: 0, months6: 0, months12: 0 };
                result.insights = { largestDistinct: distinct, changes, growthBytes, reclaimedBytes, notComparableFolders,
                    ageGroupBytes: { unknown: ages.unknown, months3: ages.months3, months6: ages.months6, months12: ages.months12 }, trashBytes: deps.readTrashBytes?.() ?? 0 };
                result.nodes = [];
            }
            if (priorTable) db.exec('DROP TABLE comparison_rows');
            return result;
        },
        readNode(nodeId: string, scanId?: string): TrustedDiskNode | null {
            const candidates = scanId ? [...databases].filter(([, db]) => readState(db)?.scanId === scanId) : [...databases];
            for (const [volumeId, db] of candidates) {
                const row = db.prepare("SELECT id,parent,data FROM nodes WHERE id=? AND kind NOT IN ('small-items','hidden-space','reserved') UNION SELECT id,parent,data FROM files WHERE id=? LIMIT 1").get(nodeId, nodeId);
                if (row) return trusted(volumeId, db, row);
            } return null;
        },
        lookupPath(path: string): TrustedDiskNode | null {
            for (const [volumeId, db] of databases) { const row = db.prepare("SELECT id,parent,data FROM nodes WHERE id=? AND kind NOT IN ('small-items','hidden-space','reserved') UNION SELECT id,parent,data FROM files WHERE id=? LIMIT 1").get(path, path); if (row) return trusted(volumeId, db, row); } return null;
        },
        *iterateCompletedNodes(): Iterable<TrustedDiskNode> {
            for (const [volumeId, db] of databases) for (const value of db.prepare("SELECT n.id,n.parent,n.data FROM nodes n JOIN dirs d ON d.id=CASE WHEN n.kind='folder' THEN n.id ELSE n.parent END WHERE d.complete=1 AND n.kind NOT IN ('small-items','hidden-space','reserved') ORDER BY length(n.id) DESC,n.id").iterate()) yield trusted(volumeId, db, value);
        },
        hasWholeDiskCoverage(volumeId: string): boolean { const db = databases.get(volumeId); return Boolean(db && metadata(db, 'wholeDiskRoot')); },
        *iterateWholeDiskCandidates(): Iterable<TrustedDiskNode> {
            for (const [volumeId, db] of databases) {
                if (!metadata(db, 'wholeDiskRoot')) continue;
                for (const value of db.prepare("SELECT n.id,n.parent,n.data FROM nodes n JOIN dirs d ON d.id=CASE WHEN n.kind='folder' THEN n.id ELSE n.parent END WHERE d.complete=1 AND n.kind NOT IN ('small-items','hidden-space','reserved') ORDER BY length(n.id) DESC,n.id").iterate()) yield trusted(volumeId, db, value);
            }
        },
        frontier(volumeId: string): string[] { return dbFor(volumeId).prepare('SELECT path FROM frontier').all().map(value => pathRow.parse(value).path); },
        hasFrontierPath(volumeId: string, path: string): boolean { return Boolean(dbFor(volumeId).prepare('SELECT 1 FROM frontier WHERE path=?').get(path)); },
        hasRunnableFrontier(volumeId: string): boolean { return Boolean(dbFor(volumeId).prepare(`${runnableFrontier} LIMIT 1`).get()); },
        skippedPaths(volumeId: string): string[] { return z.array(z.string()).parse(JSON.parse(metadata(dbFor(volumeId), 'skippedPaths') ?? '[]') as unknown); },
        recordSkip(volumeId: string, path: string) { const db = dbFor(volumeId); const skipped = z.array(z.string()).parse(JSON.parse(metadata(db, 'skippedPaths') ?? '[]') as unknown);
            saveMetadata(db, 'skippedPaths', JSON.stringify([...new Set([...skipped, path])])); },
        root(volumeId: string) { return metadata(dbFor(volumeId), 'root') ?? ''; },
        async stats(volumeId: string): Promise<{ nodeRows: number; chartRows: number; entryRows: number; fileRows: number; directoryRows: number; observationRows: number; databaseBytes: number }> {
            const db = dbFor(volumeId); const count = (table: string) => z.object({ count: z.number() }).parse(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count;
            const chartRows = z.object({ count: z.number() }).parse(db.prepare("SELECT COUNT(*) AS count FROM entries WHERE kind<>'file' OR visible=1").get()).count;
            return { nodeRows: count('nodes'), chartRows, entryRows: count('entries'), fileRows: count('files'), directoryRows: count('dirs'), observationRows: count('observations'), databaseBytes: (await stat(file(volumeId))).size };
        },
        async writePriorProjection(volumeId: string, options: Readonly<{ resume?: boolean; relistOnly?: boolean }> = {}): Promise<{ path: string; dispose(): Promise<void> } | undefined> {
            const db = dbFor(volumeId); const table = options.resume || options.relistOnly ? 'nodes' : metadata(db, 'baselineState') ? 'baseline_nodes' : metadata(db, 'completeState') ? 'nodes' : undefined; if (!table) return undefined;
            const tempDirectory = createHappierTempDir({ purpose: 'storage-prior' });
            const path = join(tempDirectory, 'prior.ndjson'); let handle: Awaited<ReturnType<typeof open>> | undefined;
            const scope = (source: string) => `WITH RECURSIVE scope(id) AS (SELECT ? UNION ALL SELECT n.id FROM ${source} n JOIN scope p ON n.parent=p.id) SELECT id FROM scope`;
            const root = metadata(db, 'root')!;
            const priorDirectories = options.relistOnly ? `SELECT id,allocated FROM ${table} WHERE kind='folder' AND (id=? OR parent=?)` : `SELECT id,allocated FROM ${table} WHERE kind='folder' AND id IN (${scope(table)})`;
            try {
                handle = await open(path, 'wx', 0o600);
                for (const value of db.prepare(priorDirectories).iterate(...(options.relistOnly ? [root, root] : [root]))) {
                const row = z.object({ id: z.string(), allocated: z.number().check(z.int(), z.nonnegative(), z.int()) }).parse(value);
                await handle.write(`${JSON.stringify({ v: 1, type: 'prior-dir', id: row.id, allocatedBytes: row.allocated })}\n`);
            }
                if (options.relistOnly) for (const value of db.prepare(`SELECT n.id,n.data,d.unknown,d.months3,d.months6,d.months12,
                    (SELECT key FROM observations o WHERE o.owner=n.id AND o.path=n.id AND o.ageIncluded=0 ORDER BY key LIMIT 1) AS identityKey
                    FROM nodes n LEFT JOIN dirs d ON d.id=n.id WHERE n.parent=? AND n.kind IN ('folder','package')`).iterate(root)) {
                    const row = z.object({ id: z.string(), data: z.string(), unknown: z.nullable(z.number()), months3: z.nullable(z.number()), months6: z.nullable(z.number()), months12: z.nullable(z.number()), identityKey: z.nullable(z.string()) }).parse(value);
                    if (!row.identityKey) continue;
                    const node = StoredDiskNodeV1Schema.parse(JSON.parse(row.data) as unknown);
                    await handle.write(`${JSON.stringify({ v: 1, type: 'prior-child', id: row.id, identityKey: row.identityKey,
                        allocatedBytes: node.size.allocatedBytes, logicalBytes: node.logicalBytes, items: node.items,
                        flags: { atLeast: node.flags.atLeast, sharedExtentsUnmeasured: node.size.sharedExtentsUnmeasured },
                        ageGroupBytes: { unknown: row.unknown ?? 0, months3: row.months3 ?? 0, months6: row.months6 ?? 0, months12: row.months12 ?? 0 } })}\n`);
                }
                if (options.resume) for (const value of db.prepare(`SELECT path,key,MAX(allocated) AS allocated FROM observations WHERE owner IN (${scope('nodes')}) GROUP BY path,key`).iterate(root)) {
                    const row = z.object({ path: z.string(), key: z.string(), allocated: z.number().check(z.int(), z.nonnegative(), z.int()) }).parse(value);
                    await handle.write(`${JSON.stringify({ v: 1, type: 'prior-observation', id: row.path, key: row.key, allocatedBytes: row.allocated })}\n`);
                }
                if (options.resume) for (const value of db.prepare(runnableFrontier).iterate()) {
                    await handle.write(`${JSON.stringify({ v: 1, type: 'prior-frontier', id: pathRow.parse(value).path })}\n`);
                }
                await handle.close(); handle = undefined;
            } catch (error) {
                try { await handle?.close(); } finally { await removeHappierTempDirAsync(tempDirectory); }
                throw error;
            }
            return { path, dispose: async () => { await removeHappierTempDirAsync(tempDirectory); } };
        },
        close() { closed = true; for (const db of databases.values()) { ingestStatements.delete(db); db.close(); } databases.clear(); },
    };
}
export type StorageScanIndex = ReturnType<typeof createStorageScanIndex>;
