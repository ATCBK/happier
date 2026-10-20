import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionUnsupportedTranscriptItem } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { record, type AuggieSession } from './source.js';

export type AuggieProjection = Readonly<{ items: readonly AgentExternalSessionTranscriptItem[]; unsupportedIds: ReadonlySet<string>; partial: boolean; cwd?: string }>;
/** The persisted history is already the vendor's active snapshot. Never merge
 * backups or summarizations back into it; every read reconstructs this snapshot. */
export function projectAuggieTranscript(session: AuggieSession, signal: AbortSignal): AuggieProjection {
  const items: AgentExternalSessionTranscriptItem[] = []; let partial = false; let cwd: string | undefined;
  const ids = new Set<string>();
  const unsupportedIds = new Set<string>();
  const unsupported = (id: string, at = session.createdAtMs) => {
    partial = true; unsupportedIds.add(id); items.push(createExternalSessionUnsupportedTranscriptItem({ agentId: 'auggie', id, localId: id, createdAtMs: at }));
  };
  const text = (id: string, body: string, role: 'user' | 'agent', createdAtMs: number) => {
    if (!body) return;
    items.push({ id, localId: id, createdAtMs, messageRole: role, raw: role === 'user'
      ? { role: 'user', content: { type: 'text', text: body } }
      : { role: 'agent', content: { type: 'acp', agentId: 'auggie', data: { type: 'message', message: body } } } });
  };
  session.history.forEach((entry, index) => {
    signal.throwIfAborted();
    if (!record(entry) || !record(entry.exchange) || typeof entry.completed !== 'boolean'
      || typeof entry.sequenceId !== 'number' || !Number.isFinite(entry.sequenceId)
      || typeof entry.exchange.request_id !== 'string' || !entry.exchange.request_id
      || typeof entry.finishedAt !== 'string' || !Number.isFinite(Date.parse(entry.finishedAt))) { unsupported(`unsupported:${index}`); return; }
    const exchange = entry.exchange; const key = `${exchange.request_id}:${entry.sequenceId}`;
    if (ids.has(key)) { unsupported(`duplicate:${index}`); return; } ids.add(key);
    const at = Date.parse(entry.finishedAt);
    if (!entry.completed) partial = true;
    if (entry.isHistorySummary === true) { unsupported(`${key}:summary`, at); return; }
    for (const [side, role] of [['request', 'user'], ['response', 'agent']] as const) {
      const nodes: unknown = exchange[`${side}_nodes`];
      const fallback: unknown = exchange[side === 'request' ? 'request_message' : 'response_text'];
      if (nodes !== undefined && !Array.isArray(nodes)) { unsupported(`${key}:${side}:nodes`, at); continue; }
      let hasText = false; const nativeIds = new Set<number>();
      let textRun: { id: string; body: string } | null = null;
      const flushText = () => { if (textRun) text(textRun.id, textRun.body, role, at); textRun = null; };
      if (Array.isArray(nodes)) for (let n = 0; n < nodes.length; n++) {
        const node: unknown = nodes[n]; const id = `${key}:${side}:${record(node) ? String(node.id) : n}`;
        if (!record(node) || typeof node.id !== 'number' || !Number.isFinite(node.id) || nativeIds.has(node.id)) { flushText(); unsupported(`${id}:unsupported`, at); continue; }
        nativeIds.add(node.id);
        if (node.type !== 0) flushText();
        if (node.type === 0) {
          hasText = true;
          const body = side === 'request' && record(node.text_node) ? node.text_node.content : side === 'response' ? node.content : undefined;
          if (typeof body !== 'string') { flushText(); unsupported(id, at); }
          else if (textRun) textRun.body += body;
          else textRun = { id, body };
        } else if (side === 'request' && node.type === 1 && record(node.tool_result_node)
          && typeof node.tool_result_node.content === 'string' && typeof node.tool_result_node.tool_use_id === 'string') {
          items.push({ id, localId: id, createdAtMs: at, messageRole: 'event', raw: { role: 'agent', content: { type: 'acp', agentId: 'auggie',
            data: { type: 'tool-result', callId: node.tool_result_node.tool_use_id, output: node.tool_result_node.content,
              ...(node.tool_result_node.is_error === true ? { isError: true } : {}) } } } });
        } else if (side === 'request' && node.type === 4 && record(node.ide_state_node)) {
          const folders = node.ide_state_node.workspace_folders;
          if (!cwd && Array.isArray(folders) && record(folders[0])) {
            const folder: unknown = folders[0].repository_root ?? folders[0].folder_root; if (typeof folder === 'string') cwd = folder;
          }
        } else if (side === 'response' && ((node.type === 5 && record(node.tool_use)
          && typeof node.tool_use.tool_use_id === 'string' && typeof node.tool_use.tool_name === 'string')
          || (node.type === 8 && record(node.thinking)) || (node.type === 9 && record(node.billing_metadata))
          || (node.type === 10 && record(node.token_usage)))) {
          // Tool input, thinking, model/usage and finalization are not body text.
        } else if (side === 'request' && node.type === 10) unsupported(id, at);
        else unsupported(id, at);
      }
      flushText();
      if (!hasText) {
        if (typeof fallback === 'string') text(`${key}:${side}:fallback`, fallback, role, at);
        else if (fallback !== undefined) unsupported(`${key}:${side}:fallback`, at);
      }
    }
  });
  return { items, unsupportedIds, partial, ...(cwd ? { cwd } : {}) };
}
export function auggieSearchText(item: AgentExternalSessionTranscriptItem): string | null {
  if (item.raw.role === 'user') return item.raw.content.text;
  const content = item.raw.content;
  if (!record(content) || !record(content.data)) return null;
  return content.data.type === 'message' && typeof content.data.message === 'string' ? content.data.message
    : content.data.type === 'tool-result' && typeof content.data.output === 'string' ? content.data.output : null;
}
