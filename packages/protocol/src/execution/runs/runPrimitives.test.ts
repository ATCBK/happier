import { describe, expect, it } from 'vitest';

import { buildRunScopedExecutionPermissionRequestId, readRunScopedExecutionPermissionRequestIdentity } from './runPrimitives.js';

describe('Run-scoped Session prompt identity', () => {
  it('preserves encoded Run, occurrence and native request identifiers without sibling-prefix matches', () => {
    const identity = { runId: 'review:one', controllerOccurrenceId: 'occurrence:/two', providerRequestId: 'folder:question%three' };
    const requestId = buildRunScopedExecutionPermissionRequestId(identity);
    expect(readRunScopedExecutionPermissionRequestIdentity(requestId)).toEqual(identity);
    expect(readRunScopedExecutionPermissionRequestIdentity(requestId)?.runId).not.toBe('review:one-more');
  });

  it('does not attribute unscoped or malformed identities to a Run', () => {
    for (const requestId of ['question', 'execution-run:review:question', 'execution-run::occurrence:question',
      'execution-run:review::question', 'execution-run:review:occurrence:bad%']) {
      expect(readRunScopedExecutionPermissionRequestIdentity(requestId)).toBeNull();
    }
  });
});
