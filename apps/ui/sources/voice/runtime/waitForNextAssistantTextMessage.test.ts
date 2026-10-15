import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionMessagesFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import type { Message } from '@happier-dev/session-core/messages';
import { readMountedSessionRealtimeTranscriptConsumerSessionIds } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';

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
