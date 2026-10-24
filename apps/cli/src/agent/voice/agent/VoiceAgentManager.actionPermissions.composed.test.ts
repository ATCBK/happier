import { afterEach, describe, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '../../../../../ui/sources/dev/testkit/fixtures/featureFixtures';
import { AccountSettingsV2UpdateRequestSchema, type AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createNativeSessionBoundary, createVoiceSessionRuntimeThroughNativeFactory } from '@/agent/runtime/bridges/executionRun/testkit/nativeSessionContext';
import { VoiceAgentManager } from './VoiceAgentManager';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { createVoiceToolHandlers } = await import('../../../../../ui/sources/voice/tools/handlers');
const { createDefaultActionExecutor } = await import('../../../../../ui/sources/sync/ops/actions/defaultActionExecutor');
const { settingsDefaults } = await import('../../../../../ui/sources/sync/domains/settings/settings');
afterEach(async () => { await home.reset(); });

describe('Voice Manager output through canonical client Action approval', () => {
  it('dispatches a Voice-only read through Manager output and the real client handler', async () => {
    await home.reset();
    const serverId = await home.addHome({ name: 'Voice-only read Home', serverUrl: 'https://voice-only-read.test',
      accountId: 'alice', currentAccount: true });
    const native = createNativeSessionBoundary();
    const runtime = createVoiceSessionRuntimeThroughNativeFactory({
      runtime: { sessions: { open: request => native.open(request) } }, modelId: 'voice-only-read',
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
    });
    const manager = new VoiceAgentManager({ createRuntime: () => runtime });
    try {
      const started = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        chatModelId: 'fixture', commitModelId: 'fixture', permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: '' });
      const turn = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'List my Homes' });
      await native.waitForInputs(1);
      native.complete('<voice_actions>{"actions":[{"t":"listServers","args":{}}]}</voice_actions>');
      const output = await turn;
      const action = output.actions?.[0];
      expect(action).toMatchObject({ t: 'listServers', args: {} });
      if (!action) throw new Error('Expected Voice-only Action');
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: serverId });
      const result = await handlers[action.t]!(action.args);
      expect(JSON.parse(result)).toMatchObject({ ok: true });
      expect(result).toContain(serverId);
    } finally { await manager.dispose(); }
  });

  it.each(['read-only', 'narrowed', 'default'] as const)('preserves %s admission through the real settings Action boundary', async mode => {
    await home.reset();
    const serverId = await home.addHome({ name: 'Voice Action permission', serverUrl: 'https://voice-action-permission.test',
      accountId: 'alice', currentAccount: true });
    const features = createRootLayoutFeaturesResponse();
    expect(tryWriteServerEnabledBitInPlace(features, 'voice', true)).toBe(true);
    home.answer(serverId, '/v1/features', { body: features });
    let content: Extract<AccountSettingsStoredContentEnvelope, { t: 'plain' }> = {
      t: 'plain', v: { voice: settingsDefaults.voice },
    };
    let version = 1;
    home.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { content, version } }) });
    home.answer(serverId, 'POST /v2/account/settings', { select: raw => {
      const request = AccountSettingsV2UpdateRequestSchema.parse(raw);
      expect(request.expectedVersion).toBe(version);
      if (!request.content || request.content.t !== 'plain') throw new Error('Expected plain Account fixture');
      content = request.content;
      return { body: { success: true, version: ++version } };
    } });
    // Only external Agent SDK and Home transports are scripted. Native input,
    // Voice parsing, client handlers, Action approval and settings writes stay real.
    const native = createNativeSessionBoundary();
    const runtime = createVoiceSessionRuntimeThroughNativeFactory({
      runtime: { sessions: { open: request => native.open(request) } }, modelId: 'voice-permission',
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
    });
    const manager = new VoiceAgentManager({ createRuntime: () => runtime });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: serverId });
    try {
      const started = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        chatModelId: 'fixture', commitModelId: 'fixture', permissionIntent: mode === 'read-only' ? 'read-only' : 'default',
        idleTtlSeconds: 60, initialContext: '' });
      const action = mode === 'default'
        ? { t: 'settings_set', args: { anchor: 'voiceConversations.minSpeechMs', value: 1100 } }
        : { t: 'settings_invoke', args: { anchor: 'voicePrivacy.forgetVoiceAgentMemory' } };
      const stream = mode === 'narrowed' ? await manager.startTurnStream({
        voiceAgentId: started.voiceAgentId, userText: 'Use the settings Action', causalPermissionAuthority: {
          kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const,
        },
      }) : null;
      const turn = stream ? null : manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'Use the settings Action' });
      // Attach the rejection assertion before publishing synchronous SDK output.
      const refused = mode === 'read-only' ? expect(turn).rejects.toMatchObject({ code: 'permission_denied' }) : null;
      await native.waitForInputs(1);
      native.complete(`<voice_actions>${JSON.stringify({ actions: [action] })}</voice_actions>`);
      if (mode !== 'default') {
        if (refused) await refused;
        if (stream) {
          let cursor = 0;
          let denied = false;
          while (true) {
            const page = await manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId,
              cursor, waitForEvents: true });
            cursor = page.nextCursor;
            denied ||= page.events.some(event => event.t === 'error' && event.errorCode === 'permission_denied');
            expect(page.events.some(event => event.t === 'voice_output' && event.output.kind === 'side_effect')).toBe(false);
            if (page.done) break;
          }
          expect(denied).toBe(true);
        }
        expect(home.artifacts(serverId).list()).toEqual([]);
        expect(version).toBe(1);
        return;
      }
      if (!turn) throw new Error('Expected ordinary default turn');
      const output = await turn;
      expect(output.actions).toEqual([expect.objectContaining(action)]);
      const admitted = output.actions?.[0];
      if (!admitted) throw new Error('Expected admitted Voice Action');
      let created!: () => void;
      const askCreated = new Promise<void>(resolve => { created = resolve; });
      home.artifacts(serverId).afterNextCreate(async () => { created(); });
      const pending = handlers[admitted.t]!(admitted.args, { effectId: 'manager-voice-setting' });
      await askCreated;
      const ask = home.artifacts(serverId).list().find(row => {
        const parsed = ApprovalRequestSchema.safeParse(JSON.parse(home.artifacts(serverId).readPlainBody(row.id) ?? 'null'));
        return parsed.success && parsed.data.actionId === 'settings.set';
      });
      if (!ask) throw new Error('Expected the normal settings Ask');
      expect(version).toBe(1);
      expect(JSON.parse(await handlers.settings_get!({ anchor: 'voiceConversations.minSpeechMs' })))
        .toMatchObject({ ok: true, value: 1000 });
      expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId: ask.id, decision: 'approve' },
        { surface: 'ui', serverId, authority: 'present_user', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true });
      expect(JSON.parse(await pending)).toMatchObject({ ok: true, value: 1100 });
      expect(version).toBe(2);
    } finally { await manager.dispose(); }
  });
});
