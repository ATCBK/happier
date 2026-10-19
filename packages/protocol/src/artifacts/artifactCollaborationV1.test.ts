import { describe, expect, it } from 'vitest';
import { DocEditProposalV1Schema, DocPassageRefV1Schema } from './artifactCollaborationV1.js';

const passage = {
  ref: { kind: 'doc' as const, artifactId: 'doc-1', serverId: 'home-1' },
  revision: { headerVersion: 2, bodyVersion: 3 },
  range: { start: 8, end: 13 },
  quote: 'again',
};

describe('Doc collaboration authored content', () => {
  it('retains the exact source occurrence and full revision without treating context as authority', () => {
    expect(DocPassageRefV1Schema.parse({ ...passage, prefix: 'again / ', suffix: '!' }))
      .toEqual({ ...passage, prefix: 'again / ', suffix: '!' });
    expect(DocPassageRefV1Schema.safeParse({ ...passage, range: { start: 13, end: 8 } }).success).toBe(false);
    expect(DocPassageRefV1Schema.safeParse({ ...passage, quote: 'different' }).success).toBe(false);
    expect(DocPassageRefV1Schema.safeParse({ ...passage, ref: { ...passage.ref, accountId: 'forged' } }).success).toBe(false);
    expect(DocPassageRefV1Schema.safeParse({ ...passage, range: { ...passage.range, unit: 'dom' } }).success).toBe(false);
  });

  it('admits replacement or deletion only on the exact quoted revision basis', () => {
    const proposal = { target: passage, baseRevision: passage.revision, before: 'again', after: '', reason: 'Remove repetition' };
    expect(DocEditProposalV1Schema.parse(proposal)).toEqual(proposal);
    expect(DocEditProposalV1Schema.safeParse({ ...proposal, baseRevision: { headerVersion: 3, bodyVersion: 3 } }).success).toBe(false);
    expect(DocEditProposalV1Schema.safeParse({ ...proposal, before: 'other' }).success).toBe(false);
    expect(DocEditProposalV1Schema.safeParse({ ...proposal, decidedBy: { accountId: 'forged', atMs: 1 } }).success).toBe(false);
  });

  it('counts UTF-16 code units rather than Unicode code points', () => {
    expect(DocPassageRefV1Schema.safeParse({ ...passage, range: { start: 0, end: 2 }, quote: '😀' }).success).toBe(true);
    expect(DocPassageRefV1Schema.safeParse({ ...passage, range: { start: 0, end: 1 }, quote: '😀' }).success).toBe(false);
  });
});
