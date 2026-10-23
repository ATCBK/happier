import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import { publicProfileMutationNotice } from './publicProfileMutation';

describe('publicProfileMutationNotice', () => {
  it('preserves the preparation cause of a refused publish instead of reporting a generic mutation failure', () => {
    const notice = (reason: string) => publicProfileMutationNotice({ ok: false,
      errorCode: 'public_profile_preparation_unavailable', error: 'Preparation unavailable', details: { reason } });
    expect(notice('no_eligible_personal_usage')).toBe(t('publicIdentity.profile.reasons.no_eligible_personal_usage'));
    expect(notice('source_time_unavailable')).toBe(t('publicIdentity.profile.reasons.source_time_unavailable'));
    expect(notice('no_eligible_personal_usage')).not.toBe(notice('source_time_unavailable'));
    expect(notice('private diagnostic')).toBe(t('publicIdentity.profile.actionFailed'));
    expect(publicProfileMutationNotice({ ok: false, errorCode: 'public_profile_preparation_unavailable',
      error: 'Preparation unavailable', details: { reason: 'no_eligible_personal_usage' },
      operationCredentialUses: [],
    })).toBe(t('publicIdentity.profile.reasons.no_eligible_personal_usage'));
  });

  it('keeps an acknowledged update distinct from its unavailable follow-on refresh and explains that cause', () => {
    const notice = publicProfileMutationNotice({ kind: 'updated', record: null,
      refresh: 'unavailable', refreshReason: 'no_eligible_personal_usage' });
    expect(notice).toContain(t('publicIdentity.profile.savedRefreshPending'));
    expect(notice).toContain(t('publicIdentity.profile.reasons.no_eligible_personal_usage'));
    expect(publicProfileMutationNotice({ kind: 'updated', record: null,
      refresh: 'unavailable', refreshReason: 'private diagnostic' })).toBe(t('publicIdentity.profile.savedRefreshPending'));
  });
});
