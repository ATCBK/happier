import { describe, expect, it } from 'vitest';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import {
  appendNextTurnContextToQueuedPrompt,
  combinePermissionModeQueuedPrompts,
  isNextTurnContextQueuedPrompt,
  normalizePermissionModeQueuedPromptLocalIds,
  type PermissionModeQueuedPrompt,
  type PermissionModeQueuedPromptMode,
} from './queuedPrompt';

describe('combinePermissionModeQueuedPrompts', () => {
  it('retains a quiet returned answer without replacing the natural input native witness', async () => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => mode.permissionMode, {
      batcher: combinePermissionModeQueuedPrompts, isContextOnly: isNextTurnContextQueuedPrompt,
      withContext: appendNextTurnContextToQueuedPrompt,
    });
    const reply = { requestSessionId: 'requester', requestLocalId: 'question', outcome: 'answer' as const,
      delivery: 'next_turn' as const };
    queue.push({ text: 'The retained answer', localId: 'quiet-answer', userMessageSeq: 8, returnedAnswer: reply },
      { permissionMode: 'read-only' });
    expect(queue.size()).toBe(0);
    const authority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const };
    queue.push({ text: 'Continue', localId: 'natural-input', userMessageSeq: 9, causalPermissionAuthority: authority },
      { permissionMode: 'default' });
    const batch = await queue.waitForMessagesAndGetAsString();
    expect(batch?.message).toMatchObject({ localId: 'natural-input', localIds: ['natural-input'], userMessageSeq: 9,
      userMessageSeqs: [9], causalPermissionAuthority: authority,
      returnedAnswerContext: [{ reply, text: 'The retained answer', localId: 'quiet-answer', userMessageSeq: 8 }] });
  });

  it('does not merge distinct protected Discussion questions into one turn cutoff', () => {
    const discussionAddressing = { discussionId: 'discussion', messageId: 'first', throughSeq: 2, participantSessionId: 'receiver' };
    const prompt = { text: 'First question', localId: 'first-input', discussionAddressing };
    expect(combinePermissionModeQueuedPrompts([prompt])).toMatchObject({ discussionAddressing });
    expect(() => combinePermissionModeQueuedPrompts([prompt, { text: 'Second question', localId: 'second-input',
      discussionAddressing: { ...discussionAddressing, messageId: 'second', throughSeq: 3 } }])).toThrow();
  });
  it('retains the exact request cause and refuses to coalesce different requesters', () => {
    const bob = { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' },
      persona: { serverId: 'home', sessionId: 'bot' }, origin: null };
    const prompt = { text: 'work', localId: 'bob-input', actionRequestAttributionV1: bob };
    expect(combinePermissionModeQueuedPrompts([prompt])).toMatchObject({ actionRequestAttributionV1: bob });
    expect(() => combinePermissionModeQueuedPrompts([prompt, {
      text: 'other work', localId: 'carol-input', actionRequestAttributionV1: {
        ...bob, requestRef: 'carol-input', requester: { serverId: 'home', accountId: 'carol' },
      },
    }])).toThrow();
  });

  it('joins prompt texts and keeps the first localId', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: 'b' },
    ]);
    expect(combined.text).toBe('one\ntwo');
    expect(combined.localId).toBe('a');
  });

  it('aggregates every localId in an ordinary non-Pending batch', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: 'b' },
      { text: 'again', localId: 'a' },
      { text: 'anonymous', localId: null },
    ]);

    expect(combined).toMatchObject({
      localId: 'a',
      localIds: ['a', 'b'],
    });
  });

  it('preserves whitespace-distinct opaque local ids for exact provider outcome correlation', () => {
    expect(normalizePermissionModeQueuedPromptLocalIds({
      text: 'opaque ids',
      localId: ' local-id ',
      localIds: ['local-id', ' local-id ', '   '],
    })).toEqual([' local-id ', 'local-id']);
  });

  it('carries exact committed user-message seqs for host-consumed command replay suppression', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a', userMessageSeq: 5 },
      { text: 'two', localId: 'b' },
      { text: 'three', localId: 'c', userMessageSeq: 9 },
    ]);
    expect(combined.userMessageSeq).toBe(9);
    expect(combined.userMessageSeqs).toEqual([5, 9]);
  });

  it('preserves the exact admitted authority when queue-key-compatible prompts batch', () => {
    const authority = {
      kind: 'admittedSessionInputV1' as const,
      admittedPermissionCeiling: 'read-only' as const,
      sourceAuthority: {
        kind: 'mediatedExternal' as const,
        mediatorPluginId: 'example.plugin',
        sourceRef: 'source-1',
        sourceRevisionOrEpoch: 'rev-1',
        admittedPermissionCeiling: 'read-only' as const,
        remoteApprovalMaxScope: 'request' as const,
      },
    };
    expect(combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a', causalPermissionAuthority: authority },
      { text: 'two', localId: 'b', causalPermissionAuthority: authority },
    ] as any)).toMatchObject({ causalPermissionAuthority: authority });
  });

  it('rejects an invalid batch containing multiple structured prompts instead of discarding later context', () => {
    expect(() => combinePermissionModeQueuedPrompts([
      {
        text: 'first structured prompt',
        localId: 'structured-1',
        structuredInput: {
          v: 1,
          skillMentions: [{ name: 'first', path: '/skills/first/SKILL.md' }],
        },
      },
      {
        text: 'second structured prompt',
        localId: 'structured-2',
        structuredInput: {
          v: 1,
          skillMentions: [{ name: 'second', path: '/skills/second/SKILL.md' }],
        },
      },
    ])).toThrow('Cannot combine multiple structured prompts');
  });

  it('leaves userMessageSeq unset when no prompt in the batch carries one', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: null },
    ]);
    expect(combined.userMessageSeq ?? null).toBeNull();
  });
});
