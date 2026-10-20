import { describe, expect, it } from 'vitest';

import { clearSessionStateFieldFromMetadata, createSessionStateFieldMetadataUpdater, readSessionStateFieldFromMetadata, writeSessionStateFieldToMetadata } from './publishField.js';

describe('readSessionStateFieldFromMetadata', () => {
  it('compares semantic field values independently of JSON key order and snapshots an in-place competing change', () => {
    const preference = { providerContributionId: 'example.voice/speech', settingFieldPath: 'voice', value: { id: 'original', language: 'en' } };
    const update = createSessionStateFieldMetadataUpdater('intent.voicePreference', null);
    update({ work: { voicePreference: preference } });
    expect(update({ work: { memoryEnabled: true, voicePreference: { ...preference, value: { language: 'en', id: 'original' } } } }))
      .toEqual({ work: { memoryEnabled: true } });
    preference.value.id = 'competing';
    expect(() => update({ work: { voicePreference: preference } })).toThrowError(expect.objectContaining({ code: 'conflict' }));
  });
  it('annotates and clears an explanation without rewriting work or runtime facts', () => {
    const metadata = { work: { memoryEnabled: true }, runtimeActivityState: 'running' };
    const updated = writeSessionStateFieldToMetadata(metadata, 'display.statusReason', 'Waiting for build');
    expect(updated).toEqual({ ...metadata, work: { memoryEnabled: true, statusReason: 'Waiting for build' } });
    expect(readSessionStateFieldFromMetadata(updated, 'display.statusReason')).toBe('Waiting for build');
    expect(writeSessionStateFieldToMetadata(updated, 'display.statusReason', 'Waiting for build')).toBe(updated);
    expect(clearSessionStateFieldFromMetadata(updated, 'display.statusReason')).toEqual(metadata);
  });
  it('reads a bound field through the canonical binding', () => {
    expect(readSessionStateFieldFromMetadata({
      summary: { text: 'Canonical title', updatedAt: 12 },
    }, 'display.title')).toBe('Canonical title');
  });

  it('returns undefined for a field with no metadata binding', () => {
    expect(readSessionStateFieldFromMetadata({}, 'view.attention')).toBeUndefined();
  });

  it('preserves neighboring work and view choices while updating and clearing bound preferences', () => {
    const voicePreference = { providerContributionId: 'happier.voice.xai/realtime', settingFieldPath: 'voice', value: 'voice' };
    const metadata = { work: { voicePreference, memoryEnabled: false, futureWork: { retained: true },
      viewPreferences: { showToolCalls: false, futureView: 'retained' } } };
    expect(readSessionStateFieldFromMetadata(metadata, 'intent.voicePreference')).toEqual(voicePreference);
    expect(readSessionStateFieldFromMetadata(metadata, 'view.transcriptToolCalls')).toBe(false);
    const enabled = writeSessionStateFieldToMetadata(
      writeSessionStateFieldToMetadata(metadata, 'intent.memoryEnabled', true), 'view.transcriptToolCalls', true);
    expect(readSessionStateFieldFromMetadata(enabled, 'intent.memoryEnabled')).toBe(true);
    expect(readSessionStateFieldFromMetadata(enabled, 'view.transcriptToolCalls')).toBe(true);
    expect(clearSessionStateFieldFromMetadata(
      clearSessionStateFieldFromMetadata(enabled, 'view.transcriptToolCalls'), 'intent.voicePreference'))
      .toEqual({ work: { memoryEnabled: true, futureWork: { retained: true }, viewPreferences: { futureView: 'retained' } } });
    expect(metadata.work.viewPreferences.showToolCalls).toBe(false);
    expect(metadata.work.memoryEnabled).toBe(false);
  });
});
