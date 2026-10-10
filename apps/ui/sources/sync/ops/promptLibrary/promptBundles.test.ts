import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { createPromptBundleInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';
import {
  createPromptBundleArtifact,
  createSkillPromptBundle,
  duplicatePromptBundle,
  listPromptBundleSupportingEntries,
  readSkillMarkdownFromPromptBundleBody,
  removeSkillPromptBundleEntry,
  updateSkillPromptBundle,
  updateSkillPromptBundleWithEntry,
} from './promptBundles';

let fixture:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
let catalog = createPromptLibraryCatalogBoundary();
const bundleWriteSettings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
  'prompt_bundle.create': ['ui'], 'prompt_bundle.update': ['ui'],
} } };
// Transform the real Account/Sync graph outside the behavior-test deadline.
beforeAll(async () => {
  await import('@/sync/ops/actions/actionAccountContext');
  await import('@/sync/domains/state/storage');
  await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
}, 300_000);
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
});
async function home() {
  catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'folders', value: { v: 1,
    folders: [{ id: 'folder-1', name: 'Personal' }] } }] });
  fixture = await createPlainArtifactHomeFixture(
    'https://prompt-bundle-operations.test',
    { handleRequest: (path, init) => path === '/v2/account/settings'
      ? Promise.resolve(Response.json({ version: 2, content: { t: 'plain', v: bundleWriteSettings } }))
      : catalog.handle(path, init) },
  );
  await fixture.hydrateAccountSettings();
  return fixture;
}

describe('promptBundles qualified operations', () => {
  it.each(['create', 'update', 'duplicate', 'edit', 'remove'] as const)('refuses a disabled %s without changing content or personal organization', async operation => {
    const f = await home();
    const { artifactId: id } = await withUiPromptLibraryArtifactStore(store => createPromptBundleInLibrary({ store, request: {
      title: 'Original', bundleSchemaId: 'skills.skill_md_v1', entries: [
        { path: 'SKILL.md', contentBase64: Buffer.from('Original').toString('base64'), contentKind: 'utf8' },
        { path: 'reference.txt', contentBase64: Buffer.from('Reference').toString('base64'), contentKind: 'utf8' },
      ],
    } }));
    const before = f.boundary.list();
    const organizationBefore = catalog.read('folders');
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/account/settings') return Response.json({ version: 3, content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: { [operation === 'create' || operation === 'duplicate' ? 'prompt_bundle.create' : 'prompt_bundle.update']: { disabledSurfaces: ['ui'] } } },
      } } });
      if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ version: 0, updatedAt: 0, settingsVersion: 3 }));
      return await catalog.handle(`${url.pathname}${url.search}`, init) ?? await f.boundary.handle(`${url.pathname}${url.search}`, init)
        ?? Response.json({}, { status: 404 });
    });
    await f.hydrateAccountSettings();
    const expectedRevision = { headerVersion: 1, bodyVersion: 1 };
    const mutation = operation === 'create' ? createSkillPromptBundle({ title: 'Denied copy', skillMarkdown: 'Denied' })
      : operation === 'duplicate' ? duplicatePromptBundle(id)
      : operation === 'update' ? updateSkillPromptBundle({ artifactId: id, title: 'Denied', skillMarkdown: 'Denied', expectedRevision })
      : operation === 'edit' ? updateSkillPromptBundleWithEntry({ artifactId: id, path: 'reference.txt', content: 'Denied', expectedRevision })
      : removeSkillPromptBundleEntry({ artifactId: id, path: 'reference.txt', expectedRevision });
    await expect(mutation).rejects.toMatchObject({ code: 'action_disabled' });
    expect(f.boundary.list()).toEqual(before);
    expect(catalog.read('folders')).toEqual(organizationBefore);
  });
  it.each([false, true])('keeps bundle placement personal and retains the created identity if its row write conflicts (%s)', async conflict => {
    const f = await home();
    if (conflict) catalog = createPromptLibraryCatalogBoundary({ records: [catalog.read('folders')], mutationOutcome: 'conflict', revision: 2 });
    const create = createPromptBundleArtifact({ title: 'Shared prompts', bundleSchemaId: 'bundle.generic_v1',
      entries: [{ path: 'review.md', contentBase64: Buffer.from('Review').toString('base64'), contentKind: 'utf8' }],
      folderId: 'folder-1', tags: [' Personal '],
    });
    if (conflict) await expect(create).rejects.toMatchObject({ code: 'artifact_organization_failed', details: {
      organization: { status: 'conflict', revision: 2 },
    } });
    else {
      const id = await create;
      expect(catalog.read('folders').value).toMatchObject({ artifactHeadersById: { [id]: { folderId: 'folder-1', tags: ['Personal'] } } });
    }
    const saved = f.boundary.list();
    expect(saved).toHaveLength(1);
    const header = decodePlainArtifactStoredContent(saved[0]!.header);
    expect(header).not.toHaveProperty('folderId');
    expect(header).not.toHaveProperty('tags');
    expect(header).toMatchObject({ bundleSchemaId: 'bundle.generic_v1' });
  });
  it('creates a starter SKILL.md for empty authoring and preserves imported files on duplication', async () => {
    const f = await home();
    const starterId = await createSkillPromptBundle({
      title: 'Starter',
      skillMarkdown: '',
    });
    expect(
      readSkillMarkdownFromPromptBundleBody(
        PromptBundleBodyV1Schema.parse(
          JSON.parse(f.boundary.readPlainBody(starterId)!),
        ),
      ),
    ).toContain('## When to use');
    const { artifactId: importedId } = await withUiPromptLibraryArtifactStore(store => createPromptBundleInLibrary({ store, request: {
      title: 'Imported',
      bundleSchemaId: 'skills.skill_md_v1',
      origin: 'imported',
      folderId: 'folder-1',
      tags: ['shared'],
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('# Skill').toString('base64'),
          contentKind: 'utf8',
        },
        {
          path: 'templates/example.txt',
          contentBase64: Buffer.from('example').toString('base64'),
          contentKind: 'utf8',
        },
      ],
    } }));
    const copyId = await duplicatePromptBundle(importedId);
    expect(copyId).not.toBe(importedId);
    expect(
      decodePlainArtifactStoredContent(f.boundary.read(copyId)!.header),
    ).toMatchObject({
      kind: 'prompt_bundle.v2',
      title: 'Imported Copy',
      origin: 'user',
    });
    expect(catalog.read('folders').value).toMatchObject({ artifactHeadersById: {
      [copyId]: { folderId: 'folder-1', tags: ['shared'] },
    } });
    expect(JSON.parse(f.boundary.readPlainBody(copyId)!).entries).toEqual(
      JSON.parse(f.boundary.readPlainBody(importedId)!).entries,
    );
  });

  it('preserves the generic bundle schema for imported non-skill entries', async () => {
    const f = await home();
    const id = await createPromptBundleArtifact({
      title: 'Shared prompts',
      bundleSchemaId: 'bundle.generic_v1',
      entries: [
        {
          path: 'prompts/review.md',
          contentBase64: Buffer.from('Review checklist').toString('base64'),
          contentKind: 'utf8',
        },
      ],
    });
    expect(
      decodePlainArtifactStoredContent(f.boundary.read(id)!.header),
    ).toMatchObject({ bundleSchemaId: 'bundle.generic_v1' });
    const copyId = await duplicatePromptBundle(id);
    expect(decodePlainArtifactStoredContent(f.boundary.read(copyId)!.header)).toMatchObject({ bundleSchemaId: 'bundle.generic_v1' });
    expect(JSON.parse(f.boundary.readPlainBody(copyId)!).entries).toEqual(JSON.parse(f.boundary.readPlainBody(id)!).entries);
  });

  it.each(['duplicate', 'edit'] as const)('accepts retained bundle annotations when deriving a canonical %s', async operation => {
    const f = await home();
    const id = await createSkillPromptBundle({ title: 'Retained', skillMarkdown: 'Retained instructions' });
    const body = JSON.parse(f.boundary.readPlainBody(id)!);
    const response = await f.boundary.handle(`/v1/artifacts/${id}`, { method: 'POST', body: JSON.stringify({
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ ...body, futureBodyHint: 'retained',
        entries: body.entries.map((entry: Record<string, unknown>) => ({ ...entry, futureEntryHint: 'retained' })),
      }) }),
      expectedBodyVersion: 1,
      provenance: null,
      provenanceDataEncryptionKey: null,
    }) });
    expect(response?.ok).toBe(true);
    let savedId = id;
    if (operation === 'duplicate') savedId = await duplicatePromptBundle(id);
    else await updateSkillPromptBundleWithEntry({ artifactId: id, path: 'reference.txt', content: 'Reference',
      expectedRevision: { headerVersion: 1, bodyVersion: 2 } });
    const saved = JSON.parse(f.boundary.readPlainBody(savedId)!);
    expect(readSkillMarkdownFromPromptBundleBody(PromptBundleBodyV1Schema.parse(saved))).toBe('Retained instructions');
    expect(saved).not.toHaveProperty('futureBodyHint');
    expect(saved.entries[0]).not.toHaveProperty('futureEntryHint');
    if (operation === 'edit') expect(listPromptBundleSupportingEntries(PromptBundleBodyV1Schema.parse(saved)).map(entry => entry.path)).toEqual(['reference.txt']);
  });

  it('updates SKILL.md and supporting files through current reads while preserving creation time and title', async () => {
    const f = await home();
    const id = await createSkillPromptBundle({
      title: 'Stored title',
      skillMarkdown: 'old skill',
    });
    const original = JSON.parse(f.boundary.readPlainBody(id)!);
    await updateSkillPromptBundleWithEntry({
      artifactId: id,
      path: 'templates/review.md',
      content: 'review body',
    });
    const acceptedRevision = await updateSkillPromptBundle({
      artifactId: id,
      title: 'New title',
      skillMarkdown: 'new skill',
      expectedRevision: { headerVersion: 2, bodyVersion: 2 },
    });
    expect(acceptedRevision).toEqual({ headerVersion: 3, bodyVersion: 3 });
    const withSupporting = PromptBundleBodyV1Schema.parse(
      JSON.parse(f.boundary.readPlainBody(id)!),
    );
    expect(withSupporting.createdAtMs).toBe(original.createdAtMs);
    expect(readSkillMarkdownFromPromptBundleBody(withSupporting)).toBe(
      'new skill',
    );
    expect(
      listPromptBundleSupportingEntries(withSupporting).map(
        (entry) => entry.path,
      ),
    ).toEqual(['templates/review.md']);
    await removeSkillPromptBundleEntry({
      artifactId: id,
      path: 'templates/review.md',
    });
    expect(
      PromptBundleBodyV1Schema.parse(
        JSON.parse(f.boundary.readPlainBody(id)!),
      ).entries.map((entry) => entry.path),
    ).toEqual(['SKILL.md']);
    expect(
      decodePlainArtifactStoredContent(f.boundary.read(id)!.header),
    ).toMatchObject({ title: 'New title' });
  });

  it('refuses a stale reviewed skill revision without rebasing its draft over a native winner', async () => {
    const f = await home();
    const id = await createSkillPromptBundle({ title: 'Reviewed', skillMarkdown: 'Reviewed instructions' });
    const reviewed = { headerVersion: 1, bodyVersion: 1 };
    await updateSkillPromptBundle({ artifactId: id, title: 'Native winner', skillMarkdown: 'Native winner instructions' });
    const winner = f.boundary.read(id)!;
    await expect(updateSkillPromptBundle({ artifactId: id, title: 'Stale draft', skillMarkdown: 'Stale reviewed instructions',
      expectedRevision: reviewed })).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(f.boundary.read(id)).toEqual(winner);
    expect(readSkillMarkdownFromPromptBundleBody(PromptBundleBodyV1Schema.parse(JSON.parse(f.boundary.readPlainBody(id)!))))
      .toBe('Native winner instructions');
  });

  it('refuses to convert a wrong-kind Artifact with a bundle-shaped body into a skill', async () => {
    const f = await home();
    const id = await createSkillPromptBundle({ title: 'Original', skillMarkdown: 'Non-skill content' });
    const response = await f.boundary.handle(`/v1/artifacts/${id}`, { method: 'POST', body: JSON.stringify({
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Not a skill' }),
      expectedHeaderVersion: 1,
    }) });
    expect(response?.ok).toBe(true);
    const original = f.boundary.read(id)!;
    await expect(updateSkillPromptBundle({ artifactId: id, title: 'Converted', skillMarkdown: 'Overwrite' }))
      .rejects.toMatchObject({ code: 'prompt_bundle_invalid_kind' });
    expect(f.boundary.read(id)).toEqual(original);
  });

  it('returns the exact committed content revision when independent personal placement loses CAS', async () => {
    const f = await home();
    const id = await createSkillPromptBundle({ title: 'Reviewed', skillMarkdown: 'Reviewed instructions' });
    catalog = createPromptLibraryCatalogBoundary({ records: [catalog.read('folders')], mutationOutcome: 'conflict', revision: 4 });
    await expect(updateSkillPromptBundle({ artifactId: id, title: 'Committed content', skillMarkdown: 'Committed instructions',
      expectedRevision: { headerVersion: 1, bodyVersion: 1 }, tags: ['uncommitted placement'] }))
      .rejects.toMatchObject({ code: 'artifact_organization_failed', details: { artifactId: id,
        contentRevision: { headerVersion: 2, bodyVersion: 2 }, organization: { status: 'conflict', revision: 4 } } });
    expect(f.boundary.read(id)).toMatchObject({ headerVersion: 2, bodyVersion: 2 });
    expect(readSkillMarkdownFromPromptBundleBody(PromptBundleBodyV1Schema.parse(JSON.parse(f.boundary.readPlainBody(id)!))))
      .toBe('Committed instructions');
    const folders = catalog.read('folders');
    if (folders.key !== 'folders') throw new Error('Wrong catalog');
    expect(folders.value.artifactHeadersById?.[id]?.tags ?? []).toEqual([]);
  });

  it.each(['edit', 'remove'] as const)('refuses a stale reviewed supporting-file %s without rebasing on a native winner', async operation => {
    const f = await home();
    const id = await createSkillPromptBundle({ title: 'Reviewed', skillMarkdown: 'Reviewed instructions' });
    await updateSkillPromptBundleWithEntry({ artifactId: id, path: 'reference.txt', content: 'Reviewed reference' });
    const expectedRevision = { headerVersion: 2, bodyVersion: 2 };
    await updateSkillPromptBundleWithEntry({ artifactId: id, path: 'reference.txt', content: 'Native winner reference' });
    const winner = f.boundary.read(id)!;
    const change = operation === 'edit'
      ? updateSkillPromptBundleWithEntry({ artifactId: id, path: 'reference.txt', content: 'Stale draft', expectedRevision })
      : removeSkillPromptBundleEntry({ artifactId: id, path: 'reference.txt', expectedRevision });
    await expect(change).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(f.boundary.read(id)).toEqual(winner);
  });
});
