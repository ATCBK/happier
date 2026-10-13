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

// The person's answer to Remove's confirmation is the boundary (the shared modal presenter).
const modalSpies = vi.hoisted(() => ({
  confirm: vi.fn(async () => false),
  alert: vi.fn(),
}));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: modalSpies }).module;
});

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
const { skillTextFile } = await import('./skillFileContent');

afterEach(() => {
  standardCleanup();
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  vi.useRealTimers();
  retirePresentationNotice();
});

const SKILL_MD =
  '---\nname: release-notes\ndescription: Draft release notes from merged pull requests.\n---\n\n# Release notes\n';

async function seededHome(origin: string, handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>) {
  const catalog = createPromptLibraryCatalogBoundary();
  const home = await createPlainArtifactHomeFixture(origin, {
    serverFeatures: createRootLayoutFeaturesResponse(),
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
  const seed = await home.boundary.handle('/v1/artifacts', {
    method: 'POST',
    body: JSON.stringify({
      id: 'release-notes',
      header: encodePlainArtifactStoredContent(header),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }),
  });
  expect(seed?.status).toBe(200);
  storage.setState({ isDataReady: true, artifactsLoaded: true });
  return home;
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
});
