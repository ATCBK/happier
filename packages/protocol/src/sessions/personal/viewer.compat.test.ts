import { describe, expect, it } from 'vitest';

import { SessionViewerProjectionV1Schema } from './viewer.js';

const VIEWER = {
  latestFailureSeq: null,
  readState: { state: 'not_started' as const },
  relevance: { relevant: false, reasons: [] },
  attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
  follow: { follows: false, notificationLevel: null },
  notification: { level: 'none' as const, source: 'none' as const },
};

describe('SessionViewerProjectionV1 compatibility', () => {
  it('drops additive viewer facts while keeping known fields strict', () => {
    expect(SessionViewerProjectionV1Schema.parse({
      ...VIEWER,
      futureViewerFact: { observed: true },
    })).toEqual(VIEWER);

    expect(SessionViewerProjectionV1Schema.safeParse({
      ...VIEWER,
      latestFailureSeq: undefined,
    }).success).toBe(false);
  });
});
