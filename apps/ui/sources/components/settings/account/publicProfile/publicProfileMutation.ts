import { PublicProfileMutationResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { PublicProfilePreparationUnavailableReasonV1Schema, PublicProfileUpdateResultV1Schema } from '@happier-dev/protocol/account/publicProfileIntents';

import { t } from '@/text';

export type PublicProfileOperation =
  | 'refresh'
  | 'pause'
  | 'resume'
  | 'unpublish'
  | 'update';

/**
 * One line for an acknowledged answer that did not do what was asked: the typed reason, never a code.
 * A completed change says nothing; the reread page shows it.
 */
export function publicProfileMutationNotice(result: unknown): string | null {
  // Settled host outcomes may also carry credential-use annotations; read the
  // failure cause without reparsing them as a strict public wire envelope.
  if (result !== null && typeof result === 'object' && 'ok' in result && result.ok === false) {
    const details = 'details' in result ? result.details : null;
    const reason = 'errorCode' in result && result.errorCode === 'public_profile_preparation_unavailable'
      && details !== null && typeof details === 'object' && 'reason' in details
      ? PublicProfilePreparationUnavailableReasonV1Schema.safeParse(details.reason) : null;
    return reason?.success ? t(`publicIdentity.profile.reasons.${reason.data}`) : t('publicIdentity.profile.actionFailed');
  }
  const update = PublicProfileUpdateResultV1Schema.safeParse(result);
  if (update.success) {
    if (update.data.kind === 'unavailable')
      return t(`publicIdentity.profile.reasons.${update.data.reason}`);
    if (update.data.refresh !== 'failed' && update.data.refresh !== 'unavailable') return null;
    const reason = PublicProfilePreparationUnavailableReasonV1Schema.safeParse(update.data.refreshReason);
    const saved = t('publicIdentity.profile.savedRefreshPending');
    return reason.success ? `${saved} ${t(`publicIdentity.profile.reasons.${reason.data}`)}` : saved;
  }
  const mutation = PublicProfileMutationResultV1Schema.safeParse(result);
  if (!mutation.success) return t('publicIdentity.profile.actionFailed');
  return mutation.data.kind === 'unavailable'
    ? t(`publicIdentity.profile.reasons.${mutation.data.reason}`)
    : null;
}
