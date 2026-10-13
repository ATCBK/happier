import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { MAX_VOICE_TIMER_DELAY_MS } from '@happier-dev/protocol/voice/settings/timing';

type PlatformSelectOptions<T> = {
    web?: T;
    default?: T;
};

// Only rendering and user-interaction boundaries are substituted. In particular,
// storage, settings declarations, provider registries and field commits stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: <T,>(options: PlatformSelectOptions<T>) => options.web ?? options.default,
        },
        TurboModuleRegistry: {
            getEnforcing: () => ({}),
        },
        Pressable: 'Pressable',
    });
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: { colors: { textSecondary: '#666' } },
    });
});


import { readLocalDirectVoiceSettings, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

afterEach(async () => {
  await standardCleanup();
  vi.restoreAllMocks();
});

describe('LocalDirectSection', () => {
  // The network timeout used to be edited through an async `Modal.prompt`, whose rejection leaked as an
  // unhandledRejection. The inline field accepts the canonical setting range,
  // including valid requests beyond the retired 60-second ceiling.
  it.each([
    { input: '120', expectedMs: 120_000 },
    { input: '999999999', expectedMs: MAX_VOICE_TIMER_DELAY_MS },
  ])('commits the network timeout $input inline without a prompt or an unhandledRejection', async ({ input, expectedMs }) => {
    const { VoiceConnectionSection } = await import('@/voice/settings/panels/VoiceConnectionSection');
    const { Modal, ModalProvider } = await import('@/modal');
    // Observation only: any accidental prompt still executes the real owner.
    const modalPrompt = vi.spyOn(Modal, 'prompt');
    const unhandledSpy = vi.fn();
    process.on('unhandledRejection', unhandledSpy);
    let committedVoice = voiceSettingsParse({ providerId: 'local_direct' });

    try {
      // Advanced connection settings owns the timeout for both local adapters.
      const screen = await renderSettingsView(React.createElement(ModalProvider, {
        children: React.createElement(VoiceConnectionSection, {
          voice: committedVoice,
          setVoice: (next) => { committedVoice = next; },
        }),
      }));
      const field = () => screen.findByTestId('settings.voice.local.networkTimeoutMs.field')!.props;

      await act(async () => {
        field().onChangeText(input);
      });
      await act(async () => {
        field().onBlur();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.removeListener('unhandledRejection', unhandledSpy);
    }

    expect(modalPrompt).not.toHaveBeenCalled();
    expect(readLocalDirectVoiceSettings(committedVoice).networkTimeoutMs).toBe(expectedMs);
    expect(unhandledSpy).not.toHaveBeenCalled();
  });

});
