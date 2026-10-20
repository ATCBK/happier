import { describe, expect, it } from 'vitest';

import { getActionSpec, listActionCliCommandDeclarations } from './actionSpecs.js';
import { actionCliDerivedDefault } from './actionCliProjection.js';

describe('Home Discussion friendly CLI projection', () => {
  it('publishes every user discussion intent under the canonical friendly path', () => {
    const byPath = new Map(
      listActionCliCommandDeclarations().map(({ spec, binding }) => [binding.path.join(' '), spec.id]),
    );

    expect([...byPath.entries()].filter(([path]) => path.startsWith('discussions '))).toEqual([
      ['discussions pass', 'discussion.pass'],
      ['discussions second-opinion start', 'discussion.second_opinion.start'],
      ['discussions list', 'discussion.list'],
      ['discussions show', 'discussion.get'],
      ['discussions read', 'discussion.read'],
      ['discussions create', 'discussion.create'],
      ['discussions post', 'discussion.post'],
      ['discussions rename', 'discussion.rename'],
      ['discussions archive', 'discussion.archive'],
      ['discussions restore', 'discussion.restore'],
      ['discussions read-state', 'discussion.read_state.set'],
      ['discussions reply', 'discussion.reply'],
      ['discussions participants list', 'discussion.participants.list'],
      ['discussions candidates list', 'discussion.candidates.list'],
      ['discussions invite', 'discussion.invite'],
      ['discussions participants policy set', 'discussion.participant.policy.set'],
      ['discussions participants remove', 'discussion.participant.remove'],
      ['discussions leave', 'discussion.leave'],
      ['discussions owner transfer', 'discussion.owner.transfer'],
      ['discussions access grants list', 'discussion.access.grants.list'],
      ['discussions access grants set', 'discussion.access.grants.set'],
      ['discussions access grants remove', 'discussion.access.grants.remove'],
    ]);
    for (const actionId of byPath.values()) {
      if (!actionId.startsWith('discussion.')) continue;
      expect(getActionSpec(actionId).cli?.acceptsServerId, actionId).toBe(true);
    }
  });

  it('binds scalar create input to distinct durable identities and canonical message content', () => {
    const spec = getActionSpec('discussion.create');
    const caller = spec.cli?.inputSchema?.parse({
      title: 'Release readiness',
      message: 'All provider migrations are green.',
      mentionedAccountIds: ['account-a', 'account-b'],
    });

    expect(spec.cli?.bindInput?.(caller, {
      actionId: spec.id,
      invocationId: 'invocation-1',
    })).toEqual({
      creationLocalId: actionCliDerivedDefault('discussion-invocation-1'),
      title: 'Release readiness',
      firstMessage: {
        localId: 'message-invocation-1',
        content: { v: 1, parts: [{ t: 'text', text: 'All provider migrations are green.' }] },
        mentionedAccountIds: ['account-a', 'account-b'],
      },
    });
  });

  it('binds scalar post input while preserving an explicit retry identity', () => {
    const spec = getActionSpec('discussion.post');
    const caller = spec.cli?.inputSchema?.parse({
      discussionId: 'discussion-1',
      message: 'Please review this.',
      mentionedAccountIds: ['account-a'],
      localId: 'retry-post-1',
    });

    expect(spec.cli?.bindInput?.(caller, {
      actionId: spec.id,
      invocationId: 'invocation-2',
    })).toEqual({
      discussionId: 'discussion-1',
      localId: 'retry-post-1',
      content: { v: 1, parts: [{ t: 'text', text: 'Please review this.' }] },
      mentionedAccountIds: ['account-a'],
    });
  });

  it('feeds explicit CLI retry IDs through the strict canonical create consumer unchanged', () => {
    const spec = getActionSpec('discussion.create');
    const caller = spec.cli?.inputSchema?.parse({
      title: 'Release readiness', message: 'Please review.',
      creationLocalId: 'create-retry-1', messageLocalId: 'first-post-retry-1',
    });
    const bound = spec.cli?.bindInput?.(caller, { actionId: spec.id, invocationId: 'later-invocation' });
    expect(spec.inputSchema.parse(bound)).toMatchObject({
      creationLocalId: 'create-retry-1', firstMessage: { localId: 'first-post-retry-1' },
    });
  });

  it('normalizes authored CLI text at the Action binding before strict Discussion validation', () => {
    const create = getActionSpec('discussion.create');
    const createCaller = create.cli?.inputSchema?.parse({
      title: 'Cafe\u0301 review',
      message: 'Re\u0301sume\u0301 findings',
    });
    expect(create.cli?.bindInput?.(createCaller, {
      actionId: create.id,
      invocationId: 'invocation-nfc',
    })).toEqual(expect.objectContaining({
      title: 'Café review',
      firstMessage: expect.objectContaining({
        content: { v: 1, parts: [{ t: 'text', text: 'Résumé findings' }] },
      }),
    }));

    const post = getActionSpec('discussion.post');
    const postCaller = post.cli?.inputSchema?.parse({
      discussionId: 'discussion-1',
      message: 'Cafe\u0301 follow-up',
    });
    expect(post.cli?.bindInput?.(postCaller, {
      actionId: post.id,
      invocationId: 'invocation-post-nfc',
    })).toEqual(expect.objectContaining({
      content: { v: 1, parts: [{ t: 'text', text: 'Café follow-up' }] },
    }));

    const rename = getActionSpec('discussion.rename');
    const renameCaller = rename.cli?.inputSchema?.parse({
      discussionId: 'discussion-1',
      title: 'Re\u0301sume\u0301 review',
    });
    expect(rename.cli?.bindInput?.(renameCaller, {
      actionId: rename.id,
      invocationId: 'invocation-rename-nfc',
    })).toEqual({
      discussionId: 'discussion-1',
      title: 'Résumé review',
    });
  });

});
