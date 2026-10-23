import type { SqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';

/** Normalized retained facts: root, 22 children, 176 package folders, 299,904 files. */
export function seedRetainedScanIndex(db: SqliteDatabaseSync, root = '/retained', entries = 300103): void {
    db.exec(`BEGIN;
        WITH RECURSIVE ids(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM ids WHERE i<${entries})
        INSERT INTO paths(ref,path) SELECT i,CASE WHEN i=1 THEN '${root}' ELSE '${root}/'||i END FROM ids;
        INSERT INTO entries SELECT ref,CASE WHEN ref=1 THEN NULL WHEN ref<=23 THEN 1 WHEN ref<=199 THEN 2+(ref-24)/8 ELSE 24+(ref-200)%176 END,
            CAST(ref AS TEXT),CASE WHEN ref<=199 THEN 'folder' ELSE 'file' END,
            CASE WHEN ref<=199 THEN 0 ELSE (ref%31+1)*4096 END,2000,1,1,
            '{"logicalBytes":0,"size":{"freesBytes":0,"sharedBytes":0,"sharedExtentsUnmeasured":false,"atLeast":false},"flags":{"happier":false,"protection":"none","atLeast":false,"inUse":false},"childCount":0}',1,0 FROM paths;
        INSERT INTO allocation_observations SELECT ref,ref,'physical:'||ref,allocated,2000,1 FROM entries WHERE kind='file';
        UPDATE entries SET allocated=COALESCE((SELECT SUM(c.allocated) FROM entries c WHERE c.parent=entries.ref),0),items=1+(SELECT COUNT(*) FROM entries c WHERE c.parent=entries.ref) WHERE ref BETWEEN 24 AND 199;
        UPDATE entries SET allocated=(SELECT SUM(c.allocated) FROM entries c WHERE c.parent=entries.ref),items=1+(SELECT SUM(c.items) FROM entries c WHERE c.parent=entries.ref) WHERE ref BETWEEN 2 AND 23;
        UPDATE entries SET allocated=(SELECT SUM(c.allocated) FROM entries c WHERE c.parent=1),items=${entries} WHERE ref=1;
        INSERT INTO dirs SELECT p.path,1,100,0,0,0,0,e.allocated,1,0,1,1 FROM entries e JOIN paths p ON p.ref=e.ref WHERE e.kind='folder';
        INSERT INTO coverage SELECT id,100,1 FROM dirs;
        COMMIT;`);
}
