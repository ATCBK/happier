import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionMessagesFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import type { Message } from '@happier-dev/session-core/messages';
import { readMountedSessionRealtimeTranscriptConsumerSessionIds } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

import { captureAssistantTextMessageBaseline, waitForNextAssistantTextMessage } from './waitForNextAssistantTextMessage';

describe('waitForNextAssistantTextMessage', () => {
  let previousState: ReturnType<typeof storage.getState>;

  beforeEach(() => {
    previousState = storage.getState();
    storage.setState({ sessionMessages: {}, sessions: { s1: createSessionFixture({ id: 's1', serverId: 'waiter-home' }) } });
  });

  afterEach(() => {
    vi.useRealTimers();
    storage.setState(previousState, true);
  });

  it('retains transcript demand for a reply after 65 seconds until the owning turn ends', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const baseline = captureAssistantTextMessageBaseline('s1');
    const waiting = waitForNextAssistantTextMessage(
      's1', baseline.baselineIds, baseline.baselineCount, controller.signal,
    );
    try {
      await vi.advanceTimersByTimeAsync(65_000);
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).toContain('s1');
      const reply = { id: 'late', kind: 'agent-text', text: 'A slow reply.', localId: null, createdAt: Date.now() } satisfies Message;
      storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: [reply.id], messagesById: { [reply.id]: reply },
      }) } });
      await expect(waiting).resolves.toBe(reply.text);
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).not.toContain('s1');
    } finally {
      controller.abort();
      await waiting;
    }
  });

  it('resolves null when aborted', async () => {
    const abortController = new AbortController();
    const baseline = captureAssistantTextMessageBaseline('s1');
    const waitPromise = waitForNextAssistantTextMessage(
      's1', baseline.baselineIds, baseline.baselineCount, abortController.signal,
    );
    expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).toContain('s1');

    abortController.abort();

    await expect(waitPromise).resolves.toBe(null);
    expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).not.toContain('s1');
  });

  it('waits for the submitted turn final anchor instead of speaking progress or another turn', async () => {
    const controller = new AbortController();
    const baseline = captureAssistantTextMessageBaseline('s1');
    let settled = false;
    const waiting = waitForNextAssistantTextMessage('s1', baseline.baselineIds, baseline.baselineCount, controller.signal, 'voice-input')
      .then(value => { settled = true; return value; });
    const user = { id: 'user', kind: 'user-text', text: 'question', localId: 'voice-input', seq: 17, createdAt: 1 } satisfies Message;
    const progress = { id: 'progress', kind: 'agent-text', text: 'I will inspect the files.', localId: null, seq: 18, createdAt: 2 } satisfies Message;
    const final = { id: 'final', kind: 'agent-text', text: 'The requested answer.', localId: null, seq: 20, createdAt: 3 } satisfies Message;
    const later = { id: 'later', kind: 'agent-text', text: 'Another client reply.', localId: null, seq: 22, createdAt: 4 } satisfies Message;
    const publish = (messages: Message[], terminal: boolean) => storage.setState({
      sessions: { s1: { ...storage.getState().sessions.s1!, sessionTurns: buildSessionTurnsProjectionV1({
        sessionId: 's1', updatedAt: terminal ? 3 : 2, turns: [{ turnId: 'already-running', startedAt: 1, updatedAt: 3,
          status: terminal ? 'completed' : 'in_progress', transcriptAnchors: { userMessageSeqs: [15, 17],
            ...(terminal ? { finalAssistantMessageSeq: 20, endSeqInclusive: 20 } : {}) } }],
      }) } },
      sessionMessages: { s1: createSessionMessagesFixture({ messageIdsOldestFirst: messages.map(message => message.id),
        messagesById: Object.fromEntries(messages.map(message => [message.id, message])) }) },
    });
    try {
      publish([user, progress], false);
      await Promise.resolve();
      expect(settled).toBe(false);
      publish([user, progress, later], true);
      await Promise.resolve();
      expect(settled).toBe(false);
      publish([user, progress, final, later], true);
      await expect(waiting).resolves.toBe(final.text);
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).not.toContain('s1');
    } finally { controller.abort(); await waiting; }
  });

  it.each(['streaming', 'interrupted', 'thinking', 'thinking-flag'] as const)('retains demand past %s text until a complete assistant segment arrives', async segment => {
    const controller = new AbortController();
    const baseline = captureAssistantTextMessageBaseline('s1');
    let settled = false;
    const waiting = waitForNextAssistantTextMessage('s1', baseline.baselineIds, baseline.baselineCount, controller.signal)
      .then(value => { settled = true; return value; });
    const draft = { id: 'reply', kind: 'agent-text', text: segment === 'thinking' ? 'Private reasoning' : "I'm",
      localId: 'reply-local', createdAt: 1, isThinking: segment === 'thinking-flag',
      meta: { happierStreamSegmentV1: { v: 1, segmentKind: segment === 'thinking' ? 'thinking' : 'assistant',
        segmentLocalId: 'reply-local', segmentState: segment === 'thinking' || segment === 'thinking-flag' ? 'complete' : segment,
        startedAtMs: 1, updatedAtMs: 2 } },
    } satisfies Message;
    try {
      storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: [draft.id], messagesById: { [draft.id]: draft },
      }) } });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).toContain('s1');
      const reply = { ...draft, isThinking: false, text: "I'm ready to help.",
        meta: { happierStreamSegmentV1: { ...draft.meta.happierStreamSegmentV1,
          segmentKind: 'assistant' as const, segmentState: 'complete' as const, updatedAtMs: 3 } },
      } satisfies Message;
      storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: [reply.id], messagesById: { [reply.id]: reply },
      }) } });
      await expect(waiting).resolves.toBe(reply.text);
    } finally { controller.abort(); await waiting; }
  });

  it.each([
    ['cancelled', null], ['cancelled', undefined], ['failed', null], ['completed', null],
  ] as const)('releases demand for the submitted turn with terminal %s and no reply (final sequence %s)', async (status, finalSeq) => {
    const controller = new AbortController();
    const baseline = captureAssistantTextMessageBaseline('s1');
    let settled = false;
    const waiting = waitForNextAssistantTextMessage(
      's1', baseline.baselineIds, baseline.baselineCount, controller.signal, 'voice-input',
    ).then(value => { settled = true; return value; });
    try {
      const user = { id: 'user', kind: 'user-text', text: 'hello', seq: 17, localId: 'voice-input', createdAt: 1 } satisfies Message;
      const project = (userSeq: number) => {
        const session = storage.getState().sessions.s1!;
        storage.setState({ sessions: { ...storage.getState().sessions, s1: { ...session,
          sessionTurns: buildSessionTurnsProjectionV1({ sessionId: 's1', updatedAt: 2, turns: [{
            turnId: 'turn', startedAt: 1, updatedAt: 2, status,
            transcriptAnchors: { startUserMessageSeq: userSeq, ...(finalSeq === undefined ? {} : { finalAssistantMessageSeq: finalSeq }) },
          }] }),
        } } });
      };
      storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: [user.id], messagesById: { [user.id]: user },
      }) } });
      project(16);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).toContain('s1');
      project(17);
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(controller.signal.aborted).toBe(false);
      await expect(waiting).resolves.toBeNull();
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).not.toContain('s1');
    } finally {
      controller.abort();
      await waiting;
    }
  });

  it('keeps the submitted input boundary when older replies hydrate after baseline capture', async () => {
    const controller = new AbortController();
    const baseline = captureAssistantTextMessageBaseline('s1');
    const waiting = waitForNextAssistantTextMessage('s1', baseline.baselineIds, baseline.baselineCount, controller.signal, 'voice-input');
    const oldReply = { id: 'old', kind: 'agent-text', text: 'An earlier answer.', seq: 16, localId: null, createdAt: 1 } satisfies Message;
    const user = { id: 'user', kind: 'user-text', text: 'My new question.', seq: 17, localId: 'voice-input', createdAt: 2 } satisfies Message;
    try {
      storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: [oldReply.id], messagesById: { [oldReply.id]: oldReply },
      }) } });
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).toContain('s1');
      storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: [oldReply.id, user.id], messagesById: { [oldReply.id]: oldReply, [user.id]: user },
      }) } });
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).toContain('s1');
      const reply = { id: 'new', kind: 'agent-text', text: 'The answer to your new question.', seq: 18, localId: null, createdAt: 3 } satisfies Message;
      storage.setState({ sessions: { s1: { ...storage.getState().sessions.s1!, sessionTurns: buildSessionTurnsProjectionV1({
        sessionId: 's1', updatedAt: 3, turns: [{ turnId: 'turn', startedAt: 2, updatedAt: 3, status: 'completed',
          transcriptAnchors: { userMessageSeqs: [17], finalAssistantMessageSeq: 18 } }],
      }) } }, sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: [oldReply.id, user.id, reply.id], messagesById: { [oldReply.id]: oldReply, [user.id]: user, [reply.id]: reply },
      }) } });
      await expect(waiting).resolves.toBe(reply.text);
    } finally { controller.abort(); await waiting; }
  });

  it.each([['completed', 18], ['failed', undefined]] as const)('waits for the final reply when a %s projection arrives before the transcript (final sequence %s)', async (status, finalAssistantMessageSeq) => {
    const controller = new AbortController();
    const baseline = captureAssistantTextMessageBaseline('s1');
    const waiting = waitForNextAssistantTextMessage('s1', baseline.baselineIds, baseline.baselineCount, controller.signal, 'voice-input');
    try {
      const user = { id: 'user', kind: 'user-text', text: 'hello', seq: 17, localId: 'voice-input', createdAt: 1 } satisfies Message;
      storage.setState({ sessions: { s1: { ...storage.getState().sessions.s1!, sessionTurns: buildSessionTurnsProjectionV1({
        sessionId: 's1', updatedAt: 2, turns: [{ turnId: 'turn', startedAt: 1, updatedAt: 2, status,
          transcriptAnchors: { userMessageSeqs: [17], ...(finalAssistantMessageSeq === undefined ? {} : { finalAssistantMessageSeq }) } }],
      }) } }, sessionMessages: { s1: createSessionMessagesFixture({ messageIdsOldestFirst: [user.id], messagesById: { [user.id]: user } }) } });
      expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).toContain('s1');
      const reply = { id: 'reply', kind: 'agent-text', text: 'Done.', seq: 18, localId: null, createdAt: 2,
        meta: { runtimeTurnId: 'turn', runtimeEventKind: 'transcript-message-committed' } } satisfies Message;
      storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({ messageIdsOldestFirst: [user.id, reply.id], messagesById: { [user.id]: user, [reply.id]: reply } }) } });
      await expect(waiting).resolves.toBe('Done.');
    } finally { controller.abort(); await waiting; }
  });

  it('reads new assistant replies from the real normalized transcript store', async () => {
    const user = { id: 'm1', kind: 'user-text', text: 'hello', localId: null, createdAt: 1 } satisfies Message;
    const olderReply = { id: 'm2', kind: 'agent-text', text: 'previous reply', localId: null, createdAt: 2 } satisfies Message;
    storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
      messageIdsOldestFirst: [user.id, olderReply.id],
      messagesById: { [user.id]: user, [olderReply.id]: olderReply },
    }) } });
    const baseline = captureAssistantTextMessageBaseline('s1');
    const waitPromise = waitForNextAssistantTextMessage('s1', baseline.baselineIds, baseline.baselineCount);
    expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).toContain('s1');

    const assistant = { id: 'm3', kind: 'agent-text', text: 'assistant reply', localId: null, createdAt: 3 } satisfies Message;
    storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
      messageIdsOldestFirst: [user.id, olderReply.id, assistant.id],
      messagesById: { [user.id]: user, [olderReply.id]: olderReply, [assistant.id]: assistant },
    }) } });

    await expect(waitPromise).resolves.toBe('assistant reply');
    expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('waiter-home')).not.toContain('s1');
  });
});
