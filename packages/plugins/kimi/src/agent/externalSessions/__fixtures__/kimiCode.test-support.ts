import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Sanitised dialect vectors: Kimi Code 0.18.0, protocol 1.4.
// MoonshotAI/kimi-code@e6c2f51fa3ed471e983a6dc4b2977709c62a9200:
// agent-core/src/{agent/records/types,loop/events,services/message/transcript}.ts.
// Layout corroborated by upstream commit a18b44bfc0 Kimi 0.18 fixture.
export const kimiUser = (text: string, origin = 'user') => ({ type: 'context.append_message',
  time: 1_792_488_000_000, message: { role: 'user', content: [{ type: 'text', text }],
    toolCalls: [], origin: { kind: origin, ...(origin === 'injection' ? { variant: 'fixture' } : {}) } } });
export const kimiLoop = (event: Record<string, unknown>) => ({ type: 'context.append_loop_event', time: 1_792_488_000_001, event });
export const kimiAnswer = (text: string, uuid = 'step-1') => [
  kimiLoop({ type: 'step.begin', uuid, turnId: 'turn-1', step: 1 }),
  kimiLoop({ type: 'content.part', uuid: `${uuid}-part`, stepUuid: uuid, turnId: 'turn-1', step: 1, part: { type: 'text', text } }),
  kimiLoop({ type: 'step.end', uuid, turnId: 'turn-1', step: 1, finishReason: 'end_turn' }),
];
export const kimiMetadata = { type: 'metadata', protocol_version: '1.4', created_at: 1_792_488_000_000 };
export const kimiWire = (records: readonly unknown[]) => records.map(row => JSON.stringify(row)).join('\n') + '\n';

export async function writeKimiFixture(home: string, id = 'session_fixture', records: readonly unknown[] = [
  kimiMetadata, kimiUser('A short question'), ...kimiAnswer('x'.repeat(500) + ' body-only phrase 你好 café\n"quoted"'),
  kimiUser('injected-only needle', 'injection'),
  kimiLoop({ type: 'step.begin', uuid: 'tools', turnId: 'turn-1', step: 2 }),
  kimiLoop({ type: 'tool.call', uuid: 'call', turnId: 'turn-1', step: 2, stepUuid: 'tools', toolCallId: 'call-1', name: 'read', args: { path: 'metadata-only needle' } }),
  kimiLoop({ type: 'tool.result', toolCallId: 'call-1', parentUuid: 'call', result: { output: 'visible tool output', isError: false } }),
  kimiLoop({ type: 'step.end', uuid: 'tools', turnId: 'turn-1', step: 2 }),
]) {
  const sessionDir = join(home, 'sessions', 'wd_fixture_123', id);
  const agentDir = join(sessionDir, 'agents', 'main');
  await mkdir(agentDir, { recursive: true });
  const statePath = join(sessionDir, 'state.json');
  const wirePath = join(agentDir, 'wire.jsonl');
  await writeFile(statePath, JSON.stringify({ title: 'Unrelated title', createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z', agents: { main: { homedir: agentDir, type: 'main', parentAgentId: null } } }));
  await appendFile(join(home, 'session_index.jsonl'), kimiWire([{ sessionId: id, sessionDir, workDir: '/fixture' }]));
  await writeFile(wirePath, kimiWire(records));
  return { statePath, wirePath, sessionDir };
}
