import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import type { TrackedSession } from '../types';
import { resolveSessionReportTrackedCorrelation } from './sessionReportCorrelation';

describe('session report parent correlation', () => {
  it('awaits the process-table parent witness before adopting a wrapper child', async () => {
    const tracked: TrackedSession = { pid: 410, startedBy: 'daemon' };
    const result = await resolveSessionReportTrackedCorrelation({
      metadata: { startedBy: 'daemon' } as Metadata,
      pid: 411,
      pidToTrackedSession: new Map([[410, tracked]]),
      pidToAwaiter: new Map([[410, () => undefined]]),
      // The OS census boundary is asynchronous; the caller must await its witness.
      getParentPidFn: async () => 410,
    });
    expect(result).toEqual({ kind: 'matched', tracked });
  });

  it('does not adopt a wrapper child when the parent witness is unavailable', async () => {
    const tracked: TrackedSession = { pid: 410, startedBy: 'daemon' };
    const result = await resolveSessionReportTrackedCorrelation({
      metadata: { startedBy: 'daemon' } as Metadata,
      pid: 411,
      pidToTrackedSession: new Map([[410, tracked]]),
      pidToAwaiter: new Map([[410, () => undefined]]),
      getParentPidFn: async () => null,
    });
    expect(result).toEqual({ kind: 'none' });
  });
});
