import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { buildCodexAgentRuntimeDescriptorV1 } from '../../../../../packages/plugins/codex/src/protocol/runtimeDescriptorV1';
import { AgentNativeResumeIdentityV1Schema } from '@happier-dev/protocol/agents/nativeResumeIdentityV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createPlainAgentTextRow, createPlainUserRow } from '@/testkit/transcript/replayTranscriptCorpora';
import { respondTranscriptMessagesQueryRejection } from '@/testkit/transcript/transcriptMessagesRouteContract';
import { createReplayMessagesPage } from '@/session/replay/replayMessagesFixture.testkit';
import { buildBoundedActivationBrief } from './buildSessionAgentTransitionActivationBrief';

const SESSION_ID = 'sess_1';
const CREDENTIALS = { token: 'retrieval-account-token', encryption: null } as const;
const BEFORE_DEPARTURE_TEXT = 'The earlier instruction already held by the returning Agent.';
const DELTA_TEXT = 'The new instruction issued while the target Agent was away.';
const AFTER_HEAD_TEXT = 'A later turn outside the captured transcript head.';
const TRANSCRIPT_ROWS = [
  { ...createPlainUserRow({ seq: 10, text: BEFORE_DEPARTURE_TEXT }), messageRole: 'user' },
  { ...createPlainAgentTextRow({ seq: 20, text: 'Earlier completed work.' }), messageRole: 'agent' },
  { ...createPlainUserRow({ seq: 30, text: DELTA_TEXT }), messageRole: 'user' },
  { ...createPlainAgentTextRow({ seq: 42, text: 'Latest completed work.' }), messageRole: 'agent' },
  { ...createPlainUserRow({ seq: 43, text: AFTER_HEAD_TEXT }), messageRole: 'user' },
];
const session = createSessionRecordFixture({ id: SESSION_ID, seq: 43, encryptionMode: 'plain',
  metadata: JSON.stringify({ path: '/home/u/project' }), share: null });
let server: Server;
let serverUrl: string;
let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
const messageRequests: URL[] = [];

const LOG_ROOT = mkdtempSync(join(tmpdir(), 'happier-brief-log-'));
const NATIVE_LOG_PATH = join(LOG_ROOT, 'session.jsonl');
writeFileSync(NATIVE_LOG_PATH, '{}\n');

/**
 * A Codex source keeps a log too, but persists no path for it: the file is named
 * after the vendor resume id under the Agent's own date-partitioned sessions
 * root. Building a real one lets the pointer be proven end to end through the
 * catalog rather than against a stubbed resolver.
 */
const CODEX_VENDOR_RESUME_ID = '019e7cfd-2e3d-74f0-be76-b7459424f0a8';
const CODEX_ROOT = mkdtempSync(join(tmpdir(), 'happier-brief-codex-'));
const CODEX_HOME = join(CODEX_ROOT, 'codex-home');
const CODEX_ROLLOUT_PATH = join(
  CODEX_HOME,
  'sessions',
  '2026',
  '08',
  '17',
  `rollout-2026-08-17T10-00-00-${CODEX_VENDOR_RESUME_ID}.jsonl`,
);
mkdirSync(join(CODEX_HOME, 'sessions', '2026', '08', '17'), { recursive: true });
writeFileSync(CODEX_ROLLOUT_PATH, '{}\n');

beforeAll(async () => {
  // The actual HTTP readers, stored-content opener, replay walk and framer stay
  // live. Only Home's responses and native files belong to this fixture.
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${CREDENTIALS.token}`) {
      response.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url.pathname === '/v1/account/encryption/currentness') {
      response.end(JSON.stringify(createAccountEncryptionCurrentnessFixture()));
      return;
    }
    if (url.pathname === `/v2/sessions/${SESSION_ID}`) {
      response.end(JSON.stringify({ session }));
      return;
    }
    if (url.pathname === `/v1/sessions/${SESSION_ID}/messages`) {
      messageRequests.push(url);
      if (respondTranscriptMessagesQueryRejection(url.searchParams, response)) return;
      const beforeSeq = Number(url.searchParams.get('beforeSeq'));
      const limit = Number(url.searchParams.get('limit'));
      const roles = url.searchParams.get('roles')?.split(',');
      const eligible = TRANSCRIPT_ROWS.filter(row => row.seq < beforeSeq
        && (!roles || roles.includes(row.messageRole))).sort((left, right) => right.seq - left.seq);
      const messages = eligible.slice(0, limit);
      response.end(JSON.stringify(createReplayMessagesPage({ messages, hasMore: eligible.length > messages.length })));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: 'unsupported' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Retrieval Home fixture did not listen');
  serverUrl = `http://127.0.0.1:${address.port}`;
  runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
});

beforeEach(() => { messageRequests.length = 0; });
afterAll(async () => {
  const cleanup = await Promise.allSettled([
    runtime?.dispose(),
    server && new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  ]);
  rmSync(LOG_ROOT, { recursive: true, force: true });
  rmSync(CODEX_ROOT, { recursive: true, force: true });
  const errors = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, 'Retrieval fixture cleanup failed');
});

function codexMetadata(vendorResumeId: string) {
  return {
    nativeResumeIdentityV1: AgentNativeResumeIdentityV1Schema.parse({ v: 1, vendorResumeId }),
    runtimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
      backendMode: 'appServer', providerSessionId: vendorResumeId, homePath: CODEX_HOME,
    }),
  };
}

async function buildWith(input: Readonly<{
  targetAgentId?: string;
  sourceAgentId?: string;
  metadata?: Record<string, unknown>;
  returningAgentLastSeenSeq?: number | null;
}> = {}): Promise<string> {
  const sourceMetadata = { path: '/home/u/project', ...(input.metadata ?? {}) };
  const result = await runWithServerHttpBaseUrl(serverUrl, () => buildBoundedActivationBrief({
    credentials: CREDENTIALS,
    accountSettings: null,
    sessionId: SESSION_ID,
    transcriptHeadSeqInclusive: 42,
    sourceMetadata,
    // The transition's basis: the Session is stopped on the source Agent, so its
    // current view still IS the departing Agent's. The read-only rebuild passes
    // `null` here instead, which is covered where that basis is decided.
    departingAgentCurrentView: sourceMetadata,
    ...(input.targetAgentId === undefined ? {} : { targetAgentId: input.targetAgentId }),
    ...(input.sourceAgentId === undefined ? {} : { sourceAgentId: input.sourceAgentId }),
    ...(input.returningAgentLastSeenSeq === undefined ? {} : { returningAgentLastSeenSeq: input.returningAgentLastSeenSeq }),
  }));
  expect(result).toMatchObject({ status: 'available', seed: { sourceSessionId: SESSION_ID, sourceCutoffSeqInclusive: 42 } });
  if (result.status !== 'available' || !result.seed) throw new Error('Real replay did not produce the activation brief');
  expect(result.seed.seedText).toContain(DELTA_TEXT);
  expect(result.seed.seedText).not.toContain(AFTER_HEAD_TEXT);
  return result.seed.seedText;
}

/**
 * Section 9's retrieval pointer, at the one owner that composes it. Both halves
 * are complementary — a source that kept no log leaves only the Happier
 * transcript, and a target reaching further back than the Session's window may
 * only get there through the log — so neither may be suppressed because the
 * other resolved.
 */
describe('buildBoundedActivationBrief — retrieval pointer', () => {
  it('renders an invocation for a target that is given Happier tools', async () => {
    const brief = await buildWith({ targetAgentId: 'codex' });
    const invocation = brief.split('\n').find(line => line.trimStart().startsWith('action_execute '))?.trim();
    expect(invocation).toBeDefined();
    const input = JSON.parse(invocation!.slice('action_execute '.length));
    expect(input).toMatchObject({ actionId: 'session.transcript.get', input: { sessionId: SESSION_ID, direction: 'before', cursor: null } });
  });

  it('hands down no pointer at all for a target the host gives no Happier tools', async () => {
    // Both runtime channels are gated on the same catalog declaration, so naming
    // one for an `unsupported` Agent would be a false instruction — and with no
    // native log either, there is nothing honest left to say.
    expect(await buildWith({ targetAgentId: 'unregistered-agent' })).not.toContain('More history:');
  });

  it('still hands down the native log for a target that cannot run Happier tools', async () => {
    const brief = await buildWith({
      targetAgentId: 'unregistered-agent',
      sourceAgentId: 'claude',
      metadata: { claudeSessionId: 'claude-1', claudeTranscriptPath: NATIVE_LOG_PATH },
    });
    expect(brief).not.toContain('action_execute ');
    expect(brief).toContain(NATIVE_LOG_PATH);
  });

  it('reads the native log through the catalog-declared proof slot, not a vendor key name', async () => {
    // `codex` declares no continuity proof field, so the same metadata key must
    // not become a log path just because it is present.
    const brief = await buildWith({
      targetAgentId: 'claude',
      sourceAgentId: 'codex',
      metadata: { ...codexMetadata('019e7cfd-0000-0000-0000-000000000000'),
        claudeSessionId: 'claude-1', claudeTranscriptPath: NATIVE_LOG_PATH },
    });
    expect(brief).toContain('action_execute ');
    expect(brief).not.toContain(NATIVE_LOG_PATH);
  });

  it('hands down the native log of a source Agent that derives the path instead of persisting it', async () => {
    // Codex declares no continuity-proof field, so the proof slot is empty and the
    // Session was handed over with no log at all. The path is still knowable from
    // the vendor resume id, and the Agent that knows how declares the derivation.
    const brief = await buildWith({
      targetAgentId: 'claude',
      sourceAgentId: 'codex',
      metadata: codexMetadata(CODEX_VENDOR_RESUME_ID),
    });
    expect(brief).toContain(CODEX_ROLLOUT_PATH);
    expect(brief).toContain('action_execute ');
  });

  it('names no derived native log when this machine holds no such file', async () => {
    const brief = await buildWith({
      targetAgentId: 'claude',
      sourceAgentId: 'codex',
      metadata: codexMetadata('019e7cfd-0000-0000-0000-000000000000'),
    });
    expect(brief).toContain('action_execute ');
    expect(brief).not.toContain(CODEX_HOME);
  });

  it('names no native log when the source Agent published no resume identity', async () => {
    const brief = await buildWith({
      targetAgentId: 'codex',
      sourceAgentId: 'claude',
      metadata: { claudeTranscriptPath: NATIVE_LOG_PATH },
    });
    expect(brief).toContain('action_execute ');
    expect(brief).not.toContain(NATIVE_LOG_PATH);
  });

  it('passes the canonical source Agent display title to the replay owner', async () => {
    expect(await buildWith({ targetAgentId: 'codex', sourceAgentId: 'claude' }))
      .toContain('- Original agent: Claude');
  });
});

/**
 * The delta boundary, at the seam where it leaves this owner (`AM-26`).
 *
 * A dropped boundary would hand the resumed Agent its old conversation again.
 * Observe the actual delivered text and the Home query, rather than capturing
 * an internal source descriptor that the replay owner might ignore.
 */
describe('buildBoundedActivationBrief — native-return delta boundary', () => {
  it('delivers only the native-return delta through the real replay owner', async () => {
    const brief = await buildWith({ targetAgentId: 'claude', sourceAgentId: 'codex', returningAgentLastSeenSeq: 20 });
    expect(brief).not.toContain(BEFORE_DEPARTURE_TEXT);
    expect(brief).not.toContain('Earlier completed work.');
    expect(brief).toContain('- Transcript seq when you last ran this session: 20');
    expect(messageRequests.length).toBeGreaterThan(0);
    for (const request of messageRequests) {
      expect(request.searchParams.get('beforeSeq')).toBe('43');
      // The Home route rejects an afterSeq/beforeSeq pair. The real replay
      // owner applies the departure bound after reading its backward page.
      expect(request.searchParams.has('afterSeq')).toBe(false);
    }
  });

  it.each([
    ['omitted', undefined],
    ['explicitly null', null],
  ])('delivers full context when the native-return boundary is %s', async (_label, returningAgentLastSeenSeq) => {
    const brief = await buildWith({ targetAgentId: 'claude', sourceAgentId: 'codex',
      ...(returningAgentLastSeenSeq === undefined ? {} : { returningAgentLastSeenSeq }),
    });
    expect(brief).toContain(BEFORE_DEPARTURE_TEXT);
    expect(brief).toContain('Earlier completed work.');
    expect(brief).not.toContain('- Transcript seq when you last ran this session:');
  });
});
