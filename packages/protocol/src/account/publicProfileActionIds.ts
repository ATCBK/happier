/** Public-profile Actions remain part of the existing Account family. */
export const PUBLIC_PROFILE_ACTION_IDS_V1 = [
  'account.public_profile.get', 'account.public_profile.preview', 'account.public_profile.publish',
  'account.public_profile.resume', 'account.public_profile.update', 'account.public_profile.refresh',
  'account.public_profile.pause', 'account.public_profile.unpublish', 'account.public_profile.report.get', 'account.public_profile.embed.get',
] as const;
export type PublicProfileActionIdV1 = typeof PUBLIC_PROFILE_ACTION_IDS_V1[number];
export type PublicProfilePreparationActionIdV1 = Extract<PublicProfileActionIdV1,
  'account.public_profile.preview' | 'account.public_profile.publish' | 'account.public_profile.resume'
  | 'account.public_profile.update' | 'account.public_profile.refresh'>;

export function isPublicProfilePreparationActionIdV1(value: string): value is PublicProfilePreparationActionIdV1 {
  return value === 'account.public_profile.preview' || value === 'account.public_profile.publish'
    || value === 'account.public_profile.resume' || value === 'account.public_profile.update'
    || value === 'account.public_profile.refresh';
}
