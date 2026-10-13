import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    storage.setState(previousState, true);
  });

  it('resolves null when aborted', async () => {
    const abortController = new AbortController();
    const baseline = captureAssistantTextMessageBaseline('s1');
    const waitPromise = waitForNextAssistantTextMessage(
      's1', baseline.baselineIds, baseline.baselineCount, 60_000, abortController.signal,
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
    const waitPromise = waitForNextAssistantTextMessage('s1', baseline.baselineIds, baseline.baselineCount, 60_000);
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
