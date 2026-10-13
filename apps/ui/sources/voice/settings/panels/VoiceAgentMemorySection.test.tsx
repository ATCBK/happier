import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createVoiceSettingsAccountTestHarness } from './voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsDefaults,
  writeLocalConversationVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
beforeEach(async () => {
  account = await createVoiceSettingsAccountTestHarness(settingsParse({
    experiments: true, featureToggles: { 'voice.agent': true, 'execution.runs': true },
  }));
});
afterEach(async () => {
  standardCleanup();
  vi.useRealTimers();
  await account?.dispose();
  storage.setState(initialStorage, true);
});

type Agent = ReturnType<typeof readLocalConversationVoiceSettings>['agent'];

function voiceWithAgent(patch: Partial<Agent>): VoiceSettings {
  const cfg = readLocalConversationVoiceSettings(voiceSettingsDefaults);
  return writeLocalConversationVoiceSettings(voiceSettingsDefaults, { ...cfg, agent: { ...cfg.agent, ...patch } });
}

async function render(voice: VoiceSettings, setVoice = vi.fn()) {
  const { VoiceAgentMemorySection } = await import('./VoiceAgentMemorySection');
  vi.useFakeTimers();
  const screen = await renderScreen(React.createElement(VoiceAgentMemorySection, { voice, setVoice }));
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  vi.useRealTimers();
  return screen;
}

describe('VoiceAgentMemorySection', () => {
  it('shows how memory is restored even when nothing is remembered, locked until Remember is on', async () => {
    const screen = await render(voiceWithAgent({}));

    const restore = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.memory.restore')[0];
    expect(restore?.props.disabled).toBe(true);
    expect(screen.findByTestId('settings.voice.local.replay.recentMessagesCount.field')?.props.editable).toBe(false);
    expect(screen.findByTestId('settings.voice.memory.forget')).toBeTruthy();
  });

  it('turning Remember on persists the transcript without touching how it is restored', async () => {
    const setVoice = vi.fn();
    const voice = voiceWithAgent({ replay: { strategy: 'summary_plus_recent', recentMessagesCount: 12 } });
    const screen = await render(voice, setVoice);

    screen.findByTestId('settings.voice.memory.remember')?.props.onValueChange(true);
    const agent = readLocalConversationVoiceSettings(setVoice.mock.lastCall![0]).agent;
    expect(agent.transcript.persistenceMode).toBe('persistent');
    expect(agent.replay).toEqual({ strategy: 'summary_plus_recent', recentMessagesCount: 12 });
  });

  it('chooses resuming the agent as one atomic restore choice', async () => {
    const setVoice = vi.fn();
    const voice = voiceWithAgent({ transcript: { persistenceMode: 'persistent', epoch: 0 } });
    const screen = await render(voice, setVoice);

    screen.pressByTestId('settings.voice.memory.restore:provider_resume');
    const agent = readLocalConversationVoiceSettings(setVoice.mock.lastCall![0]).agent;
    expect(agent.resumabilityMode).toBe('provider_resume');
    expect(screen.findByTestId('settings.voice.memory.fallbackToReplay')).toBeTruthy();
  });

  it('says why resuming is unavailable when the Voice agent is off for this server', async () => {
    account.replaceSettings(settingsParse({ ...account.settings,
      featureToggles: { ...account.settings.featureToggles, 'voice.agent': false },
    }));
      const screen = await render(voiceWithAgent({ transcript: { persistenceMode: 'persistent', epoch: 0 } }));
      const restore = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.memory.restore')[0];
      const resume = restore?.props.options.find((option: { id: string }) => option.id === 'provider_resume');
      expect(typeof resume?.unavailableReason).toBe('string');
  });
});
