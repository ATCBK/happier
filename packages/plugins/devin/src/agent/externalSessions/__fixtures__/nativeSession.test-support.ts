import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';

// Sanitized reconstruction of the public ordinary-run native capture:
// xhluca/session-migrate@45351ff95ce79684c23377920b92026ecbe9759b,
// tests/native_corpus/v1/sources/devin/3000.6.7/portable-rich/provenance.json.
// Producer Devin 3000.6.7 (260a97c8), schema 16. SQL/ledger copied from that
// revision's formats/devin.py; all conversation text below is synthetic.
export const DEVIN_FIXTURE_MIGRATIONS = [[1,"initial_schema","9244923949255133246"],[2,"add_thinking_column","14224532003883382682"],[3,"add_prompt_history","12622061916787456317"],[4,"add_metadata_column","10743897110053661924"],[5,"message_forest","9668121967925007678"],[6,"add_node_metadata","8078921727324108560"],[7,"add_shell_context","258551201440621856"],[8,"add_session_cogs","105359765896368723"],[9,"add_rendered_commits","3762685451217257726"],[10,"add_workspace_dirs","10474887258761036276"],[11,"add_prompt_history_is_shell","11375493059147639310"],[12,"add_app_state","14171664772219278324"],[13,"rename_permission_mode_to_agent_mode","14037567567567316550"],[14,"tool_call_state","9276893574920127698"],[15,"add_hidden_column","3632756168171233470"],[16,"add_session_json_metadata","4954231843905863386"]] as const;
export function createDevinNativeFixture(root: string, texts: readonly string[] = ['body-only harbor café 😀\nquoted "text"'], sessionId = 'native-session') {
  mkdirSync(root, { recursive: true });
  const path = join(root, 'sessions.db');
  const db = openSqliteDatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE refinery_schema_history(
  version int4 PRIMARY KEY, name VARCHAR(255), applied_on VARCHAR(255),
  checksum VARCHAR(255));
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
  model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
  shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT,
  hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
CREATE INDEX idx_sessions_activity ON sessions(last_activity_at DESC);
CREATE INDEX idx_sessions_hidden ON sessions(hidden);
CREATE TABLE prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
  timestamp INTEGER NOT NULL, session_id TEXT NOT NULL,
  is_shell INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_prompt_history_timestamp ON prompt_history(timestamp DESC);
CREATE INDEX idx_prompt_history_session ON prompt_history(session_id);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL, metadata TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id), UNIQUE(session_id, node_id));
CREATE INDEX idx_message_nodes_session ON message_nodes(session_id);
CREATE TABLE rendered_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL, rendered_html TEXT NOT NULL,
  created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, sequence_number));
CREATE INDEX idx_rendered_commits_session ON rendered_commits(session_id, sequence_number);
CREATE TABLE app_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE tool_call_state (
  session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, tool_call_json TEXT,
  tool_call_update_json TEXT, PRIMARY KEY (session_id, tool_call_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id));
`);
  for (const row of DEVIN_FIXTURE_MIGRATIONS) db.prepare('INSERT INTO refinery_schema_history VALUES (?, ?, ?, ?)').run(row[0], row[1], '2026-10-20T10:00:00Z', row[2]);
  db.exec('PRAGMA wal_autocheckpoint=0');
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, main_chain_id) VALUES (?, ?, 'native', 'fixture', 'smart', ?, ?, 'Ordinary title', NULL)").run(sessionId, '/repo', now, now);
  function append(text: string, role = 'user', extra: Record<string, unknown> = {}) {
    const count = db.prepare('SELECT max(node_id) AS count FROM message_nodes WHERE session_id=?').get(sessionId) as { count: number | null };
    const id = (count.count ?? 0) + 1;
    const tip = db.prepare('SELECT main_chain_id AS tip FROM sessions WHERE id=?').get(sessionId) as { tip: number | null };
    db.exec('BEGIN');
    db.prepare('INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)').run(sessionId, id, tip.tip, JSON.stringify({
      message_id: `message-${id}`, role, content: text, ...(role === 'assistant' ? { tool_calls: [] } : {}), ...extra,
    }), now);
    db.prepare('UPDATE sessions SET main_chain_id=?,last_activity_at=? WHERE id=?').run(id, now, sessionId);
    db.exec('COMMIT');
    return id;
  }
  for (const text of texts) append(text);
  let closed = false;
  return { path, db, sessionId, append, close: () => { if (!closed) { closed = true; db.close(); } } };
}
