import { describe, expect, it } from 'vitest';

import { SessionFollowActionInputSchemasV1 } from './actions.js';
import { parseSessionFollowActionResponse, resolveSessionFollowActionRequest } from './actionTransport.js';
import { OtherSessionFollowSourceV1Schema } from './sessionFollowSourcesApi.js';

describe('generic Follow sources', () => {
  const receiver = { kind: 'session' as const, sessionId: 'receiver' };
  const sources = [
    { kind: 'discussion' as const, discussionId: 'discussion-a' },
    { kind: 'execution_run' as const, sessionId: 'parent-a', runId: 'run-a' },
    { kind: 'workflow_run' as const, runId: 'workflow-a' },
  ];

  it.each(sources)('keeps $kind as an exact source in set/get/remove/list', source => {
    const policy = { preset: 'important' as const };
    expect(SessionFollowActionInputSchemasV1['follow.set'].safeParse({ receiver, source, policy }).success).toBe(true);
    expect(SessionFollowActionInputSchemasV1['follow.get'].safeParse({ receiver, source }).success).toBe(true);
    expect(SessionFollowActionInputSchemasV1['follow.remove'].safeParse({ receiver, source }).success).toBe(true);
    expect(SessionFollowActionInputSchemasV1['follow.list'].safeParse({ direction: 'followers', source }).success).toBe(true);
    const request = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy });
    expect(request.method).toBe('PUT');
    expect(request.path).toContain('/follows/');
    expect(request.body).toMatchObject({ policy });
    const relation = OtherSessionFollowSourceV1Schema.parse({ source, destinationSessionId: receiver.sessionId, policy,
      deliveryState: 'eligible', sourceAvailability: 'available', hasPendingUpdates: false, relation: 'follower' });
    expect(parseSessionFollowActionResponse('follow.get', { receiver, source }, { source: relation }))
      .toEqual({ source: relation });
    expect(() => parseSessionFollowActionResponse('follow.get', { receiver, source },
      { source: { ...relation, source: { kind: 'discussion', discussionId: 'other' } } })).toThrow();
  });
});
