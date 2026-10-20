import { join } from 'node:path';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionUnsupportedTranscriptItem } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { children, isId, readDocument, record, type KiloSession, type KiloStore } from './source.js';

export type KiloProjection = Readonly<{ items: readonly AgentExternalSessionTranscriptItem[]; partial: boolean }>;
const messageFields = new Set(['id', 'sessionID', 'role', 'time', 'format', 'summary', 'agent', 'model', 'system', 'tools', 'variant',
  'error', 'parentID', 'modelID', 'providerID', 'mode', 'path', 'cost', 'tokens', 'structured', 'finish']);
const partBaseFields = new Set(['id', 'sessionID', 'messageID', 'type']);
const partFields: Readonly<Record<string, readonly string[]>> = {
  text: ['text', 'synthetic', 'ignored', 'time', 'metadata'], tool: ['callID', 'tool', 'state', 'metadata'],
  reasoning: ['text', 'time', 'metadata'], 'step-start': ['snapshot'], 'step-finish': ['reason', 'snapshot', 'cost', 'tokens'],
  snapshot: ['snapshot'], patch: ['hash', 'files'], agent: ['name', 'source'], retry: ['attempt', 'error', 'time'],
  compaction: ['auto'], subtask: ['prompt', 'description', 'agent', 'model', 'command'],
};
const toolStateFields = new Set(['status', 'input', 'raw', 'title', 'metadata', 'time', 'output', 'error', 'attachments']);

export async function messageIds(store: KiloStore, session: KiloSession): Promise<string[]> {
  if (session.version !== '1.0.25') return [];
  try {
    return (await children(store, join(store.root, 'message', session.id)))
      .filter(file => file.endsWith('.json') && isId(file.slice(0, -5))).map(file => file.slice(0, -5));
  } catch (error) { if (record(error) && error.code === 'ENOENT') return []; throw error; }
}

export function unsupported(id: string, createdAtMs: number): AgentExternalSessionTranscriptItem {
  return createExternalSessionUnsupportedTranscriptItem({ agentId: 'kilo', id, localId: id, createdAtMs });
}

/** Native MessageV2 at vendor 6f08110 / CLI 1.0.25. IDs order messages and parts.
 * The native TUI hides every message at/after revert.messageID, including when
 * partID is present (cli/cmd/tui/routes/session/index.tsx:1076). */
export async function readMessage(store: KiloStore, session: KiloSession, messageId: string, signal: AbortSignal): Promise<KiloProjection> {
  signal.throwIfAborted();
  if (session.revert && messageId >= session.revert.messageID) return { items: [], partial: false };
  const info = await readDocument(store, join(store.root, 'message', session.id, `${messageId}.json`), signal);
  const fallback = () => ({ items: [unsupported(messageId, session.createdAtMs)], partial: true });
  if (!record(info) || info.id !== messageId || info.sessionID !== session.id || !record(info.time)
    || Object.keys(info).some(key => !messageFields.has(key))
    || typeof info.time.created !== 'number' || !Number.isFinite(info.time.created)
    || (info.role !== 'user' && info.role !== 'assistant')) return fallback();
  if (info.summary === true) return { items: [], partial: false };
  let names: string[];
  try { names = await children(store, join(store.root, 'part', messageId)); }
  catch (error) { if (record(error) && error.code === 'ENOENT') return fallback(); throw error; }
  const createdAtMs = info.time.created;
  const items: AgentExternalSessionTranscriptItem[] = [];
  let partial = false;
  for (const name of names) {
    signal.throwIfAborted();
    if (!name.endsWith('.json') || !isId(name.slice(0, -5))) continue;
    const id = name.slice(0, -5);
    const part = await readDocument(store, join(store.root, 'part', messageId, name), signal);
    const base = { id, localId: id, createdAtMs };
    const unknown = () => { partial = true; items.push(unsupported(id, createdAtMs)); };
    if (!record(part) || part.id !== id || part.messageID !== messageId || part.sessionID !== session.id
      || typeof part.type !== 'string' || !Object.hasOwn(partFields, part.type)
      || Object.keys(part).some(key => !partBaseFields.has(key) && !partFields[String(part.type)]!.includes(key))) { unknown(); continue; }
    if (part.type !== 'text' && part.type !== 'tool') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.synthetic === true || part.ignored === true) continue;
      items.push(info.role === 'user'
        ? { ...base, messageRole: 'user', raw: { role: 'user', content: { type: 'text', text: part.text } } }
        : { ...base, messageRole: 'agent', raw: { role: 'agent', content: { type: 'acp', agentId: 'kilo', data: { type: 'message', message: part.text } } } });
    } else if (part.type === 'tool' && info.role === 'assistant' && record(part.state) && typeof part.callID === 'string' && typeof part.tool === 'string') {
      const state = part.state;
      if (Object.keys(state).some(key => !toolStateFields.has(key))) { unknown(); continue; }
      const callId = `${id}:call`;
      const call = AgentExternalSessionTranscriptRawRecordSchema.safeParse({ role: 'agent', content: {
        type: 'acp', agentId: 'kilo', data: { type: 'tool-call', id: callId, callId: part.callID, name: part.tool, input: state.input ?? {} },
      } });
      if (!call.success) { unknown(); continue; }
      items.push({ ...base, id: callId, localId: callId, messageRole: 'event', raw: call.data });
      const output = state.status === 'completed' ? state.output : state.status === 'error' ? state.error : null;
      if (typeof output === 'string') items.push({ ...base, messageRole: 'event', raw: { role: 'agent', content: {
        type: 'acp', agentId: 'kilo', data: { type: 'tool-result', id, callId: part.callID, output,
          ...(state.status === 'error' ? { isError: true } : {}) },
      } } });
      else if (state.status !== 'pending' && state.status !== 'running') unknown();
    } else unknown();
  }
  if (names.length === 0) return fallback();
  return { items, partial };
}

export async function readTranscript(store: KiloStore, session: KiloSession, signal: AbortSignal): Promise<KiloProjection> {
  if (session.version !== '1.0.25') return { items: [unsupported(session.id, session.createdAtMs)], partial: true };
  const ids = await messageIds(store, session);
  const items: AgentExternalSessionTranscriptItem[] = [];
  let partial = false;
  for (const id of ids) {
    const page = await readMessage(store, session, id, signal);
    items.push(...page.items); partial ||= page.partial;
  }
  return { items, partial };
}

export function searchText(item: AgentExternalSessionTranscriptItem): string | null {
  if (item.raw.role === 'user') return item.raw.content.text;
  const content = item.raw.content;
  if (!record(content) || !record(content.data)) return null;
  if (content.data.type === 'message' && typeof content.data.message === 'string') return content.data.message;
  return content.data.type === 'tool-result' && typeof content.data.output === 'string' ? content.data.output : null;
}
