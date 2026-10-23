import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { standardCleanup, waitForTestEvent } from '@/dev/testkit';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

afterEach(() => standardCleanup());

describe('invalidatePersistentVoiceTranscript', () => {
  it('increments both Voice projections and persists the epoch without replacing neighboring preferences', async () => {
    const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const { readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: {
      assistantLanguage: 'fr', privacy: { shareToolNames: false },
      providers: { local_conversation: { schemaVersion: 1,
        config: { agent: { transcript: { persistenceMode: 'persistent', epoch: 2 } } } } },
    } }));
    onTestFinished(account.dispose);
    const { invalidatePersistentVoiceTranscript } = await import('./invalidatePersistentVoiceTranscript');
    const { sync } = await import('@/sync/sync');

    expect(invalidatePersistentVoiceTranscript(account.scope)).toBe(3);
    expect(readLocalConversationVoiceSettings(account.settings.voice).agent.transcript.epoch).toBe(3);
    expect(readLocalConversationVoiceSettings(account.settings.voiceSettingsV1).agent.transcript.epoch).toBe(3);
    // The Settings owner debounces its pending flush; observe actual HTTP persistence.
    await waitForTestEvent(account.subscribe,
      () => readLocalConversationVoiceSettings(account.persistedSettings.voice).agent.transcript.epoch,
      epoch => epoch === 3);
    expect(readLocalConversationVoiceSettings(account.persistedSettings.voice).agent.transcript.epoch).toBe(3);
    expect(account.persistedSettings.voice).toMatchObject({ assistantLanguage: 'fr', privacy: { shareToolNames: false } });
    expect(account.writes.length).toBeGreaterThan(0);

    // An obsolete captured Account must not change the currently mounted one.
    const before = account.settings;
    const writes = account.writes.length;
    invalidatePersistentVoiceTranscript({ ...account.scope, accountId: 'other-account' });
    await (Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync).awaitQueue();
    expect(account.settings).toBe(before);
    expect(account.writes).toHaveLength(writes);
  });
});
