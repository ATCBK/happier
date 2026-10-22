import { z } from 'zod/mini';
import type { SqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';

/** Connection-local invalidations, committed/rolled back with the facts they describe. */
export function installScanAggregation(db: SqliteDatabaseSync): void {
    db.exec(`CREATE TEMP TABLE dirty_scan_nodes(ref INTEGER PRIMARY KEY);
        CREATE TEMP TRIGGER scan_entry_insert AFTER INSERT ON main.entries BEGIN
            INSERT INTO dirty_scan_nodes SELECT NEW.ref WHERE NOT EXISTS(SELECT 1 FROM dirty_scan_nodes WHERE ref=NEW.ref);
        END;
        CREATE TEMP TRIGGER scan_entry_update AFTER UPDATE OF parent,allocated,items,data ON main.entries BEGIN
            INSERT INTO dirty_scan_nodes SELECT NEW.ref WHERE NOT EXISTS(SELECT 1 FROM dirty_scan_nodes WHERE ref=NEW.ref);
            INSERT INTO dirty_scan_nodes SELECT OLD.parent WHERE OLD.parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dirty_scan_nodes WHERE ref=OLD.parent);
        END;
        CREATE TEMP TRIGGER scan_entry_delete BEFORE DELETE ON main.entries BEGIN
            INSERT INTO dirty_scan_nodes SELECT OLD.parent WHERE OLD.parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dirty_scan_nodes WHERE ref=OLD.parent);
        END;
        CREATE TEMP TRIGGER scan_fact_insert AFTER INSERT ON main.allocation_observations BEGIN
            INSERT INTO dirty_scan_nodes SELECT DISTINCT owner FROM allocation_observations o WHERE key=NEW.key AND NOT EXISTS(SELECT 1 FROM dirty_scan_nodes WHERE ref=o.owner);
        END;
        CREATE TEMP TRIGGER scan_fact_delete AFTER DELETE ON main.allocation_observations BEGIN
            INSERT INTO dirty_scan_nodes SELECT OLD.owner WHERE NOT EXISTS(SELECT 1 FROM dirty_scan_nodes WHERE ref=OLD.owner);
            INSERT INTO dirty_scan_nodes SELECT DISTINCT owner FROM allocation_observations o WHERE key=OLD.key AND NOT EXISTS(SELECT 1 FROM dirty_scan_nodes WHERE ref=o.owner);
        END;
        CREATE TEMP TRIGGER scan_fact_update AFTER UPDATE ON main.allocation_observations BEGIN
            INSERT INTO dirty_scan_nodes SELECT OLD.owner WHERE NOT EXISTS(SELECT 1 FROM dirty_scan_nodes WHERE ref=OLD.owner);
            INSERT INTO dirty_scan_nodes SELECT DISTINCT owner FROM allocation_observations o WHERE key IN (OLD.key,NEW.key) AND NOT EXISTS(SELECT 1 FROM dirty_scan_nodes WHERE ref=o.owner);
        END;`);
}

const refRow = z.object({ ref: z.number() });
const aggregateRow = z.object({ allocated: z.number(), items: z.number(), logical: z.nullable(z.number()),
    unknown: z.number(), months3: z.number(), months6: z.number(), months12: z.number() });

export function directoryEvidence(nodes: string, dirs: string, id: string, column: 'complete' | 'enumerated'): string {
    // A summarized boundary proves hidden descendants unless they have newer
    // explicit directory evidence of their own.
    return `COALESCE((SELECT ${column} FROM ${dirs} d WHERE d.id=${id}),(
        WITH RECURSIVE ancestors(id,parent,depth) AS (SELECT id,parent,0 FROM ${nodes} WHERE id=${id}
            UNION ALL SELECT p.id,p.parent,a.depth+1 FROM ${nodes} p JOIN ancestors a ON p.id=a.parent)
        SELECT d.complete FROM ancestors a JOIN ${dirs} d ON d.id=a.id
            WHERE d.materialized=0 AND d.enumerated=1 ORDER BY a.depth LIMIT 1),0)=1`;
}

/**
 * The retained entries are the aggregates, not a separate cache. Reconcile only
 * changed physical owners and their ancestors, bottom up, within each stdout
 * transaction. Unchanged completed subtrees contribute their committed totals.
 */
export function reaggregateScan(db: SqliteDatabaseSync, now: number): void {
    if (!db.prepare('SELECT 1 FROM dirty_scan_nodes LIMIT 1').get()) return;
    const hasFacts = Boolean(db.prepare('SELECT 1 FROM allocation_observations LIMIT 1').get());
    const threshold = (months: number) => { const date = new Date(now); date.setMonth(date.getMonth() - months); return date.getTime(); };
    db.exec(`CREATE TEMP TABLE scan_rollup(ref INTEGER PRIMARY KEY,depth INTEGER);
        INSERT INTO scan_rollup WITH RECURSIVE ancestors(ref,depth) AS (
            SELECT ref,0 FROM dirty_scan_nodes UNION ALL
            SELECT e.parent,a.depth+1 FROM ancestors a JOIN entries e ON e.ref=a.ref WHERE e.parent IS NOT NULL)
            SELECT ref,MAX(depth) FROM ancestors GROUP BY ref;
        CREATE TEMP TABLE scan_charge_owners(ref INTEGER PRIMARY KEY);
        INSERT INTO scan_charge_owners SELECT ref FROM scan_rollup;
        INSERT OR IGNORE INTO scan_charge_owners SELECT e.ref FROM entries e JOIN scan_rollup r ON r.ref=e.parent
            WHERE e.kind NOT IN ('folder','small-items','hidden-space','reserved');
        CREATE TEMP TABLE scan_charges(ref INTEGER PRIMARY KEY,allocated INTEGER,unknown INTEGER,months3 INTEGER,months6 INTEGER,months12 INTEGER);
        INSERT INTO scan_charges SELECT owner,SUM(allocated),
            SUM(CASE WHEN ageIncluded=1 AND mtime<=1000 THEN allocated ELSE 0 END),
            SUM(CASE WHEN ageIncluded=1 AND mtime>=${threshold(6)} AND mtime<${threshold(3)} THEN allocated ELSE 0 END),
            SUM(CASE WHEN ageIncluded=1 AND mtime>=${threshold(12)} AND mtime<${threshold(6)} THEN allocated ELSE 0 END),
            SUM(CASE WHEN ageIncluded=1 AND mtime>1000 AND mtime<${threshold(12)} THEN allocated ELSE 0 END)
        FROM (SELECT o.*,ROW_NUMBER() OVER(PARTITION BY o.key ORDER BY COALESCE(p.rawSort,CAST(p.path AS BLOB)),owner.path) AS winner
            FROM allocation_observations o JOIN paths p ON p.ref=o.path JOIN paths owner ON owner.ref=o.owner
            WHERE o.key IN (SELECT key FROM allocation_observations WHERE owner IN (SELECT ref FROM scan_charge_owners)))
        WHERE winner=1 GROUP BY owner;`);
    const aggregate = db.prepare(`SELECT
        COALESCE((SELECT allocated FROM scan_charges WHERE ref=e.ref),0)+
            CASE WHEN e.kind='folder' THEN COALESCE((SELECT SUM(allocated) FROM entries WHERE parent=e.ref AND kind NOT IN ('small-items','hidden-space','reserved')),0) ELSE 0 END AS allocated,
        CASE WHEN e.kind='folder' THEN 1+COALESCE((SELECT SUM(items) FROM entries WHERE parent=e.ref AND kind NOT IN ('small-items','hidden-space','reserved')),0) ELSE e.items END AS items,
        CASE WHEN e.kind='folder' AND d.ownLogical IS NOT NULL THEN d.ownLogical+
            COALESCE((SELECT SUM(json_extract(data,'$.logicalBytes')) FROM entries WHERE parent=e.ref AND kind NOT IN ('small-items','hidden-space','reserved')),0) ELSE NULL END AS logical,
        COALESCE(c.unknown,0)+COALESCE((SELECT SUM(CASE WHEN child.kind='folder' THEN cd.unknown ELSE cc.unknown END)
            FROM entries child LEFT JOIN paths cp ON cp.ref=child.ref LEFT JOIN dirs cd ON cd.id=cp.path LEFT JOIN scan_charges cc ON cc.ref=child.ref WHERE child.parent=e.ref),0) AS unknown,
        COALESCE(c.months3,0)+COALESCE((SELECT SUM(CASE WHEN child.kind='folder' THEN cd.months3 ELSE cc.months3 END)
            FROM entries child LEFT JOIN paths cp ON cp.ref=child.ref LEFT JOIN dirs cd ON cd.id=cp.path LEFT JOIN scan_charges cc ON cc.ref=child.ref WHERE child.parent=e.ref),0) AS months3,
        COALESCE(c.months6,0)+COALESCE((SELECT SUM(CASE WHEN child.kind='folder' THEN cd.months6 ELSE cc.months6 END)
            FROM entries child LEFT JOIN paths cp ON cp.ref=child.ref LEFT JOIN dirs cd ON cd.id=cp.path LEFT JOIN scan_charges cc ON cc.ref=child.ref WHERE child.parent=e.ref),0) AS months6,
        COALESCE(c.months12,0)+COALESCE((SELECT SUM(CASE WHEN child.kind='folder' THEN cd.months12 ELSE cc.months12 END)
            FROM entries child LEFT JOIN paths cp ON cp.ref=child.ref LEFT JOIN dirs cd ON cd.id=cp.path LEFT JOIN scan_charges cc ON cc.ref=child.ref WHERE child.parent=e.ref),0) AS months12
        FROM entries e JOIN paths p ON p.ref=e.ref LEFT JOIN dirs d ON d.id=p.path LEFT JOIN scan_charges c ON c.ref=e.ref
        WHERE e.ref=? AND e.kind NOT IN ('small-items','hidden-space','reserved')`);
    const update = db.prepare(`UPDATE entries SET allocated=?,items=?,data=CASE WHEN ? IS NULL THEN data ELSE json_set(data,'$.logicalBytes',?) END WHERE ref=?`);
    const ages = db.prepare('UPDATE dirs SET unknown=?,months3=?,months6=?,months12=? WHERE id=(SELECT path FROM paths WHERE ref=?)');
    const folded = db.prepare(`UPDATE entries SET allocated=COALESCE((SELECT SUM(allocated) FROM entries child
        WHERE child.parent=? AND child.visible=0 AND child.kind NOT IN ('small-items','hidden-space','reserved')),0)
        WHERE parent=? AND kind='small-items'`);
    const coverage = db.prepare(`SELECT p.path AS id,d.complete,d.enumerated=1 AND (d.materialized>0 OR d.complete=1)
        AND NOT (p.path=COALESCE((SELECT value FROM meta WHERE key='rootParent'),'')
            AND NOT EXISTS(SELECT 1 FROM paths root JOIN entries re ON re.ref=root.ref WHERE root.path=(SELECT value FROM meta WHERE key='root')))
        AND NOT EXISTS(SELECT 1 FROM entries child LEFT JOIN paths cp ON cp.ref=child.ref WHERE child.parent=e.ref AND
            (child.retained=1 OR CASE WHEN child.kind='folder' THEN NOT (${directoryEvidence('nodes', 'dirs', 'cp.path', 'complete')})
            WHEN child.kind NOT IN ('small-items','hidden-space','reserved') THEN json_extract(child.data,'$.flags.atLeast')=1 ELSE 0 END)) AS settled
        FROM entries e JOIN paths p ON p.ref=e.ref JOIN dirs d ON d.id=p.path WHERE e.ref=? AND e.kind='folder'`);
    const coverageRow = z.object({ id: z.string(), complete: z.number(), settled: z.number() });
    const settleDirectory = db.prepare('UPDATE dirs SET complete=?,scanned=CASE WHEN ?=1 THEN ? ELSE scanned END WHERE id=?');
    const settleCoverage = db.prepare('UPDATE coverage SET complete=?,scanned=CASE WHEN ?=1 THEN ? ELSE scanned END WHERE path=?');
    const settleFlags = db.prepare(`UPDATE entries SET data=json_set(data,'$.flags.atLeast',json(?),'$.size.atLeast',json(?))
        WHERE ref=? AND json_extract(data,'$.flags.atLeast')<>?`);
    for (const value of db.prepare('SELECT ref FROM scan_rollup ORDER BY depth').iterate()) {
        const { ref } = refRow.parse(value);
        const raw = aggregate.get(ref); if (!raw) continue;
        const row = aggregateRow.parse(raw);
        if (hasFacts) {
            update.run(row.allocated, row.items, row.logical, row.logical, ref);
            ages.run(row.unknown, row.months3, row.months6, row.months12, ref);
            folded.run(ref, ref);
        }
        const rawCoverage = coverage.get(ref);
        if (rawCoverage) {
            const { id, complete, settled } = coverageRow.parse(rawCoverage);
            if (complete !== settled) {
                settleDirectory.run(settled, settled, now, id); settleCoverage.run(settled, settled, now, id);
            }
            const atLeast = settled ? 'false' : 'true';
            settleFlags.run(atLeast, atLeast, ref, 1 - settled);
        }
    }
    db.exec('DROP TABLE scan_charges; DROP TABLE scan_charge_owners; DROP TABLE scan_rollup; DELETE FROM dirty_scan_nodes');
}
