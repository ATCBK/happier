import { describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { resolveStartupPermissionModeFromSession } from './startupSeed';

describe('resolveStartupPermissionModeFromSession', () => {
  it('keeps the baseline when the last turn carried a newer permission override', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        getMetadataSnapshot: () => createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 10 }),
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: 'safe-yolo', updatedAt: 20 }),
      },
    });

    expect(res).toEqual({ mode: 'default', updatedAt: 10 });
  });

  it('prefers newer metadata over older user messages', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        getMetadataSnapshot: () => createTestMetadata({ permissionMode: 'yolo', permissionModeUpdatedAt: 30 }),
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: 'default', updatedAt: 20 }),
      },
    });

    expect(res).toEqual({ mode: 'yolo', updatedAt: 30 });
  });

  it('does not infer a baseline from a turn when metadata has no permission timestamp', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        getMetadataSnapshot: () => createTestMetadata({ permissionMode: 'yolo' }),
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: 'safe-yolo', updatedAt: 20 }),
      },
    });

    expect(res).toEqual({ mode: 'yolo', updatedAt: 0 });
  });

  it('uses canonical baseline timestamp handling without inferring a turn mode', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        // Malformed persisted content is a genuine storage boundary fixture.
        getMetadataSnapshot: () => ({ ...createTestMetadata({ permissionMode: 'yolo' }), permissionModeUpdatedAt: '999' }) as unknown as Metadata,
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: 'safe-yolo', updatedAt: 20 }),
      },
    });

    expect(res).toEqual({ mode: 'yolo', updatedAt: 0 });
  });

  it('does not infer a baseline from a turn when metadata permissionMode is invalid', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        // Malformed persisted content is a genuine storage boundary fixture.
        getMetadataSnapshot: () => ({ ...createTestMetadata({ permissionModeUpdatedAt: 30 }), permissionMode: 'not-a-real-mode' }) as unknown as Metadata,
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: 'safe-yolo', updatedAt: 20 }),
      },
    });

    expect(res).toBeNull();
  });

  it('returns null when neither metadata nor messages specify a permission mode', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        getMetadataSnapshot: () => createTestMetadata(),
        fetchLatestUserPermissionIntentFromTranscript: async () => null,
      },
    });

    expect(res).toBeNull();
  });

  it('does not fetch transcript intent for fresh sessions', async () => {
    const fetchLatestUserPermissionIntentFromTranscript = vi.fn(async () => {
      throw new Error('should not fetch transcript for fresh sessions');
    });

    const res = await resolveStartupPermissionModeFromSession({
      sessionKind: 'fresh',
      session: {
        getMetadataSnapshot: () => createTestMetadata({ permissionMode: 'yolo', permissionModeUpdatedAt: 30 }),
        fetchLatestUserPermissionIntentFromTranscript,
      },
    });

    expect(res).toEqual({ mode: 'yolo', updatedAt: 30 });
    expect(fetchLatestUserPermissionIntentFromTranscript).not.toHaveBeenCalled();
  });
});
