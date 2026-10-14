import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import {
  PromptBundleArtifactHeaderV1Schema,
  PromptBundleBodyV1Schema,
} from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

// The person's answer to Remove's confirmation is the boundary (the shared modal presenter).
const modalSpies = vi.hoisted(() => ({
  confirm: vi.fn(async () => false),
  alert: vi.fn(),
}));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: modalSpies }).module;
});

// The browser download / share sheet is the platform boundary of Export.
const fileSaves = vi.hoisted(() => ({ saveFileBytes: vi.fn(async (_input: { bytes: Uint8Array; fileName: string; mimeType: string }) => 'saved' as const) }));
vi.mock('@/sync/runtime/files/saveFileBytes', () => fileSaves);

installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { resetPromptLibraryCatalogEngineForTests } =
  await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } =
  await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { useSkillDetail } = await import('./useSkillDetail');
const { useReachRules } = await import('@/sync/domains/capabilities/reach/useReachRules');
const { useSkillsLibrary } = await import('@/sync/domains/skills/useSkillsLibrary');
const { getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { useSkillTextAutosave } = await import('./SkillInstructionsSection');
const { skillTextFile, readSkillText } = await import('./skillFileContent');
const { groupSkillsByFolder } = await import('../skillsCollectionModel');
const { useSkillsUpdates } = await import('../updates/useSkillsUpdates');
const { retrySkillRules } = await import('../add/skillInstall');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');

afterEach(() => {
  standardCleanup();
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  vi.useRealTimers();
  retirePresentationNotice();
});

const SKILL_MD =
  '---\nname: release-notes\ndescription: Draft release notes from merged pull requests.\n---\n\n# Release notes\n';

async function seededHome(
  origin: string,
  handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>,
  options: Readonly<{ records?: readonly PromptLibraryRecordV1[]; header?: Record<string, unknown>;
    handleExternalRequest?: (url: string) => Promise<Response | null> }> = {},
) {
  const catalog = createPromptLibraryCatalogBoundary({ records: options.records });
  const home = await createPlainArtifactHomeFixture(origin, {
    serverFeatures: createRootLayoutFeaturesResponse(),
    handleExternalRequest: options.handleExternalRequest,
    handleRequest: async (path, init) => {
      const intercepted = await handleRequest?.(path, init);
      if (intercepted) return intercepted;
      if (path === '/v2/account/settings/history')
        return Response.json({ snapshots: [] });
      return catalog.handle(path, init);
    },
  });
  const header = PromptBundleArtifactHeaderV1Schema.parse({
    v: 1,
    kind: 'prompt_bundle.v2',
    title: 'release-notes',
    bundleSchemaId: 'skills.skill_md_v1',
    ...options.header,
  });
  const body = PromptBundleBodyV1Schema.parse({
    v: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    entries: [
      {
        path: 'SKILL.md',
        contentKind: 'utf8',
        contentBase64: encodeBase64(new TextEncoder().encode(SKILL_MD)),
      },
    ],
  });
  const seeded = await home.boundary.handle('/v1/artifacts', {
    method: 'POST',
    body: JSON.stringify({
      id: 'release-notes',
      header: encodePlainArtifactStoredContent(header),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }),
  });
  expect(seeded?.status).toBe(200);
  storage.setState({ isDataReady: true, artifactsLoaded: true });
  return { ...home, catalog };
}

describe('SkillDetailScreen instructions autosave', () => {
  it('saves once per pause with the newest text, and a revision conflict keeps the text and stops saving', async () => {
    vi.useFakeTimers();
    const saves: string[] = [];
    let answer: { ok: true; revision: string } | { ok: false; code: string } = {
      ok: true,
      revision: 'r2',
    };
    const onSave = vi.fn(async (text: string) => {
      saves.push(text);
      return answer;
    });
    const hook = await renderHook(() =>
      useSkillTextAutosave({ saved: SKILL_MD, onSave }),
    );
    try {
      await act(async () => {
        hook.getCurrent().setText(`${SKILL_MD}a`);
        hook.getCurrent().setText(`${SKILL_MD}ab`);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(saves).toEqual([]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(saves).toEqual([`${SKILL_MD}ab`]);
      expect(hook.getCurrent().saveState.kind).toBe('saved');

      answer = { ok: false, code: 'revision_conflict' };
      await act(async () => {
        hook.getCurrent().setText(`${SKILL_MD}abc`);
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(hook.getCurrent().saveState.kind).toBe('conflict');
      expect(hook.getCurrent().text).toBe(`${SKILL_MD}abc`);
      await act(async () => {
        hook.getCurrent().setText(`${SKILL_MD}abcd`);
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(saves).toEqual([`${SKILL_MD}ab`, `${SKILL_MD}abc`]);
      expect(hook.getCurrent().text).toBe(`${SKILL_MD}abcd`);
    } finally {
      await hook.unmount();
    }
  });
});

describe('SkillDetailScreen over the real skills Actions', () => {
  it('keeps rules retry incomplete on a refused Account CAS and recovers without reinstalling', async () => {
    let refuse = true;
    const home = await seededHome('https://skill-rules-retry.test', async (path, init) =>
      refuse && path.endsWith('/prompt-library/skill-rules') && init?.method === 'POST'
        ? Response.json({ status: 'conflict', revision: 2 }) : null);
    const author = await renderHook(() => {
      const library = useSkillsLibrary();
      return { ...useMountedActionExecution(library.scope), retry: library.retry };
    });
    try {
      await vi.waitFor(() => expect(author.getCurrent().ready).toBe(true));
      const input = { skillId: 'release-notes', change: { kind: 'replace' as const,
        rules: [{ target: { t: 'allMachines' as const }, enabled: true }] } };
      expect(await retrySkillRules(author.getCurrent().execute, input)).toBe(false);
      expect(home.catalog.read('skill-rules').value).not.toMatchObject({ rules: expect.arrayContaining([expect.objectContaining({ skillId: 'release-notes' })]) });
      refuse = false;
      await act(async () => { author.getCurrent().retry(); });
      await vi.waitFor(() => expect(getPromptLibraryCatalogValue(storage.getState().settingsScope, 'skill-rules').status).toBe('ready'));
      expect(await retrySkillRules(author.getCurrent().execute, input)).toBe(true);
      expect(home.boundary.list()).toHaveLength(1);
      expect(home.catalog.read('skill-rules').value).toMatchObject({ rules: expect.arrayContaining([expect.objectContaining({ skillId: 'release-notes', enabled: true })]) });
    } finally { await author.unmount(); await home.dispose(); }
  });

  it('keeps a second-device edit when applying choices from an older reviewed revision, then reloads the review', async () => {
    const commit = '2'.repeat(40);
    const url = 'https://github.com/fixture/skills';
    const ref = { kind: 'gitTree', repo: url, path: 'review', commit, treeSha: '3'.repeat(40) };
    const upstreamText = `${SKILL_MD}\nUpstream instructions.`;
    const externalRequests: string[] = [];
    const home = await seededHome('https://skill-reviewed-update.test', undefined, { header: { skillLock: {
      provenance: { kind: 'link', url, ref: { ...ref, commit: '1'.repeat(40), treeSha: '4'.repeat(40) } },
      updatePolicy: 'manual', upstream: { state: 'update_available', latest: ref }, importedDigest: 'old-digest',
    } }, handleExternalRequest: async request => {
      externalRequests.push(request);
      if (request === 'https://api.github.com/repos/fixture/skills') return Response.json({ name: 'skills', default_branch: 'main' });
      if (request.includes('/marketplace.json') || request.endsWith('/plugin.json')) return new Response(null, { status: 404 });
      if (request.includes('/commits/')) return Response.json({ sha: commit });
      if (request.includes('/git/trees/')) return Response.json({ sha: ref.treeSha, tree: [
        { path: 'review', type: 'tree', mode: '040000', sha: ref.treeSha },
        { path: 'review/SKILL.md', type: 'blob', mode: '100644', sha: '5'.repeat(40), size: upstreamText.length },
      ] });
      if (request.endsWith('/review/SKILL.md')) return new Response(upstreamText);
      return new Response(null, { status: 404 });
    } });
    const hook = await renderHook(() => { const library = useSkillsLibrary(); return { library, updates: useSkillsUpdates(library) }; });
    try {
      await vi.waitFor(() => expect(hook.getCurrent().library.items.find(item => item.skillId === 'release-notes')).toBeDefined());
      await act(async () => { await hook.getCurrent().updates.loadDiff('release-notes'); });
      const reviewed = hook.getCurrent().library.items.find(item => item.skillId === 'release-notes')!;
      const applyReviewed = hook.getCurrent().updates.apply;
      expect(hook.getCurrent().updates.diffs.get(reviewed.skillId), JSON.stringify({ diff: hook.getCurrent().updates.diffs.get(reviewed.skillId), externalRequests, requests: home.requests })).toMatchObject({ status: 'ready' });
      const stored = home.boundary.read(reviewed.skillId)!;
      if (stored.bodyVersion === undefined) throw new Error('The reviewed skill must have a body revision');
      const otherText = `${SKILL_MD}\nSecond device edit.`;
      const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 2,
        entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode(otherText)) }] });
      home.boundary.replaceStoredRow({ ...stored, bodyVersion: stored.bodyVersion + 1,
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }) });
      const account = await import('@/sync/ops/actions/actionAccountContext');
      const reader = await account.captureLazyActionAccountContext(home.home.id);
      try { await reader.fetchArtifact(reviewed.skillId); } finally { reader.dispose(); }
      await act(async () => { hook.getCurrent().library.retry(); });
      await vi.waitFor(() => expect(hook.getCurrent().library.items.find(item => item.skillId === reviewed.skillId)!.revision).not.toBe(reviewed.revision));
      const newest = hook.getCurrent().library.items.find(item => item.skillId === reviewed.skillId)!;
      // A still-live callback from the old review must carry its revision even after the list refreshed.
      await act(async () => { await applyReviewed(newest, { 'SKILL.md': 'theirs' }); });
      expect(hook.getCurrent().updates.applies.get(reviewed.skillId)).toMatchObject({ status: 'failed', code: 'revision_conflict' });
      expect(home.boundary.readPlainBody(reviewed.skillId)).toBe(JSON.stringify(body));
      await vi.waitFor(() => expect(hook.getCurrent().updates.diffs.get(reviewed.skillId)).toMatchObject({ status: 'ready', revision: newest.revision }));
    } finally { await hook.unmount(); await home.dispose(); }
  });

  it('publishes a rule flip to the shared catalog and rail immediately, offers Undo, and rolls back a refused write', async () => {
    const issued = createDeferred<void>();
    const reply = createDeferred<void>();
    let held = true;
    let refuse = false;
    const home = await seededHome('https://skill-rule-undo.test', async (path, init) => {
      if (path.endsWith('/prompt-library/skill-rules') && init?.method === 'POST') {
        if (held) { issued.resolve(); await reply.promise; }
        if (refuse) return Response.json({ status: 'conflict', revision: 3 });
      }
      return null;
    });
    const author = await renderHook(() => useReachRules('skill', 'release-notes'));
    const reader = await renderHook(() => useReachRules('skill', 'release-notes'));
    const library = await renderHook(() => useSkillsLibrary());
    try {
      await vi.waitFor(() => expect(author.getCurrent().status).toBe('ready'));
      await vi.waitFor(() => expect(library.getCurrent().items.some(item => item.skillId === 'release-notes')).toBe(true));
      let change!: ReturnType<ReturnType<typeof useReachRules>['change']>;
      act(() => { change = author.getCurrent().change({ kind: 'replace', rules: [{ target: { t: 'allMachines' }, enabled: true }] }); });
      await issued.promise;
      expect(reader.getCurrent().rules[0]?.enabled).toBe(true);
      expect(getPromptLibraryCatalogValue(storage.getState().settingsScope, 'skill-rules').value?.rules.find(rule => rule.skillId === 'release-notes')?.enabled).toBe(true);
      expect(library.getCurrent().items.find(item => item.skillId === 'release-notes')?.rules[0]?.enabled).toBe(true);
      expect(readPresentationNotice()?.undo).toBeDefined();
      act(() => { readPresentationNotice()!.undo!.run(); });
      expect(reader.getCurrent().rules).toEqual([]);
      held = false;
      await act(async () => { reply.resolve(); expect(await change).toEqual({ ok: true }); });
      await vi.waitFor(() => expect(reader.getCurrent().rules).toEqual([]));
      refuse = true;
      await act(async () => { expect(await author.getCurrent().change({ kind: 'replace', rules: [{ target: { t: 'allMachines' }, enabled: true }] })).toEqual({ ok: false, message: 'conflict' }); });
      expect(reader.getCurrent().rules).toEqual([]);
      expect(library.getCurrent().items.find(item => item.skillId === 'release-notes')?.rules).toEqual([]);
    } finally {
      reply.resolve();
      await library.unmount(); await reader.unmount(); await author.unmount(); await home.dispose();
    }
  });
  it('updates with the read revision, answers revision_conflict to a stale edit, and Remove asks before skills.delete', async () => {
    const home = await seededHome('https://skill-detail.test');
    const mine = await renderHook(() => useSkillDetail('release-notes'));
    const stale = await renderHook(() => useSkillDetail('release-notes'));
    try {
      await vi.waitFor(() => expect(mine.getCurrent().status).toBe('ready'), {
        timeout: 10_000,
      });
      await vi.waitFor(() => expect(stale.getCurrent().status).toBe('ready'), {
        timeout: 10_000,
      });
      expect(mine.getCurrent().read?.provenance).toEqual({ kind: 'written' });
      stale.getCurrent().setHold(true);
      const first = mine.getCurrent().read!.revision;

      let result:
        | Awaited<ReturnType<ReturnType<typeof useSkillDetail>['update']>>
        | undefined;
      await act(async () => {
        result = await mine
          .getCurrent()
          .update({
            files: [
              {
                kind: 'upsert',
                file: skillTextFile('SKILL.md', `${SKILL_MD}One.\n`),
              },
            ],
          });
      });
      expect(result).toMatchObject({ ok: true });
      expect(mine.getCurrent().read!.revision).not.toBe(first);
      await act(async () => {
        result = await mine
          .getCurrent()
          .update({
            files: [
              {
                kind: 'upsert',
                file: skillTextFile('SKILL.md', `${SKILL_MD}Two.\n`),
              },
            ],
          });
      });
      expect(result).toMatchObject({ ok: true });

      await act(async () => {
        result = await stale
          .getCurrent()
          .update({
            files: [
              {
                kind: 'upsert',
                file: skillTextFile('SKILL.md', `${SKILL_MD}Stale.\n`),
              },
            ],
          });
      });
      expect(result).toEqual({ ok: false, code: 'revision_conflict' });
      const latest = await mine.getCurrent().readLatest();
      expect(latest?.skillMd).toBe(`${SKILL_MD}Two.\n`);

      modalSpies.confirm.mockResolvedValueOnce(false);
      let removed: boolean | 'cancelled' | undefined;
      await act(async () => {
        removed = await mine.getCurrent().remove();
      });
      expect(removed).toBe('cancelled');
      expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
      expect((await mine.getCurrent().readLatest())?.skillId).toBe(
        'release-notes',
      );

      modalSpies.confirm.mockResolvedValueOnce(true);
      await act(async () => {
        removed = await mine.getCurrent().remove();
      });
      expect(removed).toBe(true);
      expect(modalSpies.confirm).toHaveBeenCalledTimes(2);
      expect(await mine.getCurrent().readLatest()).toBeNull();
    } finally {
      await stale.unmount();
      await mine.unmount();
      await home.dispose();
    }
  });

  it('moves the skill to another folder through artifact.folder.set and the reloaded library lists it there, even when its old placement was only a legacy header', async () => {
    const home = await seededHome('https://skill-folder-move.test', undefined, {
      records: [{ key: 'folders', value: { v: 1, folders: [
        { id: 'old', name: 'Old', parentId: null }, { id: 'work', name: 'Work', parentId: null },
      ] } }],
      header: { folderId: 'old' },
    });
    const detail = await renderHook(() => useSkillDetail('release-notes'));
    const library = await renderHook(() => useSkillsLibrary());
    try {
      await vi.waitFor(() => expect(library.getCurrent().items.find((item) => item.skillId === 'release-notes')?.folderId).toBe('old'), { timeout: 10_000 });
      await vi.waitFor(() => expect(detail.getCurrent().folders.status).toBe('ready'), { timeout: 10_000 });
      let moved: boolean | undefined;
      await act(async () => { moved = await detail.getCurrent().moveToFolder('work'); });
      expect(moved).toBe(true);
      expect(home.catalog.read('folders')).toMatchObject({ key: 'folders', value: {
        artifactHeadersById: { 'release-notes': { folderId: 'work' } },
      } });
      await vi.waitFor(() => expect(library.getCurrent().items.find((item) => item.skillId === 'release-notes')?.folderId).toBe('work'), { timeout: 10_000 });
      // Reopening reads the personal placement again; a transient optimistic DTO cannot satisfy this.
      const reopened = await renderHook(() => useSkillsLibrary());
      try {
        await vi.waitFor(() => expect(reopened.getCurrent().items.find(item => item.skillId === 'release-notes')?.folderId).toBe('work'));
        const groups = groupSkillsByFolder(reopened.getCurrent().items, { v: 1, folders: [
          { id: 'old', name: 'Old', parentId: null }, { id: 'work', name: 'Work', parentId: null },
        ] });
        expect(groups?.find(group => group.id === 'work')?.rows.map(item => item.skillId)).toEqual(['release-notes']);
        expect(groups?.some(group => group.id === 'old')).toBe(false);
        // The legacy header is deliberately unchanged: canonical personal placement must win it.
        expect(home.boundary.read('release-notes')?.header).toBe(encodePlainArtifactStoredContent(
          PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'release-notes',
            bundleSchemaId: 'skills.skill_md_v1', folderId: 'old' }),
        ));
      } finally { await reopened.unmount(); }
    } finally {
      await library.unmount(); await detail.unmount(); await home.dispose();
    }
  });

  it('exports the skill as an Agent Skills zip through skills.export and hands those bytes to the person', async () => {
    const home = await seededHome('https://skill-export.test');
    const detail = await renderHook(() => useSkillDetail('release-notes'));
    try {
      await vi.waitFor(() => expect(detail.getCurrent().status).toBe('ready'), { timeout: 10_000 });
      let exported: boolean | undefined;
      await act(async () => { exported = await detail.getCurrent().exportZip(); });
      expect(exported).toBe(true);
      const saved = fileSaves.saveFileBytes.mock.calls[0]![0];
      expect(saved).toMatchObject({ fileName: 'release-notes.zip', mimeType: 'application/zip' });
      const { readSkillZipFilesV1 } = await import('@happier-dev/protocol/prompts/library/skills/skillZipV1');
      const files = await readSkillZipFilesV1(saved.bytes);
      expect(files.map((file) => file.path)).toEqual(['release-notes/SKILL.md']);
      expect(readSkillText(files[0]!.contentBase64)).toBe(SKILL_MD);
    } finally {
      await detail.unmount(); await home.dispose();
    }
  });
});
