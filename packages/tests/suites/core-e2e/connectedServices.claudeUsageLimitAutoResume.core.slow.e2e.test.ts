import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ConnectedAccountServiceKeyIngressSchema, SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol';
import { createRecoveryIntentFileStore } from '../../../../apps/cli/src/daemon/connectedServices/recoveryScheduler/recoveryIntentFileStore';
import { buildRuntimeAuthRecoveryKey } from '../../../../apps/cli/src/daemon/connectedServices/runtimeAuth/runtimeAuthRecoveryKey';
import type { RuntimeAuthRecoveryIntent } from '../../../../apps/cli/src/daemon/connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';

import {
  CLAUDE_CODE_E2E_OAUTH_SCOPE,
  CLAUDE_SUBSCRIPTION_SERVICE_ID,
  asRecord as record,
  createConnectedServiceProfile,
  readRuntimeAuthRecoveryIntent,
  readQualifiedConnectedServiceCredential,
  recoveryIntentPath,
  spawnConnectedClaudeSession,
  startConnectedServiceRecoveryTokenServer,
  startConnectedServicesClaudeDaemon,
  type ConnectedServiceRecoveryTokenServer,
  type StartedConnectedServicesClaudeDaemonFixture,
} from '../../src/testkit/connectedServicesRecovery';
import { fakeClaudeFixturePath, readFakeClaudeLogEvents as providerEvents } from '../../src/testkit/fakeClaude';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { sleep, waitFor } from '../../src/testkit/timing';

// Real source daemon, relay, durable scheduler, Pending admission and Agent SDK.
// Only the Claude executable and OAuth service are boundary fixtures.
const run = createRunDirs({ runLabel: 'core' });
const providerAcceptTimeoutMs = 60_000;

describe('core e2e: Claude due usage-limit continuation', () => {
  let fixture: StartedConnectedServicesClaudeDaemonFixture | null = null;
  let tokenServer: ConnectedServiceRecoveryTokenServer | null = null;
  let rpcSocket: SocketCollector | null = null;

  afterEach(async () => {
    rpcSocket?.close();
    rpcSocket = null;
    await fixture?.daemon.stop().catch(() => {});
    await fixture?.server.stop().catch(() => {});
    await tokenServer?.stop().catch(() => {});
    fixture = null;
    tokenServer = null;
  }, 60_000);

  async function startLimitedSession(options: { resumePromptMode?: 'standard' | 'custom' | 'off'; resetDelayMs?: number } = {}): Promise<{ sessionId: string; initialPrompt: string; runnerPid: number }> {
    const testDir = run.testDir(`claude-usage-limit-${randomUUID()}`);
    tokenServer = await startConnectedServiceRecoveryTokenServer({
      respond: () => ({ status: 200, body: {
        access_token: 'claude-usage-limit-access', refresh_token: 'claude-usage-limit-refresh',
        expires_in: 3600, token_type: 'Bearer', scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
      } }),
    });
    fixture = await startConnectedServicesClaudeDaemon({
      testDir, testName: 'claude-usage-limit-auto-resume', tokenUrl: tokenServer.tokenUrl,
      fakeClaudePath: fakeClaudeFixturePath(), fakeClaudeLogPath: resolve(testDir, 'fake-claude.jsonl'),
      fakeClaudeScenario: 'usage-limit-once',
      accountSettings: {
        claudeUnifiedTerminalEnabled: false,
        usageLimitRecoverySettingsV1: {
          resumePromptMode: options.resumePromptMode ?? 'standard',
          customResumePrompt: 'Continue the interrupted Claude work carefully.',
        },
      },
      serverExtraEnv: { HAPPIER_FEATURE_SESSIONS_USAGE_LIMIT_RECOVERY__ENABLED: '1' },
      extraEnv: {
        HAPPIER_FEATURE_SESSIONS_USAGE_LIMIT_RECOVERY__ENABLED: '1',
        HAPPIER_E2E_FAKE_CLAUDE_RESET_DELAY_MS: String(options.resetDelayMs ?? 10000),
        HAPPIER_E2E_FAKE_CLAUDE_CONTINUATION_ACCEPT_SIGNAL: resolve(testDir, 'fake-claude.jsonl.accept'),
        HAPPIER_E2E_FAKE_CLAUDE_CONTINUATION_ACCEPT_TIMEOUT_MS: String(providerAcceptTimeoutMs),
      },
    });
    await createConnectedServiceProfile({
      fixture, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: 'work',
      qualifiedCredential: true,
      providerEmail: 'claude-usage-limit@example.test', idToken: null,
      accessToken: 'claude-usage-limit-access', refreshToken: 'claude-usage-limit-refresh',
      scope: CLAUDE_CODE_E2E_OAUTH_SCOPE, tokenType: 'Bearer',
      providerAccountId: 'acct-claude-usage-limit', expiresAt: Date.now() + 3600_000,
    });
    const sessionId = await spawnConnectedClaudeSession({ fixture, sessionId: randomUUID(), profileId: 'work' });
    const initialPrompt = `CLAUDE_INTERRUPTED_WORK_${randomUUID()}`;
    const initialLocalId = randomUUID();
    const initialAdmission = await enqueuePendingQueueV2({
      baseUrl: fixture.serverBaseUrl, token: fixture.auth.token, sessionId,
      localId: initialLocalId, messageRole: 'user', requestedAction: { v: 1, kind: 'send_now' },
      ciphertext: encryptLegacyBase64({
        role: 'user', content: { type: 'text', text: initialPrompt }, localId: initialLocalId,
        meta: { source: 'ui', sentFrom: 'e2e' },
      }, fixture.accountSecret),
    });
    expect(initialAdmission.status).toBe(200);
    await waitFor(async () => {
      const session = await fetchSessionV2(fixture!.serverBaseUrl, fixture!.auth.token, sessionId);
      const intent = await readIntent(sessionId);
      const metadata = record(decryptLegacyBase64Normalized(session.metadata, fixture!.accountSecret));
      const projection = SessionUsageLimitRecoveryV1Schema.safeParse(metadata?.sessionUsageLimitRecoveryV1);
      return session.latestTurnStatus === 'failed' && session.lastRuntimeIssue?.source === 'usage_limit'
        && intent?.status === 'waiting' && projection.success
        && projection.data.runtimeAuthRecoveryAttemptId === intent.attemptId;
    }, { timeoutMs: 60_000, context: 'SDK failure reaches durable wait and failed canonical turn' });
    const listed = await daemonControlPostJson<{ children?: Array<{ happySessionId?: string; pid?: number }> }>({
      port: fixture.daemonPort, path: '/list', controlToken: fixture.controlToken, body: {},
    });
    const child = listed.data.children?.find((item) => item.happySessionId === sessionId);
    if (typeof child?.pid !== 'number') throw new Error(`Missing healthy Claude runner: ${JSON.stringify(listed.data)}`);
    return { sessionId, initialPrompt, runnerPid: child.pid };
  }

  async function readIntent(sessionId: string) {
    if (!fixture) throw new Error('Missing Claude fixture');
    return readRuntimeAuthRecoveryIntent({
      fixture, sessionId, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: 'work', groupId: null,
    });
  }

  async function recoveryDiagnostics(sessionId: string): Promise<string> {
    const current = fixture!;
    const session = await fetchSessionV2(current.serverBaseUrl, current.auth.token, sessionId);
    const metadata = record(decryptLegacyBase64Normalized(session.metadata, current.accountSecret));
    const issue = session.lastRuntimeIssue;
    const intent = await readIntent(sessionId);
    return JSON.stringify({
      sessionId, latestTurnStatus: session.latestTurnStatus,
      issue: issue ? {
        source: issue.source, agentId: issue.agentId, agentTurnId: issue.agentTurnId,
        occurredAt: issue.occurredAt, resetAtMs: issue.usageLimit?.resetAtMs,
        connectedService: issue.usageLimit?.connectedService,
      } : null,
      bindings: metadata?.connectedServices,
      projectedRecovery: metadata?.sessionUsageLimitRecoveryV1,
      durableRecovery: intent ? {
        status: intent.status, armedAtMs: intent.armedAtMs, attemptId: intent.attemptId,
        lastError: intent.lastError, terminalReason: intent.terminalReason,
        classification: intent.classification,
      } : null,
    });
  }

  async function connectRpc(): Promise<SocketCollector> {
    if (!fixture) throw new Error('Missing Claude fixture');
    rpcSocket = createUserScopedSocketCollector(fixture.serverBaseUrl, fixture.auth.token);
    rpcSocket.connect();
    await waitFor(() => rpcSocket!.isConnected(), { timeoutMs: 20_000, context: 'recovery control transport connected' });
    return rpcSocket;
  }

  async function callRpc(targetId: string, method: string, sessionId: string, request: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    if (!fixture || !rpcSocket) throw new Error('Missing recovery RPC transport');
    const ack = await rpcSocket.rpcCall<{ ok?: boolean; result?: string; errorCode?: string; error?: string }>(
      `${targetId}:${method}`, encryptLegacyBase64({ ...request, sessionId }, fixture.accountSecret), 60_000,
      { kind: 'session.write', sessionId },
    );
    return ack.ok === true && typeof ack.result === 'string'
      ? decryptLegacyBase64Normalized(ack.result, fixture.accountSecret)
      : ack;
  }

  async function waitPastReset(sessionId: string): Promise<void> {
    const intent = await readIntent(sessionId);
    const resetAtMs = record(intent?.classification)?.resetsAtMs;
    if (typeof resetAtMs !== 'number') throw new Error(`Missing reset: ${JSON.stringify(intent)}`);
    await sleep(Math.max(0, resetAtMs - Date.now()));
  }

  async function checkNowThroughCli(sessionId: string, resumePromptMode: 'custom' | 'off', label: string): Promise<unknown> {
    const current = fixture!;
    const testDir = dirname(current.fakeClaudeLogPath);
    const env = { ...process.env, CI: '1', HAPPIER_HOME_DIR: current.daemonHomeDir,
      HAPPIER_SERVER_URL: current.serverBaseUrl, HAPPIER_WEBAPP_URL: current.serverBaseUrl,
      HAPPIER_ACTIVE_SERVER_ID: current.serverId };
    const launch = await resolveCliTestLaunchSpec({ testDir, env }, { snapshotDir: resolve(testDir, 'cli-source'), preferSourceEntrypoint: true });
    const stdoutPath = resolve(testDir, `${label}.stdout.log`);
    await runLoggedCommand({ command: launch.command,
      args: [...launch.args, 'session', 'actions', 'execute', sessionId, 'session.usageLimit.checkNow',
        '--input-json', JSON.stringify({ sessionId, resumePromptMode }), '--json'],
      cwd: launch.cwd ?? testDir, env: { ...env, ...launch.env }, stdoutPath,
      stderrPath: resolve(testDir, `${label}.stderr.log`), timeoutMs: providerAcceptTimeoutMs,
    });
    return JSON.parse(await readFile(stdoutPath, 'utf8')) as unknown;
  }

  async function deferTimerPastManualObservation(sessionId: string): Promise<void> {
    const current = fixture!;
    const store = createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(recoveryIntentPath(current));
    const waiting = await readIntent(sessionId);
    const fingerprint = record(waiting?.classification)?.failingAccessTokenFingerprint;
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId,
      serviceId: ConnectedAccountServiceKeyIngressSchema.parse(CLAUDE_SUBSCRIPTION_SERVICE_ID),
      profileId: 'work',
      groupId: null,
      failingAccessTokenFingerprint: typeof fingerprint === 'string' ? fingerprint : null,
    });
    await store.transact!(recoveryKey, ({ intent, effectClaimToken }) => {
      if (!intent || intent.status !== 'waiting' || effectClaimToken) throw new Error('Expected an unclaimed waiting recovery');
      // Exercise a due provider reset before the local scheduled wake, using the real durable owner.
      return { intent: { ...intent, nextRetryAtMs: Date.now() + providerAcceptTimeoutMs }, effectClaimToken, result: undefined };
    });
  }

  async function expectContinued(sessionId: string, expectedProofRevision?: string): Promise<void> {
    const current = fixture!;
    try {
      await waitFor(async () => {
        const intent = await readIntent(sessionId);
        if (intent?.status === 'cancelled' || intent?.status === 'exhausted') {
          throw new Error('Due Claude recovery terminalized');
        }
        return intent?.status === 'resumed_awaiting_proof';
      }, { timeoutMs: 60_000, shouldRetryOnError: () => false, context: 'Pending continuation waits for provider outcome proof' });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; recovery=${await recoveryDiagnostics(sessionId)}`, { cause: error });
    }
    if (expectedProofRevision) {
      expect(await readIntent(sessionId)).toMatchObject({
        pendingTargetProfileId: 'work', pendingTargetCredentialRevision: expectedProofRevision,
      });
    }
    expect((await providerEvents(current.fakeClaudeLogPath)).filter((event) => event.type === 'sdk_continuation_accepted')).toHaveLength(0);
    await writeFile(`${current.fakeClaudeLogPath}.accept`, 'accept\n', 'utf8');
    await waitFor(async () => (await providerEvents(current.fakeClaudeLogPath)).some((event) => event.type === 'sdk_continuation_accepted'), {
      timeoutMs: providerAcceptTimeoutMs, context: 'due continuation accepted by Claude SDK boundary',
    });
    await waitFor(async () => (await readIntent(sessionId))?.status === 'recovered', {
      timeoutMs: 20_000, context: 'provider activity settles recovery',
    });
    if (expectedProofRevision) expect((await readIntent(sessionId))?.pendingTargetCredentialRevision).toBe(expectedProofRevision);
    const events = await providerEvents(current.fakeClaudeLogPath);
    const failure = events.find((event) => event.type === 'sdk_usage_limit');
    const accepted = events.filter((event) => event.type === 'sdk_continuation_accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.sessionId).toBe(failure?.sessionId);
    const rows = await fetchMessagesSince({ baseUrl: current.serverBaseUrl, token: current.auth.token, sessionId, afterSeq: 0 });
    expect(rows.filter((row) => row.localId?.startsWith('connected-service-continuation:'))).toHaveLength(1);
  }

  async function expectNoSyntheticAdmission(sessionId: string): Promise<void> {
    const current = fixture!;
    const query = { baseUrl: current.serverBaseUrl, token: current.auth.token, sessionId };
    const [messages, pending] = await Promise.all([
      fetchMessagesSince({ ...query, afterSeq: 0 }),
      listPendingQueueV2({ ...query, includeDiscarded: true }),
    ]);
    expect(messages.some((row) => row.localId?.startsWith('connected-service-continuation:'))).toBe(false);
    expect(pending.data.pending?.some((row) => row.localId.startsWith('connected-service-continuation:'))).toBe(false);
  }

  async function rotateQuotaAccountCredential() {
    const current = fixture!;
    const snapshotA = await readQualifiedConnectedServiceCredential({ fixture: current,
      serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: 'work' });
    expect(snapshotA.revisionSemantics).toBe('revisioned');
    if (snapshotA.revisionSemantics !== 'revisioned') throw new Error('Expected a fenced V4 fixture credential');
    const revisionB = await createConnectedServiceProfile({
      fixture: current, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: 'work', qualifiedCredential: true,
      expectedQualifiedCredentialRevision: snapshotA.credentialRevision,
      providerEmail: 'claude-usage-limit@example.test', providerAccountId: 'acct-claude-usage-limit', idToken: null,
      accessToken: 'claude-usage-limit-rotated-access', refreshToken: 'claude-usage-limit-rotated-refresh',
      scope: CLAUDE_CODE_E2E_OAUTH_SCOPE, tokenType: 'Bearer', expiresAt: Date.now() + 3600_000,
    });
    const snapshotB = await readQualifiedConnectedServiceCredential({ fixture: current,
      serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: 'work' });
    expect(snapshotB.credentialRevision).toBe(revisionB);
    expect(revisionB).not.toBe(snapshotA.credentialRevision);
    if (typeof revisionB !== 'string') throw new Error('Missing rotated V4 revision');
    return { revisionA: snapshotA.credentialRevision, revisionB };
  }

  it('continues the incumbent failed turn on revision A after the same quota account rotates to B', async () => {
    const { sessionId, initialPrompt, runnerPid } = await startLimitedSession({ resetDelayMs: 30_000 });
    const current = fixture!;
    const { revisionA, revisionB } = await rotateQuotaAccountCredential();
    expect(record((await readIntent(sessionId))?.classification)?.expectedCredentialRevision).toBe(revisionA);
    await expectContinued(sessionId, revisionA);
    expect((await readQualifiedConnectedServiceCredential({ fixture: current,
      serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: 'work' })).credentialRevision).toBe(revisionB);
    const events = await providerEvents(current.fakeClaudeLogPath);
    expect(events.filter((event) => event.type === 'sdk_stdin' && event.userTextPreview === initialPrompt)).toHaveLength(1);
    process.kill(runnerPid, 0);
  }, 360_000);

  it('activates a fresh runner on rotated revision B and settles proof from that provider thread', async () => {
    const { sessionId, runnerPid } = await startLimitedSession({ resetDelayMs: 30_000 });
    const { revisionA, revisionB } = await rotateQuotaAccountCredential();
    expect(record((await readIntent(sessionId))?.classification)?.expectedCredentialRevision).toBe(revisionA);
    // These PIDs belong exclusively to this fixture; disappearance is not a user Stop.
    const sdkPids = (await providerEvents(fixture!.fakeClaudeLogPath))
      .filter((event) => event.type === 'invocation' && event.mode === 'sdk')
      .map((event) => event.pid).filter((pid): pid is number => typeof pid === 'number');
    process.kill(runnerPid, 'SIGKILL');
    for (const pid of sdkPids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* SDK child may exit with its parent. */ }
    }
    await waitFor(async () => {
      const listed = await daemonControlPostJson<{ children?: Array<{ happySessionId?: string }> }>({
        port: fixture!.daemonPort, path: '/list', controlToken: fixture!.controlToken, body: {},
      });
      return !listed.data.children?.some((child) => child.happySessionId === sessionId);
    }, { timeoutMs: 20_000, context: 'fixture runner disappearance reaches the daemon lifecycle owner before reset' });
    await expectContinued(sessionId, revisionB);
    const listed = await daemonControlPostJson<{ children?: Array<{ happySessionId?: string; pid?: number }> }>({
      port: fixture!.daemonPort, path: '/list', controlToken: fixture!.controlToken, body: {},
    });
    const resumed = listed.data.children?.find((child) => child.happySessionId === sessionId);
    expect(resumed).toMatchObject({ pid: expect.any(Number) });
    expect(resumed?.pid).not.toBe(runnerPid);
  }, 360_000);

  it('executes public CLI Check now with an explicit custom override before the deferred timer', async () => {
    const { sessionId, runnerPid } = await startLimitedSession({ resumePromptMode: 'off' });
    await connectRpc();
    const live = record(await callRpc(sessionId, SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, sessionId));
    expect(live).toMatchObject({ ok: true, status: 'waiting' });
    expect((await readIntent(sessionId))?.resumePromptMode).toBe('off');
    await expectNoSyntheticAdmission(sessionId);
    await deferTimerPastManualObservation(sessionId);
    await waitPastReset(sessionId);
    expect((await readIntent(sessionId))?.status).toBe('waiting');
    await expectNoSyntheticAdmission(sessionId);
    const activeSession = await fetchSessionV2(fixture!.serverBaseUrl, fixture!.auth.token, sessionId);
    const activeMetadata = record(decryptLegacyBase64Normalized(activeSession.metadata, fixture!.accountSecret));
    expect(activeSession.active).toBe(true);
    expect(SessionUsageLimitRecoveryV1Schema.parse(activeMetadata?.sessionUsageLimitRecoveryV1).runtimeAuthRecoveryAttemptId)
      .toBe((await readIntent(sessionId))?.attemptId);
    // The public action routes an active daemon-owned Check now through MachineRPC admission.
    const checks = await Promise.all([
      checkNowThroughCli(sessionId, 'custom', 'manual-first'),
      checkNowThroughCli(sessionId, 'custom', 'manual-second'),
    ]);
    for (const check of checks) expect(check).toMatchObject({ ok: true, data: { result: { ok: true, status: 'waiting' } } });
    await expectContinued(sessionId);
    expect((await providerEvents(fixture!.fakeClaudeLogPath)).some((event) => event.type === 'sdk_stdin'
      && typeof event.userTextPreview === 'string'
      && event.userTextPreview.includes('Continue the interrupted Claude work carefully.'))).toBe(true);
    process.kill(runnerPid, 0);
  }, 360_000);

  it('admits fresh explicit instructions after reset without waking an obsolete continuation first', async () => {
    const { sessionId, runnerPid } = await startLimitedSession({ resetDelayMs: 30_000 });
    const current = fixture!;
    await deferTimerPastManualObservation(sessionId);
    await waitPastReset(sessionId);
    await connectRpc();
    const text = `NEWER_EXPLICIT_WORK_${randomUUID()}`;
    const localId = randomUUID();
    const sent = await callRpc(sessionId, SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, sessionId, {
      text, localId, meta: { source: 'ui' },
    });
    expect(sent).toMatchObject({ ok: true, providerAcceptancePending: true });
    await waitFor(async () => (await providerEvents(current.fakeClaudeLogPath)).some((event) =>
      event.type === 'sdk_stdin' && event.userTextPreview === text), {
      timeoutMs: providerAcceptTimeoutMs, context: 'fresh explicit instructions reach the provider once',
    });
    await writeFile(`${current.fakeClaudeLogPath}.accept`, 'accept');
    await waitFor(async () => (await fetchSessionV2(current.serverBaseUrl, current.auth.token, sessionId)).latestTurnStatus === 'completed', {
      timeoutMs: providerAcceptTimeoutMs, context: 'explicit instructions settle normally',
    });
    expect((await providerEvents(current.fakeClaudeLogPath)).filter((event) =>
      event.type === 'sdk_stdin' && event.userTextPreview === text)).toHaveLength(1);
    await expectNoSyntheticAdmission(sessionId);
    process.kill(runnerPid, 0);
  }, 360_000);
});
