import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { describeTtsSampleFailure } from './ttsSampleFailureMessage';

describe('describeTtsSampleFailure', () => {
  it('names an unreachable or unavailable Voice machine in the person’s words, never the code', () => {
    expect(describeTtsSampleFailure('machine_unreachable')).toBe(t('settingsVoice.local.daemonInference.states.machineUnreachable'));
    expect(describeTtsSampleFailure('execution_machine_unavailable')).toBe(t('settingsVoice.local.daemonInference.states.machineUnreachable'));
    expect(describeTtsSampleFailure('request_timeout')).toBe(t('settingsVoice.local.daemonInference.states.requestTimeout'));
    expect(describeTtsSampleFailure('feature_disabled')).toBe(t('settingsVoice.local.daemonInference.states.unavailable'));
    expect(describeTtsSampleFailure('runtime_unavailable')).toBe(t('settingsVoice.local.daemonInference.states.runtimeUnavailable'));
  });

  it('gives engine-neutral advice for anything else and never leaks the raw reason', () => {
    for (const reason of ['voice_settings_operation_failed', 'some_unknown_code', null]) {
      const message = describeTtsSampleFailure(reason);
      expect(message).toBe(t('settingsVoice.local.testTtsFailed'));
      expect(message).not.toMatch(/_/);
      expect(message).not.toMatch(/base URL|API key/i);
    }
  });
});
