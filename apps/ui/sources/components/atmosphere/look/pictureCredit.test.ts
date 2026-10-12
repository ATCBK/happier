import { afterEach, describe, expect, it } from 'vitest';
import { ATMOSPHERE_PICTURES, type AtmospherePicture } from '@happier-dev/brand/atmosphere';
import { preloadTranslations, setPreferredLanguageFromSettings } from '@/text';
import { pictureTitle } from './pictureCredit';

const photo = ATMOSPHERE_PICTURES.find((picture) => picture.id === 'dune-grass')!;
const painting = ATMOSPHERE_PICTURES.find((picture) => picture.id === 'calm-sea')!;

describe('picture titles', () => {
  afterEach(() => setPreferredLanguageFromSettings(null));

  it('localises a built-in photo by its catalog id and keeps proper names and plugin titles as given', async () => {
    await preloadTranslations('de');
    setPreferredLanguageFromSettings('de');
    expect(pictureTitle(photo)).not.toBe(photo.title);
    expect(pictureTitle(painting)).toBe(painting.title);
    const plugin: AtmospherePicture = { ...photo, id: 'plugin.example/dune', title: 'Dunes at noon' };
    expect(pictureTitle(plugin)).toBe('Dunes at noon');
  });
});
