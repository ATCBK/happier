import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectionState } from '@/api/offline/serverConnectionErrors';

import {
  shouldTreatGetOrCreateMachineErrorAsOffline,
  shouldTreatGetOrCreateSessionErrorAsOffline,
} from './offlineErrors';

describe('offlineErrors', () => {
  afterEach(() => {
    connectionState.reset();
  });

  it('treats normalized network error codes as offline bootstrap failures', () => {
    expect(
      shouldTreatGetOrCreateSessionErrorAsOffline(
        { code: ' etimedout ' },
        { url: 'https://example.test/v1/sessions' },
      ),
    ).toBe(true);

    expect(connectionState.isOffline()).toBe(true);
  });

  it('keeps machine registration conflict responses out of offline handling', () => {
    expect(
      shouldTreatGetOrCreateMachineErrorAsOffline(
        { response: { status: 409 } },
        { url: 'https://example.test/v1/machines' },
      ),
    ).toBe(false);

    expect(connectionState.isOffline()).toBe(false);
  });

  it('reports 5xx machine registration failures on stderr without contaminating command stdout', () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        shouldTreatGetOrCreateMachineErrorAsOffline(
          { response: { status: 503 } },
          { url: 'https://example.test/v1/machines' },
        ),
      ).toBe(true);

      expect(connectionState.isOffline()).toBe(true);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Machine registration failed: 503'));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Server encountered an error'));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
