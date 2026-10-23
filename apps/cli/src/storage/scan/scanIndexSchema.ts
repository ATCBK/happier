import type { SqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';

// One entry is both a file-query fact and (when visible) a chart node. Paths are
// stored once, not in every payload, parent column, observation and B-tree key.
// Views preserve the index owner's path-based SQL without another persisted copy.
export const scanDataTables = ['paths', 'entries', 'allocation_observations', 'dirs', 'coverage', 'boundaries'] as const;

export function scanIndexSchema(namespace = '', prefix = ''): string {
    const table = (name: string) => `${namespace}${prefix}${name}`;
    const local = (name: string) => `${prefix}${name}`;
    const compact = (data: string) => `json_remove(${data},'$.nodeId','$.parentId','$.name','$.kind','$.changedAt','$.items','$.size.allocatedBytes')`;
    const kind = "CASE WHEN e.kind IN ('symlink','other') THEN 'file' ELSE e.kind END";
    const projected = `json_set(e.data,'$.nodeId',p.path,'$.name',e.name,'$.kind',${kind},'$.changedAt',e.changed,'$.items',e.items,'$.size.allocatedBytes',e.allocated)`;
    return `
CREATE TABLE IF NOT EXISTS ${table('paths')}(ref INTEGER PRIMARY KEY,path TEXT NOT NULL UNIQUE,rawSort BLOB);
CREATE TABLE IF NOT EXISTS ${table('entries')}(ref INTEGER PRIMARY KEY,parent INTEGER,name TEXT NOT NULL,kind TEXT NOT NULL,allocated INTEGER NOT NULL,changed INTEGER NOT NULL,items INTEGER NOT NULL,visible INTEGER NOT NULL,data TEXT NOT NULL,seen INTEGER NOT NULL DEFAULT 0,retained INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ${table('entries_parent')} ON ${local('entries')}(parent);
CREATE INDEX IF NOT EXISTS ${table('files_size')} ON ${local('entries')}(allocated,ref) WHERE kind='file';
CREATE INDEX IF NOT EXISTS ${table('files_age')} ON ${local('entries')}(changed,ref) WHERE kind='file';
CREATE TABLE IF NOT EXISTS ${table('allocation_observations')}(owner INTEGER NOT NULL,path INTEGER NOT NULL,key TEXT NOT NULL,allocated INTEGER NOT NULL,mtime INTEGER NOT NULL,ageIncluded INTEGER NOT NULL,PRIMARY KEY(owner,path,key)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ${table('observations_key')} ON ${local('allocation_observations')}(key,path,owner);
${prefix ? `CREATE UNIQUE INDEX IF NOT EXISTS ${table('paths_ref')} ON ${local('paths')}(ref);
CREATE UNIQUE INDEX IF NOT EXISTS ${table('paths_path')} ON ${local('paths')}(path);
CREATE UNIQUE INDEX IF NOT EXISTS ${table('entries_ref')} ON ${local('entries')}(ref);
CREATE UNIQUE INDEX IF NOT EXISTS ${table('dirs_id')} ON ${local('dirs')}(id);
CREATE UNIQUE INDEX IF NOT EXISTS ${table('coverage_path')} ON ${local('coverage')}(path);` : ''}
CREATE VIEW IF NOT EXISTS ${table('nodes')} AS SELECT p.path AS id,parent.path AS parent,e.name,${kind} AS kind,e.allocated,e.changed,e.items,e.visible,
 CASE WHEN parent.path IS NULL THEN ${projected} ELSE json_set(${projected},'$.parentId',parent.path) END AS data,e.seen,e.retained
 FROM ${local('entries')} e JOIN ${local('paths')} p ON p.ref=e.ref LEFT JOIN ${local('paths')} parent ON parent.ref=e.parent;
CREATE VIEW IF NOT EXISTS ${table('files')} AS SELECT n.id,n.parent,n.name,n.kind,n.allocated,n.changed,n.items,n.visible,n.data
 FROM ${local('entries')} e JOIN ${local('paths')} p ON p.ref=e.ref JOIN ${local('nodes')} n ON n.id=p.path WHERE e.kind='file';
CREATE VIEW IF NOT EXISTS ${table('observations')} AS SELECT owner.path AS owner,path.path AS path,o.key,o.allocated,
 COALESCE(path.rawSort,CAST(path.path AS BLOB)) AS sort,o.mtime,o.ageIncluded
 FROM ${local('allocation_observations')} o JOIN ${local('paths')} owner ON owner.ref=o.owner JOIN ${local('paths')} path ON path.ref=o.path;
CREATE TRIGGER IF NOT EXISTS ${table('nodes_insert')} INSTEAD OF INSERT ON ${local('nodes')} BEGIN
 INSERT OR IGNORE INTO ${local('paths')}(path) VALUES(NEW.id);
 INSERT OR IGNORE INTO ${local('paths')}(path) SELECT NEW.parent WHERE NEW.parent IS NOT NULL;
 INSERT INTO ${local('entries')}(ref,parent,name,kind,allocated,changed,items,visible,data,seen,retained)
 VALUES((SELECT ref FROM ${local('paths')} WHERE path=NEW.id),(SELECT ref FROM ${local('paths')} WHERE path=NEW.parent),NEW.name,NEW.kind,NEW.allocated,NEW.changed,NEW.items,NEW.visible,${compact('NEW.data')},COALESCE(NEW.seen,0),COALESCE(NEW.retained,0))
 ON CONFLICT(ref) DO UPDATE SET parent=excluded.parent,name=excluded.name,kind=excluded.kind,allocated=excluded.allocated,changed=excluded.changed,items=excluded.items,visible=excluded.visible,data=excluded.data;
END;
CREATE TRIGGER IF NOT EXISTS ${table('nodes_update')} INSTEAD OF UPDATE ON ${local('nodes')} BEGIN
 UPDATE ${local('entries')} SET name=NEW.name,kind=CASE WHEN NEW.kind=OLD.kind THEN kind ELSE NEW.kind END,allocated=NEW.allocated,changed=NEW.changed,items=NEW.items,visible=NEW.visible,data=${compact('NEW.data')},seen=NEW.seen,retained=NEW.retained WHERE ref=(SELECT ref FROM ${local('paths')} WHERE path=OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS ${table('nodes_delete')} INSTEAD OF DELETE ON ${local('nodes')} BEGIN
 DELETE FROM ${local('entries')} WHERE ref=(SELECT ref FROM ${local('paths')} WHERE path=OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS ${table('observations_insert')} INSTEAD OF INSERT ON ${local('observations')} BEGIN
 INSERT OR IGNORE INTO ${local('paths')}(path) VALUES(NEW.owner);
 INSERT OR IGNORE INTO ${local('paths')}(path,rawSort) VALUES(NEW.path,CASE WHEN NEW.path LIKE 'bytes:%' THEN NEW.sort END);
 UPDATE ${local('paths')} SET rawSort=NEW.sort WHERE path=NEW.path AND NEW.path LIKE 'bytes:%' AND rawSort IS NULL;
 INSERT INTO ${local('allocation_observations')}(owner,path,key,allocated,mtime,ageIncluded)
 VALUES((SELECT ref FROM ${local('paths')} WHERE path=NEW.owner),(SELECT ref FROM ${local('paths')} WHERE path=NEW.path),NEW.key,NEW.allocated,NEW.mtime,NEW.ageIncluded)
 ON CONFLICT(owner,path,key) DO UPDATE SET allocated=excluded.allocated,mtime=excluded.mtime,ageIncluded=excluded.ageIncluded;
END;
CREATE TRIGGER IF NOT EXISTS ${table('observations_delete')} INSTEAD OF DELETE ON ${local('observations')} BEGIN
 DELETE FROM ${local('allocation_observations')} WHERE owner=(SELECT ref FROM ${local('paths')} WHERE path=OLD.owner) AND path=(SELECT ref FROM ${local('paths')} WHERE path=OLD.path) AND key=OLD.key;
END;`;
}

export function dropScanRelations(db: SqliteDatabaseSync, prefix: string): void {
    db.exec(`DROP VIEW IF EXISTS ${prefix}files; DROP VIEW IF EXISTS ${prefix}nodes; DROP VIEW IF EXISTS ${prefix}observations;`);
    for (const table of scanDataTables) db.exec(`DROP TABLE IF EXISTS ${prefix}${table}`);
}
