import { describe, expect, it } from 'vitest';

import * as equality from './equality.js';
import { DiscussionMessageContentV1Schema } from './content.js';
import { DiscussionMessageV1Schema } from './models.js';

describe('Discussion resource equality', () => {
  it('binds passage and proposal authored intent while excluding settled read disposition and randomized envelopes', () => {
    const revision = { headerVersion: 1, bodyVersion: 2 };
    const passage = { ref: { kind: 'doc', artifactId: 'doc', serverId: 'home' }, revision,
      range: { start: 0, end: 3 }, quote: 'old', prefix: '', suffix: ' text' };
    const comment = { kind: 'doc_passage_comment', passage, content: { v: 1, parts: [{ t: 'text', text: 'Clarify' }] } };
    const proposal = { kind: 'doc_edit_proposal', proposal: { target: passage, baseRevision: revision,
      before: 'old', after: 'new', reason: 'clarify' } };
    const serialize = (content: unknown) => equality.serializeDiscussionMutationEqualityIntentV1({
      kind: 'post', content: DiscussionMessageContentV1Schema.parse(content), mentionedAccountIds: [],
    });
    const commentIntent = serialize(comment);
    for (const changed of [
      { ...comment, passage: { ...passage, ref: { ...passage.ref, artifactId: 'other' } } },
      { ...comment, passage: { ...passage, revision: { ...revision, headerVersion: 2 } } },
      { ...comment, passage: { ...passage, range: { start: 1, end: 4 } } },
      { ...comment, passage: { ...passage, quote: 'OLD' } },
      { ...comment, content: { v: 1, parts: [{ t: 'text', text: 'Different' }] } },
    ]) expect(serialize(changed)).not.toBe(commentIntent);
    const proposalIntent = serialize(proposal);
    for (const changed of [
      { ...proposal, proposal: { ...proposal.proposal, after: 'different' } },
      { ...proposal, proposal: { ...proposal.proposal, reason: 'different' } },
      { ...proposal, proposal: { ...proposal.proposal, target: { ...passage, ref: { ...passage.ref, serverId: 'other' } } } },
      { ...proposal, proposal: { ...proposal.proposal, target: { ...passage, revision: { ...revision, bodyVersion: 3 } }, baseRevision: { ...revision, bodyVersion: 3 } } },
    ]) expect(serialize(changed)).not.toBe(proposalIntent);
    for (const [ciphertext, disposition] of [
      ['cipher-one', { state: 'open' }],
      ['cipher-two', { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 3 }, decidedBy: { accountId: 'person', atMs: 2 } }],
      ['cipher-three', { state: 'declined', decidedBy: { accountId: 'person', atMs: 2 } }],
    ] as const) {
      const opened = { ...DiscussionMessageV1Schema.parse({ id: 'message', discussionId: 'discussion', localId: 'local', seq: 1,
        authorAccountId: null, accountActor: null, producerV1: null, content: { t: 'encrypted', c: ciphertext },
        mentionedAccountIds: [], createdAt: 1, docEditProposalDispositionV1: disposition }), content: DiscussionMessageContentV1Schema.parse(proposal) };
      expect(equality.serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...opened })).toBe(proposalIntent);
    }
  });
  it('keeps first-message retry evidence stable across create and post while separating resource keys', () => {
    const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Question' }] };
    const intent = equality.serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content, mentionedAccountIds: [] });
    const key = new Uint8Array(32).fill(1);
    const tag = equality.deriveDiscussionMutationEqualityTagV1({ dataKey: key, canonicalIntent: intent });
    expect(equality.deriveDiscussionMutationEqualityTagV1({ dataKey: key, canonicalIntent: intent })).toBe(tag);
    expect(equality.deriveDiscussionMutationEqualityTagV1({ dataKey: new Uint8Array(32).fill(2), canonicalIntent: intent }))
      .not.toBe(tag);
    expect(equality.deriveDiscussionMutationEqualityTagV1({
      dataKey: key,
      canonicalIntent: equality.serializeDiscussionMutationEqualityIntentV1({
        kind: 'create', title: { v: 1, title: 'Title' }, firstMessage: { localId: 'first', content, mentionedAccountIds: [] },
      }),
    })).not.toBe(tag);
  });
});
