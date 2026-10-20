import { beforeEach, describe, expect, it } from 'vitest';

import {
  txSessionFindUnique,
  createSessionAccessProjectionRelations,
  createSessionRouteTestBuilder,
  resetSessionRouteMocks,
  txSessionFindFirst,
  txSessionMessageFindFirst,
} from './sessionRoutes.testkit';

// Load the real route graph during suite setup, before timing request behavior.
await createSessionRouteTestBuilder('POST', '/v1/sessions/:sessionId/messages/action-reference/resolve');

describe('session Message Action reference resolution route', () => {
  const reference = {
    v: 1,
    sessionId: 'session-1',
    messageId: 'message-1',
    observedRevision: 'message-updated-at:1000',
  } as const;

  beforeEach(() => {
    resetSessionRouteMocks();
    txSessionFindUnique.mockResolvedValue({
      ...createSessionAccessProjectionRelations(),
      id: reference.sessionId,
      accountId: 'u1',
    });
    txSessionFindFirst.mockReset();
    txSessionMessageFindFirst.mockReset();
  });

  it('re-resolves only the opaque reference through current access and the retained publication fence', async () => {
    txSessionMessageFindFirst.mockResolvedValue({
      id: reference.messageId,
      sessionId: reference.sessionId,
      seq: 7,
      messageRole: 'agent',
      updatedAt: new Date(1000),
    });
    txSessionFindFirst.mockResolvedValue({
      currentStorageState: 'hosted',
      acceptedThroughServerSeq: null,
      publishedThroughServerSeq: null,
    });

    const route = await createSessionRouteTestBuilder(
      'POST',
      '/v1/sessions/:sessionId/messages/action-reference/resolve',
    );
    const { response } = await route.invoke({
      params: { sessionId: reference.sessionId },
      body: reference,
    });

    expect(response).toEqual({
      status: 'available',
      message: {
        sessionId: reference.sessionId,
        messageId: reference.messageId,
        observedRevision: reference.observedRevision,
        seq: 7,
        messageRole: 'agent',
      },
    });
    expect(JSON.stringify(response)).not.toContain('content');
    expect(txSessionMessageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: reference.messageId,
        sessionId: reference.sessionId,
      }),
      select: {
        id: true,
        sessionId: true,
        seq: true,
        messageRole: true,
        updatedAt: true,
      },
    }));
  });

  it('does not create an existence oracle when Session access is gone', async () => {
    txSessionFindUnique.mockResolvedValue(null);

    const route = await createSessionRouteTestBuilder(
      'POST',
      '/v1/sessions/:sessionId/messages/action-reference/resolve',
    );
    const { response } = await route.invoke({
      params: { sessionId: reference.sessionId },
      body: reference,
    });

    expect(response).toEqual({ status: 'unavailable' });
    expect(txSessionMessageFindFirst).toHaveBeenCalled();
    expect(txSessionFindFirst).not.toHaveBeenCalled();
  });
});
