import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MAX_VOICE_TIMER_DELAY_MS } from '@happier-dev/protocol/voice/settings/timing';

import { renderScreen } from '@/dev/testkit';
import {
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
  voiceSettingsDefaults,
  writeLocalConversationVoiceSettings,
  writeLocalDirectVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

import { VoiceConnectionSection } from './VoiceConnectionSection';

describe('VoiceConnectionSection', () => {
  it.each(['local_conversation', 'local_direct'] as const)('keeps zero and decrement within the positive schema range for %s', async (providerId) => {
    const base = { ...voiceSettingsDefaults, providerId };
    const read = providerId === 'local_direct' ? readLocalDirectVoiceSettings : readLocalConversationVoiceSettings;
    const voice = providerId === 'local_direct'
      ? writeLocalDirectVoiceSettings(base, { ...readLocalDirectVoiceSettings(base), networkTimeoutMs: 2000 })
      : writeLocalConversationVoiceSettings(base, { ...readLocalConversationVoiceSettings(base), networkTimeoutMs: 2000 });
    const setVoice = vi.fn<(next: VoiceSettings) => void>();
    const screen = await renderScreen(<VoiceConnectionSection voice={voice} setVoice={setVoice} />);
    const fieldId = 'settings.voice.local.networkTimeoutMs.field';
    await screen.pressByTestIdAsync(`${fieldId}.decrement`);
    expect(read(setVoice.mock.lastCall![0]).networkTimeoutMs).toBe(1000);
    await act(async () => { screen.findByTestId(fieldId)!.props.onChangeText('0'); });
    await act(async () => { screen.findByTestId(fieldId)!.props.onBlur(); });
    expect(read(setVoice.mock.lastCall![0]).networkTimeoutMs).toBe(1000);
    expect(screen.findByTestId(fieldId)!.props.value).toBe('1');
    expect(screen.findByTestId(`${fieldId}.decrement`)!.props.disabled).toBe(true);
  });

  it('edits the request timeout in seconds without a sixty-second ceiling', async () => {
    const setVoice = vi.fn();
    const screen = await renderScreen(<VoiceConnectionSection voice={voiceSettingsDefaults} setVoice={setVoice} />);
    const field = () => screen.findByTestId('settings.voice.local.networkTimeoutMs.field');
    expect(field()?.props.value).toBe(String(readLocalConversationVoiceSettings(voiceSettingsDefaults).networkTimeoutMs / 1000));

    await act(async () => { field()!.props.onChangeText('90'); });
    await act(async () => { field()!.props.onBlur(); });
    expect(readLocalConversationVoiceSettings(setVoice.mock.lastCall![0] as VoiceSettings).networkTimeoutMs).toBe(90000);

    const admittedMaximumMs = MAX_VOICE_TIMER_DELAY_MS;
    await act(async () => { field()!.props.onChangeText(String(Math.ceil(admittedMaximumMs / 1000) + 1)); });
    await act(async () => { field()!.props.onBlur(); });
    expect(readLocalConversationVoiceSettings(setVoice.mock.lastCall![0] as VoiceSettings).networkTimeoutMs).toBe(admittedMaximumMs);

    await act(async () => { field()!.props.onChangeText('7'); });
    await act(async () => { field()!.props.onBlur(); });
    expect(readLocalConversationVoiceSettings(setVoice.mock.lastCall![0] as VoiceSettings).networkTimeoutMs).toBe(7000);
  });
});
