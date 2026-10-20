import { describe, expect, it } from 'vitest';

import { buildExecutionRunSessionPromptContext } from './ExecutionRunHostBridge';

describe('ExecutionRunHostBridge Session Run prompt context', () => {
  it('projects the occurrence tool snapshot and bounded Discussion provenance without authority', () => {
    const context = buildExecutionRunSessionPromptContext({
      sessionId: 'session-1',
      launchOrigin: {
        kind: 'discussion',
        serverId: 'server-1',
        discussionId: 'discussion-1',
        messageIds: ['message-1'],
        draftCorrelationId: 'draft-1',
      },
      supportedReadActions: [
        'session.transcript.get',
        'discussion.read',
      ],
    });

    expect(context).toEqual({
      kind: 'happier_session_run',
      sessionId: 'session-1',
      origin: {
        kind: 'discussion',
        serverId: 'server-1',
        discussionId: 'discussion-1',
        messageIds: ['message-1'],
      },
      supportedReadActions: [
        'session.transcript.get',
        'discussion.read',
      ],
    });
    expect(context).not.toHaveProperty('authority');
    expect(context.origin).not.toHaveProperty('sessionId');
    expect(context.origin).not.toHaveProperty('draftCorrelationId');
  });

  it('does not fabricate a Discussion origin for legacy Session/external launches', () => {
    expect(buildExecutionRunSessionPromptContext({
      sessionId: 'session-1',
      launchOrigin: { kind: 'session', sessionId: 'session-1' },
      supportedReadActions: [],
    })).toEqual({
      kind: 'happier_session_run',
      sessionId: 'session-1',
      supportedReadActions: [],
    });
  });
});
