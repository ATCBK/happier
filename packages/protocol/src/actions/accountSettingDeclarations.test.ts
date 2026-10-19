import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import { resolveCredentialActionAdmissionV1 } from './decisionAuthority.js';

describe('Account transcript visibility setting admission', () => {
  it('requires present-user authority from API credentials only for human-owned Settings mutations', () => {
    for (const actionId of ['settings.set', 'settings.reset', 'settings.invoke'] as const) {
      const request = {
        spec: getActionSpec(actionId),
        grant: null,
        surface: 'api',
        hasExternalCredential: true,
        actionInput: { anchor: 'transcript.showToolCalls' },
      } as const;

      expect(resolveCredentialActionAdmissionV1({ ...request, authority: 'account_automation' }))
        .toEqual({ ok: false, errorCode: 'present_user_required' });
      expect(resolveCredentialActionAdmissionV1({ ...request, authority: 'present_user' }))
        .toEqual({ ok: true });
      expect(resolveCredentialActionAdmissionV1({
        ...request,
        authority: 'account_automation',
        actionInput: { anchor: 'delegation.workDepthLimit' },
      })).toEqual({ ok: true });
    }
  });
});
