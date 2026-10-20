import { copyFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '@happier-dev/plugin-sdk';
import { openSqliteDatabaseSync, type SqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { DevinSourceError } from './source.js';

// Characterized native ledger, Devin 3000.6.7 / schema 16. Provenance is
// recorded beside the sanitized fixture; no vendor writer is loaded.
const MIGRATIONS = [[1,"initial_schema","9244923949255133246"],[2,"add_thinking_column","14224532003883382682"],[3,"add_prompt_history","12622061916787456317"],[4,"add_metadata_column","10743897110053661924"],[5,"message_forest","9668121967925007678"],[6,"add_node_metadata","8078921727324108560"],[7,"add_shell_context","258551201440621856"],[8,"add_session_cogs","105359765896368723"],[9,"add_rendered_commits","3762685451217257726"],[10,"add_workspace_dirs","10474887258761036276"],[11,"add_prompt_history_is_shell","11375493059147639310"],[12,"add_app_state","14171664772219278324"],[13,"rename_permission_mode_to_agent_mode","14037567567567316550"],[14,"tool_call_state","9276893574920127698"],[15,"add_hidden_column","3632756168171233470"],[16,"add_session_json_metadata","4954231843905863386"]] as const;
const COLUMNS = {
  sessions: ['id','working_directory','backend_type','model','agent_mode','created_at','last_activity_at','title','main_chain_id','shell_last_seen_index','cogs_json','workspace_dirs','hidden','metadata'],
  message_nodes: ['row_id','session_id','node_id','parent_node_id','chat_message','created_at','metadata'],
  refinery_schema_history: ['version','name','applied_on','checksum'],
} as const;

function validateSchema(db: SqliteDatabaseSync) {
  for (const [table, expected] of Object.entries(COLUMNS)) {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map(row => isRecord(row) ? row.name : null);
    if (JSON.stringify(columns) !== JSON.stringify(expected)) throw new DevinSourceError('unsupported', 'Unsupported Devin database layout.');
  }
  const ledger = db.prepare('SELECT version,name,checksum FROM refinery_schema_history ORDER BY version').all();
  if (ledger.length !== MIGRATIONS.length || ledger.some((row, index) => !isRecord(row)
    || row.version !== MIGRATIONS[index]?.[0] || row.name !== MIGRATIONS[index]?.[1] || row.checksum !== MIGRATIONS[index]?.[2])) {
    throw new DevinSourceError('unsupported', 'Unsupported Devin database schema; only schema 16 is characterized.');
  }
}

/** Vendor paths are byte sources only. SQLite, including its SHM/read marks,
 * sees exclusively this operation's private disposable copy (X6 18:10).
 * No immutable URI or existence-selected vendor open is permitted. */
export async function withDevinDatabase<T>(path: string, signal: AbortSignal, read: (db: SqliteDatabaseSync, walPresent: boolean) => T | Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'happier-devin-read-'));
  let db: SqliteDatabaseSync | undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new DevinSourceError('source_invalid', 'Devin database must be a regular admitted file.');
    const copy = join(directory, 'sessions.db');
    await copyFile(path, copy);
    signal.throwIfAborted();
    let walPresent = false;
    try {
      const walInfo = await lstat(path + '-wal');
      if (!walInfo.isFile() || walInfo.isSymbolicLink()) throw new DevinSourceError('source_invalid', 'Devin WAL must be a regular admitted file.');
      await copyFile(path + '-wal', copy + '-wal');
      walPresent = walInfo.size > 0;
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      // A last vendor connection may checkpoint/remove its WAL during copy.
      // The copy is allowed to be stale; SQLite errors remain unavailable.
    }
    signal.throwIfAborted();
    db = openSqliteDatabaseSync(copy, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    validateSchema(db);
    const result = await read(db, walPresent);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof DevinSourceError) throw error;
    throw new DevinSourceError('unavailable', 'Devin native database is unavailable or its byte copy could not be read.');
  } finally {
    try { db?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
