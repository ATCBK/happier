import type { AtmospherePicture } from '@happier-dev/brand/atmosphere';
import { t } from '@/text';
import type { AtmosphereLookCopyKey } from '@/text/translations/glassAppearanceTranslations.shared';

/**
 * The built-in photos' titles, by catalog id: plain descriptions that read in the user's language.
 * Paintings keep their own titles (proper names), and a plugin's picture keeps the title it gives.
 */
const PHOTO_TITLE_KEY: Readonly<Record<string, AtmosphereLookCopyKey>> = {
  'white-rocks-open-sea': 'photoWhiteRocksOpenSea',
  'dune-grass': 'photoDuneGrass',
  'pastel-daybreak': 'photoPastelDaybreak',
  'snowy-alps': 'photoSnowyAlps',
  'valley-lakes': 'photoValleyLakes',
  'glacier-lake': 'photoGlacierLake',
  'peak-in-the-clouds': 'photoPeakInTheClouds',
  'orange-dune': 'photoOrangeDune',
  'balloons-at-dawn': 'photoBalloonsAtDawn',
  'ferris-wheel': 'photoFerrisWheel',
};

/** A picture's title as the picker, the credit chip and their accessible names show it. */
export function pictureTitle(picture: AtmospherePicture): string {
  const key = PHOTO_TITLE_KEY[picture.id];
  return key ? t(`settingsAppearance.glassControls.${key}`) : picture.title;
}

/** A built-in picture's credit after its title: "Photo · Author · Unsplash" (or Painting · … · The Met). */
export function pictureCreditLine(picture: AtmospherePicture): string {
  const kind = t(
    picture.kind === 'painting'
      ? 'settingsAppearance.glassControls.creditPainting'
      : 'settingsAppearance.glassControls.creditPhoto',
  );
  return `${kind} · ${picture.credit.author} · ${picture.credit.source}`;
}
