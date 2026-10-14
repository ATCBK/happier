import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { expect, it, vi } from 'vitest';
import * as persistence from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExternalSessionSourceSurface } from '@/session/actions/externalSessions/providerOpsResolution';
import { createExternalSessionFollowLeaseManager } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { resolveExternalSessionObservationLinkInput } from '@/api/session/external/leases/resolveExternalSessionObservationLinkInput';
import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { createExternalSessionFollowHostOperation } from './followHostOperation';
import type { HostExternalTranscriptFollowEvent } from './privateContract';

it.each(['thinking_text', 'cold_history', 'oversized_native_row'] as const)('admits a runner-carried Claude codec through real observation and scoped follow (%s)', async kind => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-runner-claude-follow-')));
  const configDir = join(root, 'claude');
  const projectId = '-project';
  const remoteSessionId = '33333333-3333-3333-3333-333333333333';
  const sessionId = 'hosted-claude';
  const home = 'https://runner-claude-follow.example';
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'follow-account' })).toString('base64url')}.signature`, encryption: null };
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  await mkdir(join(configDir, 'projects', projectId), { recursive: true });
  const historical = kind === 'thinking_text' ? [] : [
    { type: 'assistant', uuid: 'old-launch', parentUuid: null, sessionId: remoteSessionId,
      message: { content: [{ type: 'tool_use', id: 'old-agent-tool', name: 'Agent', input: { description: 'existing worker' } }] },
      ...(kind === 'oversized_native_row' ? { pad: '🙂'.repeat(2_100_000) } : {}) },
    { type: 'user', uuid: 'old-alias', parentUuid: 'old-launch', sessionId: remoteSessionId,
      message: { content: [{ type: 'tool_result', tool_use_id: 'old-agent-tool', content: 'launched' }] },
      toolUseResult: { status: 'async_launched', agentId: 'existing-native-child' } },
    ...(kind === 'cold_history' ? Array.from({ length: 1_100 }, (_, index) => ({
      type: 'assistant', uuid: `display-${index}`, parentUuid: index === 0 ? 'old-alias' : `display-${index - 1}`,
      message: { content: [{ type: 'text', text: 'x'.repeat(4_096) }] },
    })) : []),
  ];
  await writeFile(join(configDir, 'projects', projectId, `${remoteSessionId}.jsonl`), historical.map(row => JSON.stringify(row) + '\n').join('') + JSON.stringify({
    type: 'user', uuid: 'native-user', sessionId: remoteSessionId, timestamp: new Date().toISOString(),
    parentUuid: kind === 'thinking_text' ? null : kind === 'cold_history' ? 'display-1099' : 'old-alias',
    message: { content: 'work' },
  }) + '\n' + JSON.stringify({ type: 'assistant', uuid: 'native-answer', parentUuid: 'native-user',
    timestamp: new Date().toISOString(), message: { content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'complete' }], stop_reason: 'end_turn' },
  }) + '\n');
  const rawSession = { ...createSessionNotificationContextFixture(sessionId), currentStorageState: 'hosted' as const,
    encryptionMode: 'plain' as const, metadata: JSON.stringify({ machineId: 'machine', path: root,
      flavor: 'claude', claudeSessionId: remoteSessionId }) };
  // Credential-file and Home HTTP are genuine system boundaries. Registry,
  // codecs, link admission, observation reduction and follow custody are real.
  const credentialsRead = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  const http = vi.spyOn(axios, 'get').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.origin).toBe(home);
    if (url.pathname === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: rawSession } };
    if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    throw new Error(`Unexpected follow HTTP boundary: ${url.pathname}`);
  });
  const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
  // These two publishers cross Home persistence; no internal owner is mocked.
  const manager = createExternalSessionFollowLeaseManager({ writeFollowStatus: async () => {} });
  const projection = createExternalSessionObservationDaemonProjection({ publishField: async () => {},
    requestTranscriptRefresh: input => manager.requestTranscriptRefresh(input),
    isTranscriptRefreshDemanded: input => manager.hasTranscriptDemand(input) });
  const operation = createExternalSessionFollowHostOperation({ machineId: 'machine', followLeaseManager: manager,
    observationProjection: projection });
  let subscription: Readonly<{ dispose(): void | Promise<void> }> | undefined;
  try {
    await runWithServerHttpBaseUrl(home, async () => {
      const source = { kind: 'claudeConfig', configDir, projectId };
      const surface = await resolveExternalSessionSourceSurface('claude', source);
      if (!surface.ok || !surface.providerOps.pageTranscript || !surface.providerOps.readAfterTranscript) throw new Error('Claude source unavailable');
      const loaded = await loadLinkedExternalSession({ credentials, sessionId, machineId: 'machine',
        expectedIdentity: { agentId: 'claude', machineId: 'machine', remoteSessionId, source: surface.source } });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error('Hosted Session unavailable');
      const observation = await resolveExternalSessionObservationLinkInput({ sessionId, linked: loaded.session });
      expect(observation).not.toBeNull();
      expect(observation?.resource.occurrenceId).not.toBe('runner-service-binding');
      const events: HostExternalTranscriptFollowEvent[] = [];
      const result = await operation.execute({ pluginId: 'happier.agent.claude', contributionId: 'claude',
        occurrenceId: 'runner-service-binding', sessionId, machineId: 'machine',
        ref: { agentId: 'claude', sourceId: surface.sourceKeyOwner.sourceKey, remoteSessionId }, source: surface.source,
        providerOps: { pageTranscript: surface.providerOps.pageTranscript, readAfterTranscript: surface.providerOps.readAfterTranscript },
        options: { projection: 'terminal', initialReplay: true }, isCurrent: () => true,
        listener: event => { events.push(event); } });
      expect(result).toMatchObject({ status: 'following', startingCursor: expect.any(String) });
      if (result.status === 'following') subscription = result.subscription;
      expect(events.some(event => event.kind === 'data' && event.providerSessionId === remoteSessionId)).toBe(true);
      if (kind !== 'thinking_text') {
        const nativeRows = events.flatMap(event => event.kind === 'data' ? event.items : [])
          .filter(item => item.kind === 'source_observation').map(item => item.data);
        expect(nativeRows).toEqual(expect.arrayContaining([
          expect.objectContaining({ uuid: 'old-launch' }),
          expect.objectContaining({ uuid: 'old-alias', toolUseResult: expect.objectContaining({ agentId: 'existing-native-child' }) }),
        ]));
      }
    });
  } finally {
    await subscription?.dispose();
    await projection.dispose();
    await fixture.dispose();
    credentialsRead.mockRestore(); http.mockRestore();
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    await rm(root, { recursive: true, force: true });
  }
});
