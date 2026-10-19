import { describe, expect, it } from 'vitest';
import { DiscussionSecondOpinionPreviewInputV1Schema, DiscussionSecondOpinionSourceV1Schema } from './secondOpinion.js';
import { prepareAnchoredDiscussionCreateV1 } from '../actions/executor/discussionSecondOpinion.js';

describe('second opinion disclosure boundary', () => {
  it('creates a Doc source through the canonical sealed comment grammar and identity-only anchor', () => {
    const passage = { ref: { kind: 'doc' as const, serverId: 'home', artifactId: 'document' },
      revision: { headerVersion: 1, bodyVersion: 2 }, range: { start: 0, end: 6 }, quote: 'secret' };
    const created = prepareAnchoredDiscussionCreateV1({ source: { kind: 'doc_passage', passage },
      title: 'Discuss this passage', quote: passage.quote, creationLocalId: 'discussion-local', quoteLocalId: 'comment-local' });
    expect(created.anchor).toEqual({ kind: 'doc', doc: { ref: passage.ref, revision: passage.revision } });
    expect(JSON.stringify(created.anchor)).not.toContain('secret');
    expect(created.firstMessage.content).toEqual({ kind: 'doc_passage_comment', passage,
      content: { v: 1, parts: [{ t: 'text', text: passage.quote }] } });
  });
  it('keeps document plaintext out of preview while preserving the canonical source for the confirmed Action', () => {
    const passage = { ref: { kind: 'doc', serverId: 'home', artifactId: 'document' },
      revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 6 }, quote: 'secret' };
    expect(DiscussionSecondOpinionSourceV1Schema.safeParse({ kind: 'doc_passage', passage }).success).toBe(true);
    const source = { kind: 'doc_passage', doc: { ref: passage.ref, revision: passage.revision } };
    expect(DiscussionSecondOpinionPreviewInputV1Schema.parse({ source, reviewers: [] })).toEqual({ source, reviewers: [] });
    for (const value of [
      { source: { kind: 'doc_passage', passage }, reviewers: [] },
      { source: { ...source, doc: { ...source.doc, quote: 'secret' } }, reviewers: [] },
      { source, reviewers: [], question: 'secret' },
      { source, reviewers: [{ selection: { kind: 'session', session: { serverId: 'home', sessionId: 'reviewer', accountId: 'forged-custody' } } }] },
    ]) expect(DiscussionSecondOpinionPreviewInputV1Schema.safeParse(value).success).toBe(false);
  });
});
