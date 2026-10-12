import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findAllHostTestInstances, renderScreen, standardCleanup } from '@/dev/testkit';
import { readLocalConversationVoiceSettings, voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { LocalVoiceTtsGroup } from './LocalVoiceTtsGroup';

const deviceSpeech = vi.hoisted(() => ({
  speak: vi.fn<typeof import('expo-speech').speak>(),
  stop: vi.fn<typeof import('expo-speech').stop>(),
}));

// The device speech SDK is the external boundary; the provider catalog,
// settings controls, playback lease and speaking state remain real.
vi.mock('expo-speech', () => deviceSpeech);
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

async function renderTtsGroup() {
  return await renderScreen(<LocalVoiceTtsGroup
    cfgTts={{ ...readLocalConversationVoiceSettings(voiceSettingsDefaults).tts, provider: 'device' }}
    setTts={vi.fn()}
    voice={voiceSettingsDefaults}
    setVoice={vi.fn()}
    networkTimeoutMs={15000}
    popoverBoundaryRef={null}
  />);
}

describe('LocalVoiceTtsGroup', () => {
  beforeEach(() => {
    deviceSpeech.speak.mockReset();
    deviceSpeech.stop.mockReset();
  });
  afterEach(standardCleanup);

  it('uses the localized row title as the accessible name of its switch', async () => {
    const screen = await renderTtsGroup();
    const switches = findAllHostTestInstances(screen.tree.root, node => (
      (node.props.accessibilityRole ?? node.props.role) === 'switch'
    ));
    expect(switches).toHaveLength(1);
    expect(switches[0].props.accessibilityLabel ?? switches[0].props['aria-label']).toBe(t('settingsVoice.local.autoSpeak'));
  });

  it('shows a speaking status until the device speech operation settles', async () => {
    let finishSpeech: (() => void) | undefined;
    deviceSpeech.speak.mockImplementation((_text, options) => {
      finishSpeech = () => options?.onDone?.();
    });
    const screen = await renderTtsGroup();
    expect(screen.getTextContent()).toContain(t('settingsVoice.local.testTtsSubtitle'));

    await screen.pressByTestIdAsync('settings.voice.local.testTts');
    await act(async () => {
      expect(finishSpeech).toBeTypeOf('function');
    });
    expect(screen.getTextContent()).toContain(t('settingsVoice.local.speaking'));
    expect(screen.getTextContent()).not.toContain(t('settingsVoice.local.testTtsSubtitle'));

    await act(async () => { finishSpeech?.(); });
    expect(screen.getTextContent()).toContain(t('settingsVoice.local.testTtsSubtitle'));
    expect(screen.getTextContent()).not.toContain(t('settingsVoice.local.speaking'));
  });
});
