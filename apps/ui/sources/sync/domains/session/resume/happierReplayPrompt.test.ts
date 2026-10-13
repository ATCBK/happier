import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { resolveHappierReplayConfig } from './happierReplayPrompt';

describe('resolveHappierReplayConfig', () => {
  it('retains usable character and aggregate count budgets', () => {
    const cfg = resolveHappierReplayConfig({
      ...settingsDefaults,
      sessionReplayEnabled: true,
      sessionReplayRecentMessagesCount: 620,
      sessionReplayMaxSeedChars: 120_000,
    });

    expect(cfg.enabled).toBe(true);
    expect(cfg.recentMessagesCount).toBe(620);
    expect(cfg.maxSeedChars).toBe(120_000);
  });

  it('forwards usable budgets without a provider-sized ceiling', () => {
    for (const stored of [120_000, 512 * 1024]) {
      expect(resolveHappierReplayConfig({
        ...settingsDefaults,
        sessionReplayEnabled: true,
        sessionReplayMaxSeedChars: stored,
      }).maxSeedChars).toBe(stored);
    }
  });

  it('falls back for invalid selected budgets rather than rounding or clamping them', () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1024]) {
      const resolved = resolveHappierReplayConfig({
        ...settingsDefaults,
        sessionReplayRecentMessagesCount: 0,
        sessionReplayMaxSeedChars: invalid,
      });
      expect(resolved.recentMessagesCount).toBe(settingsDefaults.sessionReplayRecentMessagesCount);
      expect(resolved.maxSeedChars).toBe(settingsDefaults.sessionReplayMaxSeedChars);
    }
  });
});
