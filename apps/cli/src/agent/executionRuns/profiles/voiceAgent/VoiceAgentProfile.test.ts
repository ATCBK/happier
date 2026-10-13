import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { VoiceAgentTurnV1Schema } from '@happier-dev/protocol/messages/structured/voiceAgentTurnV1';

import { configuration, reloadConfiguration } from '@/configuration';
import { writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

import { VoiceAgentProfile } from './VoiceAgentProfile';

describe('VoiceAgentProfile', () => {
  const origin = 'http://voice-replay.test';
  let app: ReturnType<typeof Fastify>;
  let restoreHttp: (() => void) | undefined;
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_HOME_DIR', 'HAPPIER_TOKEN', 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let home: string;

  beforeEach(async () => {
    app = Fastify();
    home = await createTempDir('happier-voice-profile-');
    envScope = createEnvKeyScope(envKeys);
    envScope.patch({ HAPPIER_SERVER_URL: origin, HAPPIER_HOME_DIR: home,
      HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined });
    reloadConfiguration();
  });

  afterEach(async () => {
    restoreHttp?.();
    restoreHttp = undefined;
    await app.close();
    envScope.restore();
    reloadConfiguration();
    await removeTempDir(home);
  });

  it('keeps voice-agent sidechain text unchanged and exposes actions only for a voice controller', () => {
    expect(VoiceAgentProfile.transcriptMaterialization).toBe('none');
    expect(VoiceAgentProfile.emitFinalSidechainMessageWhenStreamed).toBeUndefined();
    expect(VoiceAgentProfile.computeSidechainStreamText?.({ fullText: 'Voice prose' })).toBe('Voice prose');

    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'voice_agent',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'listen',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      startedAtMs: 1,
    } as const;

    expect(VoiceAgentProfile.listAvailableActionIds?.({ start, controllerKind: 'voice_agent' })).toEqual([
      'voice_agent.welcome',
      'voice_agent.commit',
    ]);
    expect(VoiceAgentProfile.listAvailableActionIds?.({ start, controllerKind: null })).toEqual([]);
  });

  it('keeps bounded completion summaries stable for voice output', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'voice_agent',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'listen',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      startedAtMs: 1,
    } as const;

    const result = VoiceAgentProfile.onBoundedComplete({ start, rawText: '  Hello there  ', finishedAtMs: 2 });
    expect(result.status).toBe('succeeded');
    expect(result.summary).toBe('Hello there');
  });

  it('merges replay seed context and upgrades ready-handshake bootstraps to first-turn mode', async () => {
    await writeCredentialsTokenOnlyForServerId(configuration.activeServerId, { token: 'credential-token' });
    app.get('/v2/sessions/sess_voice', () => V2SessionByIdResponseSchema.parse({
      session: createSessionRecordFixture({
        id: 'sess_voice', seq: 2, encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'voice', path: '/tmp/voice-agent' }),
      }),
    }));
    app.get('/v1/sessions/sess_voice/messages', () => SessionMessagesPageV1Schema.parse({
      messages: [
        { text: 'Keep the earlier useful conversation.', epoch: 4 },
        { text: 'Discarded conversation from another transcript epoch.', epoch: 3 },
      ].map(({ text, epoch }, index) => ({
        id: `voice-message-${index}`, seq: index + 1, createdAt: index + 1,
        content: { t: 'plain', v: {
          role: 'user', content: { type: 'text', text },
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: VoiceAgentTurnV1Schema.parse({
            v: 1, epoch, role: 'user', voiceAgentId: 'voice-agent-1', ts: index + 1,
          }) } },
        } },
      })),
      hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
    }));
    app.get('/v2/sessions/sess_voice/system-records/latest', () => ({ record: null }));
    await app.ready();
    restoreHttp = installAxiosFastifyAdapter({ app, origin });

    const request = {
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Listen.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      initialContext: 'Operator supplied context.',
      bootstrapMode: 'ready_handshake',
      replay: { kind: 'voice_session.v1', previousSessionId: 'sess_voice', transcriptEpoch: 4 },
    } satisfies Parameters<NonNullable<typeof VoiceAgentProfile.prepareStartParams>>[0]['request'];

    const prepared = await VoiceAgentProfile.prepareStartParams?.({ cwd: '/tmp/voice-agent', request });

    expect(prepared?.initialContextMode).toBe('first_turn');
    expect(prepared?.initialContext).toMatch(/^Operator supplied context\.\n\n/);
    expect(prepared?.initialContext).toContain('Keep the earlier useful conversation.');
    expect(prepared?.initialContext).not.toContain('Discarded conversation');

    // The same real reader cannot seed a different epoch or unavailable source.
    await expect(VoiceAgentProfile.prepareStartParams?.({
      cwd: '/tmp/voice-agent', request: { ...request, replay: { ...request.replay, transcriptEpoch: 9 } },
    })).resolves.toBeUndefined();
    await expect(VoiceAgentProfile.prepareStartParams?.({
      cwd: '/tmp/voice-agent', request: { ...request, replay: { ...request.replay, previousSessionId: 'missing-session' } },
    })).resolves.toBeUndefined();
  });
});
