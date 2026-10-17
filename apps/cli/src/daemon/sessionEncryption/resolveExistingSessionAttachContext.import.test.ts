import { describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return {
    ...actual,
    configuration: {
      ...actual.configuration,
      get daemonReattachCatchUpConcurrency(): number {
        throw new Error('Existing-session concurrency must not be read at module import time');
      },
    },
  };
});

import { resolveExistingSessionAttachContext } from './resolveExistingSessionAttachContext';

describe('resolveExistingSessionAttachContext import behavior', () => {
  it('does not create the existing-session lookup gate at module import time', async () => {
    expect(resolveExistingSessionAttachContext).toEqual(expect.any(Function));
  });
});
