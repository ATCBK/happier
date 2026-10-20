import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isRecord } from '@happier-dev/plugin-sdk';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionUnsupportedTranscriptItem, readJsonlFileForwardLines } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { QwenSourceError, type QwenFile } from './source.js';

type NativeRecord = Readonly<{ uuid: string; parentUuid: string | null; sessionId: string; timestamp: string;
  type: 'user' | 'assistant' | 'tool_result' | 'system'; subtype?: string; cwd?: string; message?: Record<string, unknown>; systemPayload?: Record<string, unknown> }>;
export type QwenTranscript = Readonly<{ items: readonly AgentExternalSessionTranscriptItem[]; partial: boolean; identity: string;
  cwd?: string; title?: string; createdAtMs: number; parentSessionId?: string }>;
const hiddenSystem = new Set(['session_sources_snapshot', 'session_artifact_event', 'session_artifact_snapshot']);
const knownSystem = new Set(['chat_compression', 'slash_command', 'ui_telemetry', 'at_command', 'attribution_snapshot', 'notification',
  'background_task_completed', 'cron', 'mid_turn_user_message', 'realtime_message', 'custom_title', 'parent_session', 'rewind',
  'agent_bootstrap', 'agent_launch_prompt', 'agent_retry', 'agent_session_ready', 'file_history_snapshot', 'session_source', 'session_model',
  'omni_recall', 'session_execution_engine', 'session_approval_mode', 'branch_checkpoint', 'goal_state', 'goal_runtime', 'goal_turn_end',
  'turn_result', 'turn_attempt', 'user_text_elements']);
export function digestItems(items: readonly AgentExternalSessionTranscriptItem[]): string {
  const hash = createHash('sha256'); for (const item of items) hash.update(JSON.stringify(item)).update('\n'); return hash.digest('base64url');
}
function textOutput(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  // Qwen's functionResponse stores tool output in response.output. Arguments,
  // names, ids, descriptions and arbitrary JSON are never display body text.
  return typeof value.output === 'string' ? value.output : typeof value.content === 'string' ? value.content : null;
}
function project(record: NativeRecord, parts: readonly unknown[]): Readonly<{ text: string; unsupported: boolean }> {
  let unsupported = !record.message || !Array.isArray(record.message.parts);
  const text: string[] = [];
  const payload = record.systemPayload;
  const projectedUser = record.type === 'user' && payload && typeof payload.hookContext === 'string' && typeof payload.displayText === 'string';
  if (projectedUser) text.push(payload.displayText as string);
  for (const part of parts) {
    if (!isRecord(part)) { unsupported = true; continue; }
    if (typeof part.text === 'string') { if (part.thought !== true && !projectedUser) text.push(part.text); }
    else if (isRecord(part.functionResponse)) {
      const output = textOutput(part.functionResponse.response); if (output !== null) text.push(output); else unsupported = true;
    } else if (!isRecord(part.functionCall) && !isRecord(part.inlineData) && !isRecord(part.fileData)) unsupported = true;
  }
  return { text: text.join(''), unsupported };
}

/** Pinned native dialect: QwenLM/qwen-code@b28b0d948 (v0.25.3),
 * transcript-records.ts#prepareTranscriptRecords. The final conversation UUID
 * selects the active parent chain. Repeated UUIDs are streaming fragments.
 * Compression payloads replace model context, never the visible transcript. */
export async function readQwenTranscript(file: QwenFile, signal: AbortSignal): Promise<QwenTranscript> {
  signal.throwIfAborted();
  const info = await stat(file.path);
  const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  const records = new Map<string, { record: NativeRecord; parts: unknown[] }>();
  let leaf: string | null = null; let partial = false; let unsupportedVersion = false;
  const page = await readJsonlFileForwardLines({ filePath: file.path, offsetBytes: 0, maxBytes: info.size,
    maxItems: Number.MAX_SAFE_INTEGER, maxOversizeLineBytes: Math.max(1, info.size),
    onDiagnostic: () => { partial = true; },
    onLine(line) {
      signal.throwIfAborted();
      const value = line.value;
      if (!isRecord(value)) { partial = true; return; }
      if (value.version !== '0.25.3') { unsupportedVersion = true; return; }
      if (typeof value.uuid !== 'string' || !value.uuid || (value.parentUuid !== null && typeof value.parentUuid !== 'string')
        || value.sessionId !== file.sessionId || typeof value.timestamp !== 'string'
        || !['user', 'assistant', 'tool_result', 'system'].includes(String(value.type))) { partial = true; return; }
      if (value.type === 'system' && typeof value.subtype === 'string' && hiddenSystem.has(value.subtype)) return;
      if (value.type === 'system' && (!knownSystem.has(String(value.subtype)))) { unsupportedVersion = true; return; }
      const record: NativeRecord = { uuid: value.uuid, parentUuid: value.parentUuid, sessionId: value.sessionId, timestamp: value.timestamp,
        type: value.type as NativeRecord['type'], ...(typeof value.subtype === 'string' ? { subtype: value.subtype } : {}),
        ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}), ...(isRecord(value.message) ? { message: value.message } : {}),
        ...(isRecord(value.systemPayload) ? { systemPayload: value.systemPayload } : {}) };
      const parts = Array.isArray(record.message?.parts) ? record.message.parts : [];
      const existing = records.get(record.uuid);
      if (existing) {
        if (existing.record.parentUuid !== record.parentUuid || existing.record.type !== record.type) { partial = true; return; }
        existing.parts.push(...parts);
      } else records.set(record.uuid, { record, parts: [...parts] });
      leaf = record.uuid;
    },
  });
  signal.throwIfAborted();
  if (unsupportedVersion) throw new QwenSourceError('unsupported', 'Qwen native transcript format is unsupported.');
  partial ||= !page.reachedEnd || page.truncated;
  const chain: { record: NativeRecord; parts: unknown[] }[] = []; const visited = new Set<string>();
  while (leaf !== null) {
    if (visited.has(leaf)) { partial = true; break; } visited.add(leaf);
    const entry = records.get(leaf); if (!entry) { partial = true; break; }
    chain.push(entry); leaf = entry.record.parentUuid;
  }
  chain.reverse();
  const items: AgentExternalSessionTranscriptItem[] = []; let title: string | undefined; let parentSessionId: string | undefined;
  for (const { record, parts } of chain) {
    signal.throwIfAborted();
    const createdAtMs = Date.parse(record.timestamp);
    if (!Number.isFinite(createdAtMs)) { partial = true; continue; }
    if (record.type === 'system') {
      if (record.subtype === 'custom_title' && typeof record.systemPayload?.title === 'string') title = record.systemPayload.title;
      if (record.subtype === 'parent_session' && typeof record.systemPayload?.parentSessionId === 'string') parentSessionId = record.systemPayload.parentSessionId;
      continue;
    }
    const projected = project(record, parts); partial ||= projected.unsupported;
    if (projected.text) {
      const user = record.type === 'user';
      items.push({ id: record.uuid, createdAtMs, messageRole: user ? 'user' : 'agent',
        ...(user ? { userProjection: 'source_fact' as const } : {}), raw: user
          ? { role: 'user', content: { type: 'text', text: projected.text } }
          : { role: 'agent', content: { type: 'acp', agentId: 'qwen', data: record.type === 'tool_result'
            ? { type: 'tool-result', callId: parts.flatMap(part => isRecord(part) && isRecord(part.functionResponse) && typeof part.functionResponse.id === 'string'
              ? [part.functionResponse.id] : [])[0] ?? record.uuid, output: projected.text, isError: false }
            : { type: 'message', message: projected.text } } } });
    } else if (projected.unsupported) items.push(createExternalSessionUnsupportedTranscriptItem({ agentId: 'qwen', id: record.uuid, createdAtMs }));
    for (const part of parts) {
      if (!isRecord(part) || !isRecord(part.functionCall)) continue;
      const call = part.functionCall;
      if (typeof call.id !== 'string' || typeof call.name !== 'string') { partial = true; continue; }
      const id = `${record.uuid}:tool:${call.id}`;
      const raw = AgentExternalSessionTranscriptRawRecordSchema.safeParse({ role: 'agent', content: { type: 'acp', agentId: 'qwen',
        data: { type: 'tool-call', callId: call.id, name: call.name, input: call.args ?? {} } } });
      if (raw.success) items.push({ id, createdAtMs, messageRole: 'agent', raw: raw.data });
      else { partial = true; items.push(createExternalSessionUnsupportedTranscriptItem({ agentId: 'qwen', id, createdAtMs })); }
    }
  }
  const after = await stat(file.path);
  if (`${after.dev}:${after.ino}:${after.birthtimeMs}` !== identity || after.size < info.size || (after.size === info.size && after.mtimeMs !== info.mtimeMs))
    throw new QwenSourceError('source_invalid', 'Qwen transcript changed during its read.');
  return { items, partial, identity, createdAtMs: items[0]?.createdAtMs ?? info.birthtimeMs,
    ...(chain[0]?.record.cwd ? { cwd: chain[0].record.cwd } : {}), ...(title ? { title } : {}), ...(parentSessionId ? { parentSessionId } : {}) };
}
