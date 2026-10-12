import { Platform } from 'react-native';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION_ID } from '../../constants.js';
import { createElevenLabsVoiceProviderRuntime as createRuntime } from './runtime.js';

export { VOICE_PROVIDER_PRESENTATIONS } from './entries.js';

export function createElevenLabsVoiceProviderRuntime(): ReturnType<typeof createRuntime> {
  return createRuntime({
    // The public web subpath is supplied by the version-pinned dependency patch.
    // Neither SDK entry evaluates until the admitted handle starts a conversation.
    loadConversationSdk: () => Platform.OS === 'web'
      ? import('@elevenlabs/client/web')
      : import('@elevenlabs/client'),
  });
}

export function activate(api: Pick<PluginApi, 'voiceProviders'>): void {
  api.voiceProviders.register(
    ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION_ID,
    createElevenLabsVoiceProviderRuntime(),
  );
}
