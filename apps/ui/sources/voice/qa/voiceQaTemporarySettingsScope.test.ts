import { afterEach, describe, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { createDeferred } from '@/dev/testkit';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { loadSettings, saveSettings } from '@/sync/domains/state/settingsPersistence';

import { applySettings, settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { voiceSettingsDefaults, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

import { createVoiceQaTemporarySettingsScopeCoordinator } from './voiceQaTemporarySettingsScope';

function createSettingsHarness(initial: Settings) {
  storage.setState({ settings: initial, settingsScope: null });
  saveSettings(initial, 0);
  return {
    readSettings: () => storage.getState().settings,
    applySettingsLocal: storage.getState().applySettingsLocal,
  };
}

function createVoiceSettings(marker: string) {
  return voiceSettingsParse({
    ...voiceSettingsDefaults,
    assistantLanguage: marker,
  });
}

function createBaselineSettings(): Settings {
  return applySettings(settingsDefaults, {
    experiments: false,
    featureToggles: { voice: false, unrelated: true },
    voice: createVoiceSettings('baseline'),
  });
}

describe('voice QA temporary settings scope', () => {
  const initialStorage = storage.getState();
  afterEach(() => {
    vi.restoreAllMocks();
    storage.setState(initialStorage, true);
  });
  it('restores the exact prior settings after successful and failed serial actions', async () => {
    const baseline = createBaselineSettings();
    const harness = createSettingsHarness(baseline);
    const coordinator = createVoiceQaTemporarySettingsScopeCoordinator(harness);

    await expect(coordinator.run({
      ownerId: 'screen-a',
      delta: {
        experiments: true,
        featureToggles: { voice: true },
        voice: createVoiceSettings('first'),
      },
    }, async () => {
      expect(harness.readSettings()).toMatchObject({
        experiments: true,
        featureToggles: { voice: true },
        voice: expect.objectContaining({ assistantLanguage: 'first' }),
      });
      return 'ok';
    })).resolves.toBe('ok');
    expect(harness.readSettings()).toMatchObject(baseline);

    await expect(coordinator.run({
      ownerId: 'screen-a',
      delta: { experiments: true, voice: createVoiceSettings('second') },
    }, async () => {
      throw new Error('transcription_failed');
    })).rejects.toThrow('transcription_failed');
    expect(harness.readSettings()).toMatchObject(baseline);
  });

  it('keeps overlapping actions isolated and restores the previous active override in stack order', async () => {
    const baseline = createBaselineSettings();
    const harness = createSettingsHarness(baseline);
    const coordinator = createVoiceQaTemporarySettingsScopeCoordinator(harness);
    const first = createDeferred<string>();
    const second = createDeferred<string>();

    const firstRun = coordinator.run({
      ownerId: 'screen-a',
      delta: { experiments: true, voice: createVoiceSettings('first') },
    }, () => first.promise);
    expect(harness.readSettings().voice.assistantLanguage).toBe('first');

    const secondRun = coordinator.run({
      ownerId: 'screen-b',
      delta: { experiments: true, voice: createVoiceSettings('second') },
    }, () => second.promise);
    expect(harness.readSettings().voice.assistantLanguage).toBe('second');

    second.resolve('second');
    await expect(secondRun).resolves.toBe('second');
    expect(harness.readSettings().voice.assistantLanguage).toBe('first');

    first.resolve('first');
    await expect(firstRun).resolves.toBe('first');
    expect(harness.readSettings()).toMatchObject(baseline);
  });

  it('restores immediately on cancellation or owner teardown and keeps later cleanup idempotent', async () => {
    const baseline = createBaselineSettings();
    const harness = createSettingsHarness(baseline);
    const coordinator = createVoiceQaTemporarySettingsScopeCoordinator(harness);
    const action = createDeferred<string>();
    const abortController = new AbortController();

    const run = coordinator.run({
      ownerId: 'screen-a',
      delta: { experiments: true, voice: createVoiceSettings('temporary') },
      signal: abortController.signal,
    }, () => action.promise);
    expect(harness.readSettings().voice.assistantLanguage).toBe('temporary');

    abortController.abort();
    coordinator.releaseOwner('screen-a');
    expect(harness.readSettings()).toMatchObject(baseline);

    action.resolve('done');
    await expect(run).resolves.toBe('done');
    expect(harness.readSettings()).toMatchObject(baseline);
  });

  it('retires a failed settings scope when native persistence rejects the override and permits a later run', async () => {
    const baseline = createBaselineSettings();
    const harness = createSettingsHarness(baseline);
    const coordinator = createVoiceQaTemporarySettingsScopeCoordinator(harness);
    // The real settings owner persists before publishing its store projection.
    // Fail only the native storage write, preserving that ordering.
    vi.spyOn(getPersistenceStorage(), 'set').mockImplementationOnce(() => {
      throw new Error('settings_apply_failed');
    });

    await expect(coordinator.run({
      ownerId: 'screen-a',
      delta: { experiments: true, voice: createVoiceSettings('temporary') },
    }, async () => 'unreachable')).rejects.toThrow('settings_apply_failed');
    expect(harness.readSettings()).toMatchObject(baseline);
    expect(loadSettings().settings).toMatchObject(baseline);

    await coordinator.run({
      ownerId: 'screen-b',
      delta: { voice: createVoiceSettings('retry') },
    }, async () => {
      expect(harness.readSettings().voice.assistantLanguage).toBe('retry');
      expect(loadSettings().settings).toMatchObject({ voice: { assistantLanguage: 'retry' } });
    });
    expect(harness.readSettings()).toMatchObject(baseline);
    expect(loadSettings().settings).toMatchObject(baseline);
  });
});
