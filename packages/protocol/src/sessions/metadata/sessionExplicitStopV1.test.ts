import { describe, expect, it } from 'vitest';
import { SessionMetadataSchema } from '../control/contract.js';
import { createSessionOwnerMetadataV1, projectSessionOwnerCompatibilityViewV1,
  projectSessionSharedMetadataV1 } from './sessionMetadataSchemasV1.js';

import {
  clearSessionExplicitStopV1FromMetadata,
  readSessionExplicitStopV1FromMetadata,
  writeSessionExplicitStopV1ToMetadata,
} from './sessionExplicitStopV1.js';

describe('explicit Session Stop intent', () => {
  const stop = { v: 1, cause: 'explicit_stop', requestId: 'stop-request-1', requestedAtMs: 123 } as const;

  it.each([undefined, 'manager-session'])('survives the persisted owner metadata projection and is readable after reload (manager %s)', managerSessionId => {
    const recorded = { ...stop, ...(managerSessionId ? { managerSessionId } : {}) };
    const metadata = writeSessionExplicitStopV1ToMetadata({}, recorded);
    expect(SessionMetadataSchema.safeParse(metadata).success).toBe(true);
    const projected = createSessionOwnerMetadataV1({ metadata });
    expect(projected).toMatchObject({
      ok: true,
      ownerMetadata: { runtime: { sessionExplicitStopV1: recorded } },
    });
    if (!projected.ok) throw new Error('Stop intent must be representable in owner metadata');
    const reloaded = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: projectSessionSharedMetadataV1({ metadata }),
      ownerMetadata: JSON.parse(JSON.stringify(projected.ownerMetadata)),
    });
    expect(readSessionExplicitStopV1FromMetadata(reloaded)).toEqual(recorded);
  });

  it('does not clear a newer Stop from a completed earlier resume', () => {
    const first = writeSessionExplicitStopV1ToMetadata({}, stop);
    const newer = writeSessionExplicitStopV1ToMetadata(first, { ...stop, requestId: 'stop-request-2' });
    expect(clearSessionExplicitStopV1FromMetadata(newer, stop.requestId)).toBe(newer);
    expect(readSessionExplicitStopV1FromMetadata(clearSessionExplicitStopV1FromMetadata(first, stop.requestId))).toBeNull();
  });

  it('fails closed on a malformed persisted Stop field', () => {
    expect(readSessionExplicitStopV1FromMetadata({ sessionExplicitStopV1: { v: 1 } })).toEqual({ status: 'invalid' });
  });
});
