import { describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', async (importOriginal) => ({
  configuration: {
    ...(await importOriginal<typeof import('@/configuration')>()).configuration,
    get daemonReattachCatchUpConcurrency(): number {
      throw new Error('Existing-session lookup configuration is unavailable during import');
    },
  },
}));

import { resolveExistingSessionAttachContext } from './resolveExistingSessionAttachContext';

describe('resolveExistingSessionAttachContext import behavior', () => {
  it('does not create the existing-session lookup gate at module import time', async () => {
    expect(resolveExistingSessionAttachContext).toEqual(expect.any(Function));
  });
});
