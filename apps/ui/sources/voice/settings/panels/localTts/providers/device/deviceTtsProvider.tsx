import * as React from 'react';

import { t } from '@/text';
import { speakDeviceText } from '@/voice/local/speakDeviceText';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import type { LocalTtsProviderSpec } from '../_types';

const DeviceTtsSettings: LocalTtsProviderSpec['Settings'] = () => null;

export const deviceTtsProviderSpec: LocalTtsProviderSpec = {
  id: 'device',
  title: t('settingsVoice.local.deviceTts'),
  subtitle: t('settingsVoice.local.deviceTtsSubtitle'),
  iconName: 'device-mobile',
  detail: t('settingsVoice.local.deviceTtsDetail'),
  Settings: DeviceTtsSettings,
  test: async ({ sample, signal, isCurrent, registerPlaybackStopper }) => {
    const playback = new AbortController();
    const cancellation = mergeAbortSignals([signal, playback.signal]);
    const unregister = registerPlaybackStopper?.(() => playback.abort());
    try {
      await speakDeviceText(sample, undefined, { signal: cancellation.signal, isCurrent });
    } finally {
      unregister?.();
      cancellation.dispose();
    }
  },
};
