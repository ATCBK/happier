import { describe, expect, it } from 'vitest';

import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import { handleSessionNewMessageUpdate } from '@/api/session/sessionNewMessageUpdate';
import type { Update, UserMessage } from '@/api/types';
import { prepareSessionInputForProviderDispatch } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';

describe('createPermissionModeQueueState (queue key)', () => {
  it('keeps a continue answer as data until a real input and preserves that input authority', async () => {
    let receive: ((message: UserMessage) => boolean | void) | undefined;
    const state = createPermissionModeQueueState({
      session: { onUserMessage(handler: typeof receive) { receive = handler; },
        updateMetadata() {}, getMetadataSnapshot: () => ({}) } as unknown as Parameters<typeof createPermissionModeQueueState>[0]['session'],
      agentTargetKey: 'agent.test', initialPermissionMode: 'default',
    });
    const emit = (message: UserMessage) => { if (!receive) throw new Error('missing_transport'); receive(message); };
    emit({ role: 'user', localId: 'returned-input', content: { type: 'text', text: '/clear\nKeep the existing database' },
      pendingProviderAction: 'send', meta: {
        happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
        happierInputAuthorityV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
          permission: { admittedPermissionCeiling: 'read-only' }, returnedAnswer: {
            requestSessionId: 'c' + 'a'.repeat(24), requestLocalId: 'question-1', outcome: 'answer', delivery: 'next_turn',
          } },
      } });
    expect(state.messageQueue.size()).toBe(0);
    let started = false;
    const waiting = state.messageQueue.waitForMessagesAndGetAsString().then(batch => { started = true; return batch; });
    await Promise.resolve();
    expect(started).toBe(false);
    emit({ role: 'user', localId: 'human-input', content: { type: 'text', text: 'Continue the migration' },
      meta: { happierProvenanceV1: { v: 1, kind: 'cli' }, happierInputAuthorityV1: {
        v: 1, producer: 'cli', caller: { kind: 'host' }, permission: { admittedPermissionCeiling: 'default' },
      } } });
    const batch = await waiting;
    expect(batch?.message).toMatchObject({ localId: 'human-input', text: 'Continue the migration',
      // Retained context keeps its exact identity but is not another native primary input.
      localIds: ['human-input'], returnedAnswerContext: [expect.objectContaining({ localId: 'returned-input' })],
      causalPermissionAuthority: { admittedPermissionCeiling: 'default' }, inputProvenance: { kind: 'cli' } });
    if (!batch) throw new Error('missing_real_input');
    const prepared = await prepareSessionInputForProviderDispatch({ prompt: batch.message,
      transformedUserText: batch.message.text, providerNativeCommand: false, signal: new AbortController().signal,
      localId: batch.message.localId });
    expect(prepared.requiredPrompt).toContain('Keep the existing database');
    expect(prepared.requiredPrompt).toContain('question-1');
    expect(prepared.requiredPrompt).not.toContain('reply_action=');
    expect(prepared.requiredPrompt.endsWith('Continue the migration')).toBe(true);
    state.messageQueue.close();
  });
  it('keeps Bob and Carol requests to the same Bot separate through authenticated delivery and batching', async () => {
    let receive: ((message: UserMessage) => boolean | void) | undefined;
    const session = {
      onUserMessage(handler: typeof receive) { receive = handler; },
      updateMetadata() {}, getMetadataSnapshot: () => ({}),
    };
    const state = createPermissionModeQueueState({
      // The Session transport boundary is replaced; admission, projection and queue are real.
      session: session as unknown as Parameters<typeof createPermissionModeQueueState>[0]['session'],
      agentTargetKey: 'agent.test', initialPermissionMode: 'default',
    });
    for (const [index, accountId] of ['bob', 'carol'].entries()) {
      const update = {
        id: `update-${index}`, seq: index + 1, createdAt: 1,
        body: { t: 'new-message', sid: 'bot', message: {
          id: `message-${index}`, seq: index + 1, localId: `request-${index}`, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: accountId } } },
          inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: accountId, sessionRelationship: 'sharedEditor' },
          createdAt: 1, updatedAt: 1,
        } },
      } as Update;
      handleSessionNewMessageUpdate({ update, serverId: 'home', sessionId: 'bot', mode: 'plain', ctx: null,
        receivedMessageIds: new Set(), lastObservedMessageSeq: 0, lastObservedUserMessageSeq: 0,
        emit: (event, message) => { if (event === 'user-message') receive?.(message as UserMessage); },
        debug() {}, debugLargeJson() {},
      });
    }
    expect(state.messageQueue.queue).toHaveLength(2);
    const bob = await state.messageQueue.waitForMessagesAndGetAsString();
    const carol = await state.messageQueue.waitForMessagesAndGetAsString();
    expect(bob?.message).toMatchObject({ text: 'bob', actionRequestAttributionV1: {
      requestRef: 'request-0', requester: { accountId: 'bob' }, persona: { sessionId: 'bot' },
      origin: { messageId: 'message-0' },
    } });
    expect(carol?.message).toMatchObject({ text: 'carol', actionRequestAttributionV1: {
      requestRef: 'request-1', requester: { accountId: 'carol' }, origin: { messageId: 'message-1' },
    } });
  });

  it('partitions admitted inputs with different immutable authority or prompt context', async () => {
    type QueuedTestMessage = {
      role: 'user';
      content: { type: 'text'; text: string };
      localId: string;
      meta: Record<string, unknown>;
    };
    type QueuedTestMessageHandler = (message: QueuedTestMessage) => void;

    let handler: QueuedTestMessageHandler | null = null;
    const session = {
      onUserMessage: (next: QueuedTestMessageHandler) => {
        handler = next;
      },
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };
    const state = createPermissionModeQueueState({
      session: session as any,
      agentTargetKey: 'agent.test',
      initialPermissionMode: 'default' as any,
    });
    const emit = handler ?? ((_message: QueuedTestMessage) => {
      throw new Error('expected user message handler');
    });

    emit({
      role: 'user',
      content: { type: 'text', text: 'first' },
      localId: 'authority-first',
      meta: {
        happierInputAuthorityV1: {
          v: 1,
          producer: 'cli',
          caller: { kind: 'host' },
          permission: { admittedPermissionCeiling: 'default' },
        },
      },
    });
    emit({
      role: 'user',
      content: { type: 'text', text: 'second' },
      localId: 'authority-second',
      meta: {
        happierInputAuthorityV1: {
          v: 1,
          producer: 'cli',
          caller: { kind: 'host' },
          permission: { admittedPermissionCeiling: 'read-only' },
        },
      },
    });
    emit({
      role: 'user',
      content: { type: 'text', text: 'legacy unattributed' },
      localId: 'legacy-unattributed',
      meta: {},
    });
    emit({
      role: 'user',
      content: { type: 'text', text: 'known cli' },
      localId: 'known-cli',
      meta: {
        happierProvenanceV1: { v: 1, kind: 'cli' },
      },
    });
    for (const callerDepth of [1, 3]) {
      emit({
        role: 'user', content: { type: 'text', text: `depth ${callerDepth}` },
        localId: `depth-${callerDepth}`,
        meta: { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'sender', via: 'mcp', callerDepth } },
      });
    }
    // Keep a distinct batch behind the two provenance cases so a regression
    // merges them into a visible wrong result instead of leaving this test
    // blocked waiting for a fourth queue entry.
    emit({
      role: 'user',
      content: { type: 'text', text: 'sentinel' },
      localId: 'sentinel',
      meta: { permissionMode: 'safe-yolo' },
    });

    const first = await state.messageQueue.waitForMessagesAndGetAsString();
    const second = await state.messageQueue.waitForMessagesAndGetAsString();
    const legacyUnattributed = await state.messageQueue.waitForMessagesAndGetAsString();
    const knownCli = await state.messageQueue.waitForMessagesAndGetAsString();
    const depthOne = await state.messageQueue.waitForMessagesAndGetAsString();
    const depthThree = await state.messageQueue.waitForMessagesAndGetAsString();

    expect(first?.message).toMatchObject({
      text: 'first',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'default',
      },
    });
    expect(second?.message).toMatchObject({
      text: 'second',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'read-only',
      },
    });
    expect(legacyUnattributed?.message).toMatchObject({
      text: 'legacy unattributed',
      inputContextBlock: [
        '<happier_input_context v="1">',
        'source_kind="legacyUnknown"',
        '</happier_input_context>',
      ].join('\n'),
    });
    expect(knownCli?.message).toMatchObject({
      text: 'known cli',
    });
    expect(knownCli?.message).not.toHaveProperty('inputContextBlock');
    expect(depthOne?.message).toMatchObject({ text: 'depth 1', inputProvenance: { callerDepth: 1 } });
    expect(depthThree?.message).toMatchObject({ text: 'depth 3', inputProvenance: { callerDepth: 3 } });
  });

  it('rebinds user-message delivery when the session client swaps', async () => {
    type QueuedTestMessage = {
      role: 'user';
      content: { type: 'text'; text: string };
      localId: string;
      meta: Record<string, never>;
    };
    type QueuedTestMessageHandler = (message: QueuedTestMessage) => void;

    let secondSessionHandler: QueuedTestMessageHandler | null = null;

    const firstSession = {
      onUserMessage: (_handler: QueuedTestMessageHandler) => undefined,
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };
    const secondSession = {
      onUserMessage: (handler: QueuedTestMessageHandler) => {
        secondSessionHandler = handler;
      },
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };

    const state = createPermissionModeQueueState({
      session: firstSession as any,
      initialPermissionMode: 'default' as any,
    } as any);

    state.rebindSession(secondSession as any);

    expect(secondSessionHandler).toBeTypeOf('function');
    const reboundHandler: QueuedTestMessageHandler =
      secondSessionHandler ??
      ((_message: QueuedTestMessage) => {
        throw new Error('expected rebound session handler to be registered');
      });
    reboundHandler({
      role: 'user',
      content: { type: 'text', text: 'swapped session prompt' },
      localId: 'local-swap-1',
      meta: {},
    });

    const batch = await state.messageQueue.waitForMessagesAndGetAsString();
    expect(batch?.message.text).toBe('swapped session prompt');
  });

  it('does not release an active binding identity for a stale session', () => {
    type QueuedTestMessage = {
      role: 'user';
      content: { type: 'text'; text: string };
      localId: string;
      meta: Record<string, never>;
    };
    type QueuedTestMessageHandler = (message: QueuedTestMessage) => void;

    let activeSessionHandler: QueuedTestMessageHandler | null = null;
    const activeSession = {
      onUserMessage: (handler: QueuedTestMessageHandler) => {
        activeSessionHandler = handler;
      },
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };
    const staleSession = {
      onUserMessage: (_handler: QueuedTestMessageHandler) => undefined,
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };
    const state = createPermissionModeQueueState({
      session: activeSession as any,
      agentTargetKey: 'agent.test',
      initialPermissionMode: 'default' as any,
    });
    const emit = activeSessionHandler ?? ((_message: QueuedTestMessage) => {
      throw new Error('expected active user message handler');
    });
    const message: QueuedTestMessage = {
      role: 'user',
      content: { type: 'text', text: 'retry only after current-session custody retirement' },
      localId: 'stale-session-retry',
      meta: {},
    };
    const queuedPrompt = {
      text: message.content.text,
      localId: message.localId,
      localIds: [message.localId],
    };

    emit(message);
    expect(state.messageQueue.queue).toHaveLength(1);

    state.releaseRejectedBeforeProviderPromptIdentity(staleSession as any, queuedPrompt);
    emit(message);
    expect(state.messageQueue.queue).toHaveLength(1);

    state.releaseRejectedBeforeProviderPromptIdentity(activeSession as any, queuedPrompt);
    emit(message);
    expect(state.messageQueue.queue).toHaveLength(2);
  });

  it('preserves each structured input as an isolated queued delivery without clearing peers', async () => {
    type QueuedTestMessage = {
      role: 'user';
      content: { type: 'text'; text: string };
      localId: string;
      meta: Record<string, unknown>;
    };
    type QueuedTestMessageHandler = (message: QueuedTestMessage) => void;

    let handler: QueuedTestMessageHandler | null = null;
    const session = {
      onUserMessage: (next: QueuedTestMessageHandler) => {
        handler = next;
      },
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };
    const state = createPermissionModeQueueState({
      session: session as any,
      agentTargetKey: 'agent.test',
      initialPermissionMode: 'default' as any,
    });
    const emit = handler ?? ((_message: QueuedTestMessage) => {
      throw new Error('expected user message handler');
    });

    emit({
      role: 'user',
      content: { type: 'text', text: 'first structured input' },
      localId: 'structured-first',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          skillMentions: [{ name: 'first', path: '/skills/first/SKILL.md' }],
        },
      },
    });
    emit({
      role: 'user',
      content: { type: 'text', text: 'second structured input' },
      localId: 'structured-second',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          skillMentions: [{ name: 'second', path: '/skills/second/SKILL.md' }],
        },
      },
    });

    expect(state.messageQueue.queue).toHaveLength(2);
    expect(state.messageQueue.queue.map((item) => item.isolate)).toEqual([true, true]);

    const first = await state.messageQueue.waitForMessagesAndGetAsString();
    const second = await state.messageQueue.waitForMessagesAndGetAsString();

    expect(first?.message).toMatchObject({
      text: 'first structured input',
      localId: 'structured-first',
      structuredInput: {
        skillMentions: [{ name: 'first' }],
      },
    });
    expect(second?.message).toMatchObject({
      text: 'second structured input',
      localId: 'structured-second',
      structuredInput: {
        skillMentions: [{ name: 'second' }],
      },
    });
  });
});
