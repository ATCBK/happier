import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import {
  createExternalSessionUnsupportedTranscriptItem, readJsonlFileForwardLines,
} from '@happier-dev/plugin-sdk/sessions/file-stores';
import { isRecord, parseTimestampMs } from '@happier-dev/plugin-sdk';
import { confinedKiroFile, digest, readKiroMetadata } from './source.js';

type VisibleRow = { item: AgentExternalSessionTranscriptItem; text: string };
export type KiroTranscript = Awaited<ReturnType<typeof readKiroTranscript>>;
function knownKeys(record: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(record).every(key => allowed.includes(key));
}

/** The v1 chat-store projection is deliberately independent of the ACP runtime.
 * Tool arguments and private reasoning never become searchable text. */
export async function readKiroTranscript(root: string, id: string, signal: AbortSignal) {
  const metadata = await readKiroMetadata(root, id, signal);
  const transcriptPath = join(root, `${id}.jsonl`);
  const exists = await stat(transcriptPath).catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  // Native metadata can precede the first turn. Search remains partial until
  // the body file exists; transcript admission must not claim complete history.
  if (!exists) return { metadata, rows: [] as VisibleRow[], partial: true, missing: true };
  const filePath = await confinedKiroFile(root, transcriptPath, signal);
  const tools = new Map<string, string>();
  const rows: VisibleRow[] = [];
  let partial = false;
  const fallbackTime = parseTimestampMs(metadata.record.created_at) ?? 0;
  const unsupported = (itemId: string, timestamp: number) => {
    partial = true;
    rows.push({ item: createExternalSessionUnsupportedTranscriptItem({ agentId: 'kiro', id: itemId, createdAtMs: timestamp }), text: '' });
  };
  const scan = await readJsonlFileForwardLines({
    filePath, offsetBytes: 0,
    // Whole-replacement native dialect: scan the captured file, not a preview.
    // The SDK streams source records; output paging applies the caller budget.
    maxBytes: Math.max(1, exists.size), maxItems: Math.max(1, exists.size),
    onDiagnostic() { partial = true; },
    onLine(line) {
      signal.throwIfAborted();
      const rowId = `kiro-chat-v1:${id}:${line.startOffsetBytes}`;
      const record = line.value;
      const data = isRecord(record) && isRecord(record.data) ? record.data : null;
      const timestamp = data && isRecord(data.meta) ? parseTimestampMs(data.meta.timestamp) ?? fallbackTime : fallbackTime;
      if (!isRecord(record) || record.version !== 'v1' || !knownKeys(record, ['version', 'kind', 'data'])
        || !data || !knownKeys(data, ['content', 'meta']) || !Array.isArray(data.content)
        || (data.meta !== undefined && (!isRecord(data.meta) || !knownKeys(data.meta, ['timestamp'])))
        || !['Prompt', 'AssistantMessage', 'ToolResults'].includes(String(record.kind))) {
        unsupported(rowId, timestamp); return;
      }
      let index = 0;
      for (const block of data.content) {
        const itemId = `${rowId}:${index++}`;
        if (!isRecord(block) || !knownKeys(block, ['kind', 'data'])) { unsupported(itemId, timestamp); continue; }
        if (block.kind === 'thinking') continue;
        if (block.kind === 'text' && typeof block.data === 'string' && record.kind !== 'ToolResults') {
          const text = block.data;
          rows.push({ text, item: record.kind === 'Prompt'
            ? { id: itemId, createdAtMs: timestamp, messageRole: 'user', raw: { role: 'user', content: { type: 'text', text } } }
            : { id: itemId, createdAtMs: timestamp, messageRole: 'agent', raw: { role: 'agent', content: { type: 'acp', agentId: 'kiro', data: { type: 'message', message: text } } } } });
        } else if (block.kind === 'toolUse' && record.kind === 'AssistantMessage' && isRecord(block.data)
          && knownKeys(block.data, ['toolUseId', 'name', 'input'])
          && typeof block.data.toolUseId === 'string' && typeof block.data.name === 'string') {
          const callId = block.data.toolUseId;
          const name = block.data.name;
          tools.set(callId, name);
          rows.push({ text: '', item: { id: itemId, createdAtMs: timestamp, messageRole: 'event', raw: { role: 'agent', content: {
            type: 'acp', agentId: 'kiro', data: { type: 'tool-call', callId, name, input: {} },
          } } } });
        } else if (block.kind === 'toolResult' && record.kind === 'ToolResults' && isRecord(block.data)
          && knownKeys(block.data, ['toolUseId', 'content'])
          && typeof block.data.toolUseId === 'string' && tools.has(block.data.toolUseId) && Array.isArray(block.data.content)) {
          const text: string[] = [];
          let unknown = false;
          for (const result of block.data.content) {
            if (isRecord(result) && knownKeys(result, ['kind', 'data']) && result.kind === 'text' && typeof result.data === 'string') text.push(result.data);
            else if (isRecord(result) && knownKeys(result, ['kind', 'data']) && result.kind === 'json') text.push(JSON.stringify(result.data));
            else unknown = true;
          }
          const output = text.join('\n');
          rows.push({ text: output, item: { id: itemId, createdAtMs: timestamp, messageRole: 'event', raw: { role: 'agent', content: {
            type: 'acp', agentId: 'kiro', data: { type: 'tool-result', callId: block.data.toolUseId, output },
          } } } });
          if (unknown) unsupported(`${itemId}:unsupported`, timestamp);
        } else unsupported(itemId, timestamp);
      }
    },
  });
  signal.throwIfAborted();
  if (!scan.reachedEnd || scan.truncated || scan.diagnostics?.length) partial = true;
  return { metadata, rows, partial, missing: false };
}

/** Prefix digest is source integrity evidence for append vs rewrite, not an
 * additional persisted index. Positions remain native byte/block locators. */
export function kiroPrefixIdentity(transcript: KiroTranscript, end: number) {
  // Metadata titles/activity can change on every turn without replacing the
  // body. Only the actual visible prefix determines append continuity.
  return digest(JSON.stringify(transcript.rows.slice(0, end)));
}
