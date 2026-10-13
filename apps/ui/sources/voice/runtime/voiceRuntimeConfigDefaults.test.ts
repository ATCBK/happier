import { describe, expect, it } from 'vitest';

import { DEFAULT_BACKCHANNEL_GATE } from '@/voice/runtime/input/resolveBackchannelDecision';
import { DEFAULT_TURN_POLICY } from '@/voice/runtime/input/turnPolicyMachine';
import { DEFAULT_TEXTUAL_ECHO_GUARD } from '@/voice/runtime/echo/textualEchoGuard';

import { VOICE_RUNTIME_CONFIG_DEFAULTS } from './voiceRuntimeConfigDefaults';

describe('voiceRuntimeConfigDefaults', () => {
  it('aligns daemon TTS default codec with the active wav controller contract', () => {
    expect(VOICE_RUNTIME_CONFIG_DEFAULTS.daemonInference.tts.defaultCodec).toEqual({
      codec: 'wav',
      mimeType: 'audio/wav',
    });
  });

  it('feeds the endpoint / backchannel / echo module defaults from the canonical owner (no drift)', () => {
    expect(DEFAULT_TURN_POLICY).toEqual(VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.endpointHysteresis);
    expect(DEFAULT_BACKCHANNEL_GATE).toEqual(VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.backchannelGate);
    expect(DEFAULT_TEXTUAL_ECHO_GUARD).toEqual(VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.textualEchoGuard);
  });

});
