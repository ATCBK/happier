import { describe, expect, it } from 'vitest';
import { buildComposerReferenceMentionPayloadV1, readComposerReferenceMentionV1 } from './composerReferenceProviderV1.js';
const REFERENCE = { pluginId: 'acme.issues', localId: 'issues' } as const;

describe('composer reference persisted identity', () => {
  it('writes only the qualified reference, opaque candidate id, and advisory label into the incumbent mention element', () => {
    const payload = buildComposerReferenceMentionPayloadV1({
      reference: REFERENCE,
      candidate: { id: 'issue:42', label: 'Issue 42', description: 'Current sprint issue' },
    });

    expect(payload).toEqual({
      kind: 'happier.composerReference',
      ref: 'composerReference:issue:42',
      composerReference: REFERENCE,
      label: 'Issue 42',
    });
    expect(readComposerReferenceMentionV1({
      ...payload,
      token: '@issue-42',
    })).toEqual({
      reference: REFERENCE,
      candidateId: 'issue:42',
      label: 'Issue 42',
    });
    expect(readComposerReferenceMentionV1({
      ...payload,
      ref: 'other:issue:42',
      token: '@issue-42',
    })).toBeNull();
    expect(readComposerReferenceMentionV1({
      kind: 'happier.composerReference',
      ref: 'composerReference:issue:42',
      composerReferenceProvider: REFERENCE,
      token: '@issue-42',
    })).toBeNull();
  });
});
