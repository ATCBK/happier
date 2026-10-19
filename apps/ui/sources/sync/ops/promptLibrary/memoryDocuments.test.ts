import { describe, expect, it } from 'vitest';
import { MemoryDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';

import { memoryDocumentActions, readMemoryActionOutcome, readMemoryDuplicateReview } from './memoryDocuments';

describe('memory Action receipts', () => {
  it('replays an explicit restore choice through the real UI Action and captured Artifact CAS', async () => {
    const body = MemoryDocBodyV1Schema.parse({ v: 1, index: [
      { id: 'existing', text: 'Use PostgreSQL', createdAtMs: 1, sourceSessionRef: null },
    ], topics: [{ title: 'archive', summary: 'History', facts: [
      { id: 'archived', text: 'Use PostgreSQL', createdAtMs: 0, sourceSessionRef: null },
    ] }] });
    const fixture = await createPlainArtifactHomeFixture('https://memory-restore-choice.test', {
      handleRequest: async path => path.startsWith('/v1/public-shares?') ? Response.json({ publicShares: [] }) : null,
    });
    try {
      await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'memory',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
      await withUiPromptLibraryArtifactStore(async (store, account) => {
        const target = { ref: { kind: 'doc' as const, artifactId: 'memory', serverId: account.serverId },
          serverId: account.serverId, accountId: account.accountId, isCurrent: () => true,
          expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
        const reviewResult = await memoryDocumentActions.restore(target, 'archived');
        expect(readMemoryActionOutcome(reviewResult)).toBe('review');
        const review = readMemoryDuplicateReview(reviewResult);
        if (!review) throw new Error('Expected duplicate review');
        const restored = await memoryDocumentActions.restore(target, 'archived', undefined, undefined,
          { kind: 'keep_both', expectedRevision: review.revision });
        expect(readMemoryActionOutcome(restored)).toBe('applied');
        const reopened = MemoryDocBodyV1Schema.parse(JSON.parse((await store.read('memory'))!.body!));
        expect(reopened.index.map(fact => fact.id)).toEqual(['existing', 'archived']);
        expect(reopened.topics.find(topic => topic.title === 'archive')?.facts).toEqual([]);
      }, { serverId: fixture.home.id });
    } finally { await fixture.dispose(); }
  });
  it('surfaces duplicate review as an unsaved draft with the exact target and revision', () => {
    const review = { ok: false as const, errorCode: 'memory_duplicate_choice_required',
      ref: { kind: 'doc', artifactId: 'memory', serverId: 'home' }, revision: { headerVersion: 1, bodyVersion: 3 },
      candidates: [{ factId: 'old', text: 'Use PostgreSQL', match: 'related' }] };
    const receipt = { ok: true as const, result: review };
    expect(readMemoryActionOutcome(receipt)).toBe('review');
    expect(readMemoryActionOutcome({ ok: true, result: { ...review, revision: undefined } })).toBe('refused');
  });
  it('distinguishes a durable fact whose scope attachment conflicted from an attached fact', () => {
    const receipt = { ok: true as const, artifactId: 'created-memory', factId: 'saved-fact',
      ref: { kind: 'doc' as const, artifactId: 'created-memory', serverId: 'home-a' } };
    expect(readMemoryActionOutcome({ ok: true, result: { ...receipt, attachment: 'conflict' } })).toBe('conflict');
    expect(readMemoryActionOutcome({ ok: true, result: { ...receipt, attachment: 'attached' } })).toBe('applied');
    expect(readMemoryActionOutcome({ ok: false, error: 'version_mismatch', errorCode: 'version_mismatch' })).toBe('conflict');
  });
});
