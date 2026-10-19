import { describe, expect, it } from 'vitest';
import { MemoryDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ProjectSourcesUpdateInputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { memoryDocumentActions, readMemoryActionOutcome, readMemoryDuplicateReview } from './memoryDocuments';

describe('memory Action receipts', () => {
  it('attaches the first Source-bound Project memory through the real Account host without its Machine', async () => {
    let source: ProjectSourceV1 = { id: 'qa-memory-source', revision: 3, name: 'QA Memory Source', createdByAccountId: 'artifact-account', audience: [],
      repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'qa/memory', visibility: 'private' }, protocol: 'https' }, attachments: [] };
    let homeId = '';
    const fixture = await createPlainArtifactHomeFixture('https://source-first-memory.test', { currentAccount: true,
      handleRequest: async (path, init) => {
        if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
          actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'memory.remember': ['ui'] } },
        } } });
        if (path === PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list') return Response.json(createPlainProjectAccountRowListFixture({
          workspaceRefs: [{ id: 'qa-checkout', serverId: homeId, projectKey: 'qa-project', machineId: 'offline-machine',
            rootPath: '/qa/memory', createdAtMs: 1, source: { sourceId: source.id, revision: 3 } }],
        }));
        if (path.startsWith('/v1/projects/sources/' + source.id)) {
          if (init?.method === 'PATCH') {
            const input = ProjectSourcesUpdateInputV1Schema.parse(JSON.parse(String(init.body)));
            if (input.expectedRevision !== source.revision) return Response.json({ ok: false, error: 'source_conflict', current: source }, { status: 409 });
            if (input.patch.attachment?.kind !== 'attach') throw new Error('Expected attachment');
            source = { ...source, revision: source.revision + 1, attachments: [...(source.attachments ?? []), input.patch.attachment.attachment] };
          }
          return Response.json({ ok: true, source, canManage: true });
        }
        if (path.startsWith('/v1/public-shares?')) return Response.json({ publicShares: [] });
        return null;
      },
    });
    homeId = fixture.home.id;
    try {
      await fixture.hydrateAccountSettings();
      const result = await memoryDocumentActions.rememberInScope({ scope: 'project', projectRef: { serverId: homeId, projectKey: 'qa-project' } },
        { text: 'QA use the canonical context attachment.' }, homeId);
      expect(result).toMatchObject({ ok: true, result: { attachment: 'attached', ref: { kind: 'doc', serverId: homeId } } });
      const saved = fixture.boundary.list().filter(row => fixture.boundary.readPlainBody(row.id)?.includes('QA use the canonical context attachment.'));
      expect(saved).toHaveLength(1);
      expect(source.attachments).toEqual([{ purpose: 'context', entry: { id: 'project.memory', ref: {
        kind: 'doc', artifactId: saved[0]!.id, serverId: homeId }, enabled: true, placement: 'system_append' } }]);
      expect(fixture.requests.some(request => request.path.includes('/machines/'))).toBe(false);
    } finally { await fixture.dispose(); }
  });
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
