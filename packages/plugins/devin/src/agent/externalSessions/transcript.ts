import { isRecord } from '@happier-dev/plugin-sdk';
import type { SqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionUnsupportedTranscriptItem } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { DevinSourceError, digest } from './source.js';

type VisibleRow = { item: AgentExternalSessionTranscriptItem; text: string };
export type DevinTranscript = { rows: VisibleRow[]; partial: boolean };
export type DevinSession = { id: string; cwd: string; title?: string; createdAtMs: number; updatedAtMs: number; tip: number | null };
export function listDevinSessions(db: SqliteDatabaseSync): DevinSession[] {
  return db.prepare('SELECT id,working_directory,title,created_at,last_activity_at,main_chain_id FROM sessions WHERE hidden=0 ORDER BY id').all().map(row => {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id || typeof row.working_directory !== 'string'
      || typeof row.created_at !== 'number' || !Number.isSafeInteger(row.created_at)
      || typeof row.last_activity_at !== 'number' || !Number.isSafeInteger(row.last_activity_at)
      || !(row.main_chain_id === null || (typeof row.main_chain_id === 'number' && Number.isSafeInteger(row.main_chain_id) && row.main_chain_id > 0))) {
      throw new DevinSourceError('unsupported', 'Unsupported Devin native session metadata.');
    }
    return { id: row.id, cwd: row.working_directory, ...(typeof row.title === 'string' ? { title: row.title } : {}),
      createdAtMs: row.created_at * 1000, updatedAtMs: row.last_activity_at * 1000, tip: row.main_chain_id };
  });
}
function known(record: Record<string, unknown>, keys: readonly string[]) { return Object.keys(record).every(key => keys.includes(key)); }

export function readDevinTranscript(db: SqliteDatabaseSync, session: DevinSession, signal: AbortSignal): DevinTranscript {
  const chain: { id: number; parent: number | null; message: unknown; createdAtMs: number }[] = [];
  const seen = new Set<number>();
  const statement = db.prepare('SELECT node_id,parent_node_id,chat_message,created_at FROM message_nodes WHERE session_id=? AND node_id=?');
  let tip = session.tip;
  while (tip !== null) {
    signal.throwIfAborted();
    if (seen.has(tip)) throw new DevinSourceError('unsupported', 'Devin native ancestry contains a cycle.');
    seen.add(tip);
    const node = statement.get(session.id, tip);
    if (!isRecord(node) || node.node_id !== tip || typeof node.chat_message !== 'string'
      || !(node.parent_node_id === null || (typeof node.parent_node_id === 'number' && Number.isSafeInteger(node.parent_node_id) && node.parent_node_id > 0))
      || typeof node.created_at !== 'number' || !Number.isSafeInteger(node.created_at)) {
      throw new DevinSourceError('unsupported', 'Devin native ancestry is incomplete.');
    }
    let message: unknown;
    try { message = JSON.parse(node.chat_message); } catch { throw new DevinSourceError('unsupported', 'Unreadable Devin native message.'); }
    chain.push({ id: tip, parent: node.parent_node_id, message, createdAtMs: node.created_at * 1000 });
    tip = node.parent_node_id;
  }
  chain.reverse();
  const rows: VisibleRow[] = [];
  const tools = new Map<string, string>();
  let partial = false;
  for (const node of chain) {
    signal.throwIfAborted();
    const id = `devin:${session.id}:${node.id}`;
    const unsupported = (suffix = '') => {
      partial = true;
      rows.push({ text: '', item: createExternalSessionUnsupportedTranscriptItem({ agentId: 'devin', id: id + suffix, createdAtMs: node.createdAtMs }) });
    };
    const message = node.message;
    if (!isRecord(message) || !known(message, ['message_id','role','content','metadata','thinking','tool_calls','tool_call_id','tool_name','is_error','images'])
      || typeof message.message_id !== 'string' || !message.message_id || !['system','user','assistant','tool'].includes(String(message.role))) { unsupported(); continue; }
    if (message.role === 'system') continue;
    const textParts: string[] = [];
    let unknownContent = false;
    if (typeof message.content === 'string') textParts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isRecord(part) && part.type === 'text' && known(part, ['type','text']) && typeof part.text === 'string') textParts.push(part.text);
        else unknownContent = true;
      }
    } else unknownContent = true;
    const text = textParts.join('\n');
    const add = (item: AgentExternalSessionTranscriptItem, searchable = text) => rows.push({ text: searchable, item });
    if (message.role === 'user' && text) {
      add({ id, createdAtMs: node.createdAtMs, messageRole: 'user', raw: { role: 'user', content: { type: 'text', text } } });
    } else if (message.role === 'assistant') {
      if (text) add({ id, createdAtMs: node.createdAtMs, messageRole: 'agent', raw: { role: 'agent', content: { type: 'acp', agentId: 'devin', data: { type: 'message', message: text } } } });
      if (!Array.isArray(message.tool_calls)) unknownContent = true;
      else for (const call of message.tool_calls) {
        if (!isRecord(call) || !known(call, ['id','name','kind','index','arguments']) || typeof call.id !== 'string' || typeof call.name !== 'string'
          || call.kind !== 'function' || !Number.isSafeInteger(call.index) || !isRecord(call.arguments)) { unknownContent = true; continue; }
        tools.set(call.id, call.name);
        add({ id: id + ':tool:' + call.id, createdAtMs: node.createdAtMs, messageRole: 'event', raw: { role: 'agent', content: {
          type: 'acp', agentId: 'devin', data: { type: 'tool-call', callId: call.id, name: call.name, input: {} },
        } } }, '');
      }
    } else if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !tools.has(message.tool_call_id)) unknownContent = true;
      else add({ id, createdAtMs: node.createdAtMs, messageRole: 'event', raw: { role: 'agent', content: {
        type: 'acp', agentId: 'devin', data: { type: 'tool-result', callId: message.tool_call_id, output: text, ...(message.is_error === true ? { isError: true } : {}) },
      } } });
    }
    if (unknownContent || (Array.isArray(message.images) && message.images.length > 0)) unsupported(':unsupported');
  }
  return { rows, partial };
}
export function devinPrefixIdentity(transcript: DevinTranscript, end: number) {
  return digest(JSON.stringify(transcript.rows.slice(0, end)));
}
