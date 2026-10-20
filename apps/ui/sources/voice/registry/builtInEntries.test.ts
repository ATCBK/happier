import { describe, expect, it } from 'vitest';

import { tLoose } from '@/text';

import { BUILT_IN_VOICE_UI_ENTRIES } from './builtInEntries';

describe('built-in voice processing disclosures', () => {
  it('names every speech provider with a real translation, never its own key', () => {
    const titleKeys = BUILT_IN_VOICE_UI_ENTRIES.flatMap((entry) => [
      entry.processingDisclosures?.stt?.titleKey,
      entry.processingDisclosures?.tts?.titleKey,
    ]).filter((key): key is string => typeof key === 'string');
    expect(titleKeys.length).toBeGreaterThan(0);
    expect(titleKeys.filter((key) => tLoose(key) === key)).toEqual([]);
  });
});
