import { beforeEach, describe, expect, it } from 'vitest';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

import {
  resetVoiceDiagnosticsSessionPolicyForTests,
  resolveVoiceDiagnosticsCaptureContextFromSettings,
  setVoiceDiagnosticsSessionCaptureAllowed,
} from './capturePolicy';

const enabledSettings = {
  voice: voiceSettingsParse({
    diagnostics: {
      v: 1,
      enabled: true,
      consentVersion: 1,
      captureSttInput: true,
      captureTtsOutput: false,
    },
  }),
};

describe('voice diagnostics capture policy', () => {
  beforeEach(resetVoiceDiagnosticsSessionPolicyForTests);

  it('requires global consent, the matching direction, and a non-opted-out session', () => {
    expect(resolveVoiceDiagnosticsCaptureContextFromSettings({
      settings: enabledSettings,
      sessionId: 'session-1',
      direction: 'stt_input',
      durationMs: 100,
    })).toMatchObject({
      sessionId: 'session-1',
      captureAllowed: true,
      durationMs: 100,
      authorizationId: expect.any(String),
    });
    expect(resolveVoiceDiagnosticsCaptureContextFromSettings({
      settings: enabledSettings,
      sessionId: 'session-1',
      direction: 'tts_output',
      durationMs: null,
    })).toBeUndefined();

    setVoiceDiagnosticsSessionCaptureAllowed('session-1', false);
    expect(resolveVoiceDiagnosticsCaptureContextFromSettings({
      settings: enabledSettings,
      sessionId: 'session-1',
      direction: 'stt_input',
      durationMs: 100,
    })).toBeUndefined();
  });

  it('never writes session opt-outs into account or sync state', () => {
    setVoiceDiagnosticsSessionCaptureAllowed('../sensitive/session', false);
    expect(enabledSettings.voice.diagnostics.enabled).toBe(true);
    expect(resolveVoiceDiagnosticsCaptureContextFromSettings({
      settings: enabledSettings,
      sessionId: '../sensitive/session',
      direction: 'stt_input',
      durationMs: null,
    })).toBeUndefined();
  });
});
