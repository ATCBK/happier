import { PublicProfileMutationResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { PublicProfileUpdateResultV1Schema } from '@happier-dev/protocol/account/publicProfileIntents';

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
  const update = PublicProfileUpdateResultV1Schema.safeParse(result);
  if (update.success) {
    if (update.data.kind === 'unavailable')
      return t(`publicIdentity.profile.reasons.${update.data.reason}`);
    return update.data.refresh === 'failed' ||
      update.data.refresh === 'unavailable'
      ? t('publicIdentity.profile.savedRefreshPending')
      : null;
  }
  const mutation = PublicProfileMutationResultV1Schema.safeParse(result);
  if (!mutation.success) return t('publicIdentity.profile.actionFailed');
  return mutation.data.kind === 'unavailable'
    ? t(`publicIdentity.profile.reasons.${mutation.data.reason}`)
    : null;
}
