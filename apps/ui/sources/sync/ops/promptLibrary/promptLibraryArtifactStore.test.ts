import { afterEach, describe, expect, it, vi } from 'vitest';
import NativeAbortController from 'abort-controller';
import { createPromptDocInLibrary, createPromptBundleInLibrary, updatePromptDocInLibrary, listPromptLibrary, readPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
  decodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { mutateArtifactOrganizationV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { storage } from '@/sync/domains/state/storage';
import {
  resetRuntimeFetch,
  setRuntimeFetch,
} from '@/utils/system/runtimeFetch';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import {
  withUiPromptLibraryArtifactReader,
  withUiPromptLibraryArtifactStore,
} from './promptLibraryArtifactStore';
import { resolvePromptStackSystemAppendBlocksV1 } from './resolvePromptStackSystemAppendBlocksV1';
import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createDeferred } from '@/dev/testkit';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { encodeBase64 } from '@/encryption/base64';

// The third-party markdown renderer is outside this Artifact-only journey.
vi.mock(
  'react-native-enriched-markdown/lib/module/web/streamingReveal.js',
  () => ({
    splitStreamingRevealTextParts: () => {
      throw new Error('Unexpected markdown rendering in Artifact test');
    },
  }),
);
let fixture:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  resetRuntimeFetch();
  vi.restoreAllMocks();
  resetServerFeaturesClientForTests();
});

async function home(
  kind = 'prompt_doc.v2',
  body = JSON.stringify({
    v: 1,
    markdown: 'original',
    createdAtMs: 1,
    updatedAtMs: 1,
  }),
  options?: Parameters<typeof createPlainArtifactHomeFixture>[1],
) {
  fixture = await createPlainArtifactHomeFixture(
    'https://prompt-qualified-read.test', options,
  );
  await fixture.boundary.handle('/v1/artifacts', {
    method: 'POST',
    body: JSON.stringify({
      id: 'current',
      header: encodePlainArtifactStoredContent({
        v: 1,
        kind,
        title: 'Current',
        ...(kind === 'prompt_bundle.v2'
          ? { bundleSchemaId: 'skills.skill_md_v1' }
          : {}),
      }),
      body: encodePlainArtifactStoredContent({ body }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }),
  });
  return fixture;
}

describe('UI qualified prompt-library Artifact authority', () => {
  it('prepares addressed skill reach from independent current catalog and content reads before writing', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const catalogRequested = createDeferred<void>();
    const releaseCatalog = createDeferred<void>();
    let holdCatalog = true;
    let contentRequested = false;
    let wroteRules = false;
    const f = await home('prompt_bundle.v2', JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1,
      entries: [{ path: 'SKILL.md', contentKind: 'utf8',
        contentBase64: encodeBase64(new TextEncoder().encode('---\nname: current\ndescription: Current skill\n---\n# Current'), 'base64') }] }), {
      handleRequest: async (path, init) => {
        if (path === '/v1/artifacts/current' || path === '/v1/artifacts/read') contentRequested = true;
        if (path === '/v1/account/entity-rows/prompt-library' && holdCatalog) {
          catalogRequested.resolve();
          await releaseCatalog.promise;
        }
        if (path === '/v1/account/entity-rows/prompt-library/skill-rules' && init?.method === 'POST') wroteRules = true;
        return catalog.handle(path, init);
      },
    });
    const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
    await withUiPromptLibraryArtifactStore(async (_store, account) => {
      const pending = executeDefaultActionInCapturedAccount(account, 'skills.rules.set', {
        items: [{ skillId: 'current' }], change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } },
      }, { surface: 'ui', authority: 'present_user', serverId: f.home.id, expectedAccountId: account.accountId });
      try {
        await catalogRequested.promise;
        await vi.waitFor(() => expect(contentRequested).toBe(true));
        expect(wroteRules).toBe(false);
      } finally {
        holdCatalog = false;
        releaseCatalog.resolve();
        await pending;
      }
      expect(await pending).toMatchObject({ ok: true, result: { ok: true, items: [
        expect.objectContaining({ skillId: 'current', rules: [expect.objectContaining({ enabled: true })] }),
      ] } });
      expect(wroteRules).toBe(true);
    }, { serverId: f.home.id });
  });
  it.each([true, false])('reads Skills through captured filtered pages with truthful unclassified fallback (%s)', async hasUnclassified => {
    const catalog = createPromptLibraryCatalogBoundary();
    const inventoryQueries: string[] = [];
    const contentRequests: string[] = [];
    const f = await home('prompt_bundle.v2', JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1,
      entries: [{ path: 'SKILL.md', contentKind: 'utf8',
        contentBase64: encodeBase64(new TextEncoder().encode('---\nname: current\ndescription: Current skill\n---\n# Current'), 'base64') }] }), {
      handleRequest: async (path, init) => {
        if (path === '/v1/artifacts/current' || path === '/v1/artifacts/read') contentRequests.push(path);
        if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') {
          inventoryQueries.push(path);
          const rows = f.boundary.list();
          const headers = rows.map(({ body: _body, ...row }) => row);
          return Response.json(new URL(path, 'https://home.test').searchParams.has('kind')
            ? { items: headers, hasUnclassified } : headers);
        }
        return catalog.handle(path, init);
      },
    });
    const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
    await withUiPromptLibraryArtifactStore(async (_store, account) => {
      const result = await executeDefaultActionInCapturedAccount(account, 'skills.list', {},
        { surface: 'ui', authority: 'present_user', serverId: f.home.id, expectedAccountId: account.accountId });
      expect(result).toMatchObject({ ok: true, result: { items: expect.arrayContaining([expect.objectContaining({ skillId: 'current' })]) } });
    }, { serverId: f.home.id });
    expect(inventoryQueries).toEqual(hasUnclassified
      ? ['/v1/artifacts?limit=500&kind=skill', '/v1/artifacts?limit=500']
      : ['/v1/artifacts?limit=500&kind=skill']);
    expect(contentRequests).toEqual(['/v1/artifacts/read']);
  });
  it.each(['complete', 'incomplete', 'unreadable', 'failed', 'different-account', 'different-credentials', 'cancelled'] as const)(
    'joins only an eligible cold inventory attempt through the unfiltered store (%s)', async scenario => {
      const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
      const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
      resetPromptLibraryCatalogEngineForTests();
      resetPromptLibraryCatalogSnapshotsForTests();
      const catalog = createPromptLibraryCatalogBoundary();
      const inventoryRequested = createDeferred<void>();
      const releaseInventory = createDeferred<void>();
      let inventoryGets = 0;
      const f = await home('prompt_doc.v2', undefined, { handleRequest: async (path, init) => {
        if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET'
          && !new URL(path, 'https://home.test').searchParams.has('kind')) {
          inventoryGets += 1;
          if (inventoryGets === 1) {
            inventoryRequested.resolve();
            await releaseInventory.promise;
            if (scenario === 'failed') return Response.json({ error: 'unavailable' }, { status: 503 });
            if (scenario === 'unreadable') return Response.json(f.boundary.list().map(row => ({ ...row, header: 'invalid header' })));
          }
        }
        return catalog.handle(path, init);
      } });
      storage.setState({ artifacts: {}, artifactsLoaded: false });
      const controller = new AbortController();
      await withUiPromptLibraryArtifactStore(async (store, account) => {
        const { fetchAndApplyArtifactsList } = await import('@/sync/engine/artifacts/syncArtifacts');
        const basis = storage.getState().artifacts;
        const params = { credentials: scenario === 'different-credentials' ? { token: 'restricted-credential' } : account.credentials,
          inventoryScope: scenario === 'different-account' ? { ...account.accountLifetime.scope, accountId: 'another-account' } : account.accountLifetime.scope,
          encryption: null, artifactDataKeys: new Map(), request: account.request,
          shouldContinue: () => scenario !== 'incomplete' || inventoryGets === 0,
          applyArtifacts: (rows: DecryptedArtifact[], source?: 'inventory') => storage.getState().applyArtifacts(rows, source === 'inventory' ? basis : undefined) };
        const inventory = fetchAndApplyArtifactsList(params).catch(error => error);
        await inventoryRequested.promise;
        const action = store.list!({ signal: controller.signal });
        try {
          if (scenario === 'different-account' || scenario === 'different-credentials') {
            // The unrelated attempt stays held while the captured list finishes.
            expect(await action).toMatchObject({ coverage: 'complete' });
            expect(inventoryGets).toBe(2);
          } else if (scenario === 'cancelled') {
            controller.abort();
            const outcome = await action.catch((error: unknown) => error);
            expect(outcome).not.toMatchObject({ coverage: 'complete' });
            expect(inventoryGets).toBe(1);
            expect(storage.getState().artifactsLoaded).toBe(false);
          } else {
            releaseInventory.resolve();
            await inventory;
            expect(await action).toMatchObject({ coverage: 'complete' });
            expect(inventoryGets).toBe(scenario === 'complete' ? 1 : 2);
          }
        } finally {
          releaseInventory.resolve();
          await inventory;
          await action.catch(() => undefined);
        }
        if (scenario === 'cancelled') expect(storage.getState().artifactsLoaded).toBe(true);
      }, { serverId: f.home.id });
    });
  it('keeps decision source admission metadata through the captured store on create and update', async () => {
    const { CoordinationMessageRefV1Schema } = await import('@happier-dev/protocol/discussions/messageRefs');
    const memoryDecisionSource = CoordinationMessageRefV1Schema.parse({ kind: 'discussion',
      discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'committed' });
    const writes: unknown[] = [];
    const f: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> = fixture = await createPlainArtifactHomeFixture('https://memory-decision.test', {
      handleRequest: async (path, init) => {
        if (path.startsWith('/v1/artifacts') && init?.method === 'POST') writes.push(JSON.parse(String(init.body)));
        // Persistence boundary for the dedicated source-admitted operations;
        // the server suite exercises the real source/disclosure predicate.
        if (path === '/v1/artifacts/memory-decision/create') return f.boundary.handle('/v1/artifacts', init);
        if (/^\/v1\/artifacts\/[^/]+\/memory-decision$/.test(path)) return f.boundary.handle(path.slice(0, -'/memory-decision'.length), init);
        return null;
      },
    });
    await withUiPromptLibraryArtifactStore(async store => {
      const header = { v: 1, kind: 'memory_doc.v1', title: 'Memory' };
      const created = await store.create!({ header, body: 'saved decision', memoryDecisionSource });
      if (typeof created === 'string') throw new Error('Expected acknowledged creation revision');
      await store.update({ artifactId: created.artifactId, expectedRevision: created.revision,
        header, body: 'corrected decision', memoryDecisionSource });
      expect((await store.read(created.artifactId))?.body).toBe('corrected decision');
    }, { serverId: f.home.id });
    expect(writes).toMatchObject([{ memoryDecisionSource }, { memoryDecisionSource }]);
  });
  it('lists synced headers without HTTP or repeated opening, with live membership and Account fencing', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const f = await home('prompt_doc.v2', undefined, { handleRequest: catalog.handle });
    const { fetchAndApplyArtifactsList } = await import('@/sync/engine/artifacts/syncArtifacts');
    const codec = await import('@/sync/engine/artifacts/syncArtifacts');
    const opening = vi.spyOn(codec, 'decryptArtifactListItems');
    await withUiPromptLibraryArtifactStore(async (store, account) => {
      storage.setState({ artifactsLoaded: false });
      await store.list!({ limit: 500 });
      expect(opening).toHaveBeenCalled();
      const readStartedWith = storage.getState().artifacts;
      await fetchAndApplyArtifactsList({ credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(),
        request: account.request,
        applyArtifacts: (rows, source) => storage.getState().applyArtifacts(rows, source === 'inventory' ? readStartedWith : undefined) });
      const requestsBefore = f.requests.length;
      opening.mockClear();
      const read = () => listPromptLibrary({ store, request: {} });
      expect(await read()).toMatchObject({ coverage: 'complete', items: [{ artifactId: 'current', title: 'Current' }] });
      const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
      const action = await executeDefaultActionInCapturedAccount(account, 'prompts.library.list', {},
        { surface: 'ui', authority: 'present_user', serverId: f.home.id, expectedAccountId: account.accountId });
      expect(action).toMatchObject({ ok: true, result: { coverage: 'complete', items: [{ artifactId: 'current' }] } });
      expect(f.requests.slice(requestsBefore).filter(request => request.method === 'GET' && request.path.startsWith('/v1/artifacts'))).toEqual([]);
      const current = storage.getState().artifacts.current!;
      if (!current.isDecrypted) throw new Error('Expected readable header');
      storage.getState().updateArtifact({ ...current, headerVersion: 2,
        rawHeader: { ...current.rawHeader, title: 'Updated' } });
      storage.getState().addArtifact({ ...current, id: 'new', rawHeader: { ...current.rawHeader, title: 'New' } });
      expect((await read()).items.map(item => item.title).sort()).toEqual(['New', 'Updated']);
      storage.getState().deleteArtifact('current');
      expect((await read()).items.map(item => item.artifactId)).toEqual(['new']);
      expect(f.requests.slice(requestsBefore).filter(request => request.method === 'GET' && request.path.startsWith('/v1/artifacts'))).toEqual([]);
      expect(opening).not.toHaveBeenCalled();
      // A new Account must use its own inventory; an already captured reader must retire.
      const oldScope = storage.getState().settingsScope;
      storage.setState({ settingsScope: { serverId: f.home.id, accountId: 'different-account' },
        profileScope: { serverId: f.home.id, accountId: 'different-account' } });
      await expect(read()).rejects.toMatchObject({ code: 'action_account_scope_changed' });
      storage.setState({ settingsScope: oldScope, profileScope: oldScope });
    }, { serverId: f.home.id });
  });
  it('reuses complete granted header pages and re-observes unreadable coverage over HTTP', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const f = await home('prompt_doc.v2', undefined, { handleRequest: catalog.handle });
    storage.setState({ artifactsLoaded: false });
    await withUiPromptLibraryArtifactStore(async (store, account) => {
      expect((await listPromptLibrary({ store, request: {} })).items.map(item => item.artifactId)).toEqual(['current']);
      expect(f.requests.some(request => request.path.startsWith('/v1/artifacts?'))).toBe(true);
      const current = await account.fetchArtifact('current');
      if (!current?.isDecrypted) throw new Error('Expected readable prompt');
      const heads = Array.from({ length: 502 }, (_, index) => ({ ...current, id: `prompt-${index}`,
        updatedAt: index, access: index === 0 ? 'view' as const : 'owner' as const,
        rawHeader: { ...current.rawHeader, title: `Prompt ${index}` } }));
      const locked: DecryptedArtifact = { id: 'locked', createdAt: 0, updatedAt: 0, headerVersion: 1, seq: 0,
        title: null, storageMode: 'e2ee', isDecrypted: false, availability: { kind: 'locked', reason: 'decryption_failed' } };
      storage.getState().applyArtifacts(heads, storage.getState().artifacts);
      const requestsBefore = f.requests.length;
      const result = await listPromptLibrary({ store, request: {} });
      expect(result.coverage).toBe('complete');
      expect(result.items).toHaveLength(502);
      expect(new Set(result.items.map(item => item.artifactId)).size).toBe(502);
      expect(result.items.at(-1)?.artifactId).toBe('prompt-0');
      expect(f.requests.slice(requestsBefore).filter(request => request.path.startsWith('/v1/artifacts'))).toEqual([]);
      storage.getState().addArtifact(locked);
      const recovered = await listPromptLibrary({ store, request: {} });
      expect(recovered).toMatchObject({ coverage: 'complete', items: [{ artifactId: 'current' }] });
      expect(recovered.items).toHaveLength(1);
      expect(f.requests.slice(requestsBefore).some(request => request.path.startsWith('/v1/artifacts?'))).toBe(true);
      // A background Home's complete store cannot stand in for this captured Account.
      storage.setState({ settingsScope: { serverId: 'another-home', accountId: account.accountId } });
      expect((await listPromptLibrary({ store, request: {} })).items.map(item => item.artifactId)).toEqual(['current']);
      expect(f.requests.slice(requestsBefore).some(request => request.path.startsWith('/v1/artifacts?'))).toBe(true);
    }, { serverId: f.home.id });
  });
  it('reads the replacement Account inventory after reset instead of the previous Account projection', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const first = await home('prompt_doc.v2', undefined, { handleRequest: catalog.handle });
    const { fetchAndApplyArtifactsList } = await import('@/sync/engine/artifacts/syncArtifacts');
    await withUiPromptLibraryArtifactStore(async (_store, account) => {
      const basis = storage.getState().artifacts;
      await fetchAndApplyArtifactsList({ credentials: account.credentials, request: account.request,
        encryption: null, artifactDataKeys: new Map(),
        applyArtifacts: (rows, source) => storage.getState().applyArtifacts(rows, source === 'inventory' ? basis : undefined) });
    }, { serverId: first.home.id });
    expect(storage.getState().artifacts.current).toBeDefined();
    await first.dispose();
    fixture = undefined;
    const nextCatalog = createPromptLibraryCatalogBoundary();
    const next = fixture = await createPlainArtifactHomeFixture(first.home.serverUrl,
      { accountId: 'replacement-account', handleRequest: nextCatalog.handle });
    storage.setState({ artifacts: {}, artifactsLoaded: false });
    await withUiPromptLibraryArtifactStore(async (store, account) => {
      expect(account.accountId).toBe('replacement-account');
      const created = await createPromptDocInLibrary({ store, request: { title: 'Next Account prompt', markdown: 'New content' } });
      const result = await listPromptLibrary({ store, request: {} });
      expect(result).toMatchObject({ coverage: 'complete', items: [{ artifactId: created.artifactId, title: 'Next Account prompt' }] });
      expect(result.items).toHaveLength(1);
    }, { serverId: next.home.id });
  });
  it('returns the real bundle creation revision even when a subsequent content read is unavailable', async () => {
    const f = fixture = await createPlainArtifactHomeFixture('https://creation-receipt.test', {
      handleRequest: async (path, init) => path.startsWith('/v1/artifacts/') && (!init?.method || init.method === 'GET')
        ? Response.json({ error: 'unavailable' }, { status: 503 }) : null,
    });
    const result = await withUiPromptLibraryArtifactStore(store => createPromptBundleInLibrary({ store,
      request: { title: 'Sample', bundleSchemaId: 'skills.skill_md_v1', entries: [{ path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: sample\n---\nInstructions').toString('base64'), contentKind: 'utf8' }] },
    }), { serverId: f.home.id });
    const row = f.boundary.read(result.artifactId)!;
    expect(result).toMatchObject({ revision: { headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } });
    expect(storage.getState().artifacts[result.artifactId]).toMatchObject({ id: result.artifactId });
  });
  it('keeps native-signal finite reads observational while explicit Artifact refresh publishes the captured row', async () => {
    const f = await home();
    storage.setState({ artifacts: {}, artifactsLoaded: false });
    await withUiPromptLibraryArtifactStore(async (store, account) => {
      const controller = new NativeAbortController();
      // React Native installs this genuine platform signal without modern convenience methods.
      const signal = controller.signal as unknown as AbortSignal;
      expect(signal.throwIfAborted).toBeUndefined();
      const read = await readPromptDocInLibrary({ store, artifactId: 'current', signal });
      expect(read).toMatchObject({ ok: true, artifactId: 'current', title: 'Current', markdown: 'original' });
      expect(storage.getState().artifacts.current).toBeUndefined();
      expect(storage.getState().artifactsLoaded).toBe(false);
      const requestsBeforeAbort = f.requests.length;
      controller.abort();
      await expect(readPromptDocInLibrary({ store, artifactId: 'current', signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(f.requests).toHaveLength(requestsBeforeAbort);
      await account.fetchArtifact('current');
      expect(storage.getState().artifacts.current).toMatchObject({ id: 'current' });
      expect(storage.getState().artifactsLoaded).toBe(false);
    }, { serverId: f.home.id });
  });
  it.each(['doc', 'bundle'] as const)('refuses a %s create after its captured active library Account retires', async libraryKind => {
    const originalUrl = 'https://captured-import-library.test';
    const nextUrl = 'https://next-import-library.test';
    const originalCatalog = createPromptLibraryCatalogBoundary();
    const nextCatalog = createPromptLibraryCatalogBoundary();
    const f = fixture = await createPlainArtifactHomeFixture(originalUrl, { handleRequest: originalCatalog.handle });
    const nextArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'artifact-account', encryptionMode: 'plain' });
    setRuntimeFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/health' || url.pathname === '/v1/features' || url.pathname === '/v1/auth/ping') return Response.json({});
      if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
      const original = url.origin === originalUrl;
      if (!original && url.origin !== nextUrl) throw new Error(`Unexpected Home ${url.origin}`);
      const path = `${url.pathname}${url.search}`;
      return await (original ? originalCatalog : nextCatalog).handle(path, init)
        ?? await (original ? f.boundary : nextArtifacts).handle(path, init)
        ?? Response.json({ error: 'not_found' }, { status: 404 });
    });
    const importing = withUiPromptLibraryArtifactStore(async store => {
      const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
      const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
      const nextHome = await upsertAndActivateServer({ serverUrl: nextUrl, scope: 'device' });
      storage.setState({ profileScope: { serverId: nextHome.id, accountId: 'artifact-account' }, settingsScope: { serverId: nextHome.id, accountId: 'artifact-account' } });
      publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
      return libraryKind === 'doc'
        ? await createPromptDocInLibrary({ store, request: { title: 'Review', markdown: '# Review' } })
        : await createPromptBundleInLibrary({ store, request: { title: 'Review', bundleSchemaId: 'skills.skill_md_v1',
          entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Review').toString('base64'), contentKind: 'utf8' }] } });
    }, { serverId: f.home.id });
    await expect(importing).rejects.toMatchObject({ code: 'action_account_scope_changed' });
    expect(f.boundary.list()).toEqual([]);
    expect(nextArtifacts.list()).toEqual([]);
  });
  it('keeps authored placement in the captured private catalog rather than shared Artifact bytes', async () => {
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'folders', value: {
      v: 1, folders: [{ id: 'mine', name: 'Mine' }],
    } }], revision: 4 });
    const f = fixture = await createPlainArtifactHomeFixture('https://personal-folder-owner.test', { handleRequest: catalog.handle });
    const result = await withUiPromptLibraryArtifactStore(store => createPromptDocInLibrary({ store,
      request: { title: 'Shared prompt', markdown: 'Content', folderId: 'mine', tags: [' Personal '] },
    }), { serverId: f.home.id });
    const header = decodePlainArtifactStoredContent(f.boundary.read(result.artifactId)!.header);
    expect(header).not.toHaveProperty('folderId');
    expect(header).not.toHaveProperty('tags');
    expect(catalog.read('folders')).toMatchObject({ value: { artifactHeadersById: {
      [result.artifactId]: { folderId: 'mine', tags: ['Personal'] },
    } } });
    expect(catalog.revision('folders')).toBe(5);
    const created = f.boundary.read(result.artifactId)!;
    // This retained row has unreadable body bytes, not a stale body-bound
    // private-metadata envelope left behind by the fixture's direct write.
    await f.boundary.handle(`/v1/artifacts/${result.artifactId}`, { method: 'POST', body: JSON.stringify({
      body: 'unreadable retained body envelope', expectedBodyVersion: created.bodyVersion,
      provenance: null, provenanceDataEncryptionKey: null,
    }) });
    const unreadable = f.boundary.read(result.artifactId)!;
    await withUiPromptLibraryArtifactStore(async store => {
      if (!store.organization) throw new Error('Missing personal owner');
      await expect(mutateArtifactOrganizationV1({ port: store.organization, artifactId: result.artifactId,
        change: { folderId: null }, expectedRevision: 5 })).resolves.toEqual({ status: 'updated', revision: 6 });
    }, { serverId: f.home.id });
    expect(f.boundary.read(result.artifactId)).toEqual(unreadable);
    expect(catalog.read('folders')).toMatchObject({ value: { artifactHeadersById: {
      [result.artifactId]: { folderId: null, tags: ['Personal'] },
    } } });
  });
  it('does not report missing from an incomplete header inventory', async () => {
    const f = await home();
    const row = f.boundary.read('current')!;
    // The genuine Home transport may carry an unreadable row; the canonical
    // header loader must preserve partial coverage rather than invent absence.
    setRuntimeFetch(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }), { status: 200 });
      if (path === '/v1/artifacts') return new Response(JSON.stringify([{ ...row, header: 'invalid stored header' }]), { status: 200 });
      return (await f.boundary.handle(path, init)) ?? new Response('{}', { status: 404 });
    });
    await expect(withUiPromptLibraryArtifactReader(reader => reader.readArtifactHeader({ kind: 'doc', artifactId: 'missing' }),
      { serverId: f.home.id })).rejects.toMatchObject({ code: 'artifact_read_unavailable' });
  });
  it('reads the current Home document again even when its display projection has a body', async () => {
    const f = await home();
    const stale: DecryptedArtifact = {
      id: 'current',
      title: 'Current',
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Current' },
      body: 'stale display body',
      headerVersion: 1,
      bodyVersion: 1,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      isDecrypted: true,
      storageMode: 'plain',
    };
    storage.setState({ artifacts: { current: stale } });
    expect(
      (
        await withUiPromptLibraryArtifactStore(
          (store) => store.read('current'),
          { serverId: f.home.id },
        )
      )?.body,
    ).toContain('original');
    await f.boundary.handle('/v1/artifacts/current', {
      method: 'POST',
      body: JSON.stringify({
        body: encodePlainArtifactStoredContent({ body: 'second current body' }),
        expectedBodyVersion: 1,
      }),
    });
    expect(
      (
        await withUiPromptLibraryArtifactStore(
          (store) => store.read('current'),
          { serverId: f.home.id },
        )
      )?.body,
    ).toBe('second current body');
  });

  it('rejects another Artifact kind even when it has a prompt-shaped body', async () => {
    const f = await home('role.v1');
    await expect(
      expandPromptTemplateInvocation({
        targetArtifactId: 'current',
        argsText: '',
        serverId: f.home.id,
      }),
    ).rejects.toThrow();
  });

  it('refuses an aborted caller before capturing credentials or issuing HTTP', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    setRuntimeFetch(request);
    await expect(
      withUiPromptLibraryArtifactStore((store) => store.read('current'), {
        serverId: 'retired',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves a concurrent write through the real qualified Artifact CAS', async () => {
    const f = await home();
    f.boundary.beforeNextUpdate(async () => {
      await f.boundary.handle('/v1/artifacts/current', {
        method: 'POST',
        body: JSON.stringify({
          body: encodePlainArtifactStoredContent({ body: 'concurrent' }),
          expectedBodyVersion: 1,
        }),
      });
    });
    await expect(
      withUiPromptLibraryArtifactStore(
        (store) =>
          updatePromptDocInLibrary({
            store,
            request: {
              artifactId: 'current',
              title: 'Stale overwrite',
              markdown: 'stale',
            },
          }),
        { serverId: f.home.id },
      ),
    ).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(f.boundary.readPlainBody('current')).toBe('concurrent');
  });

  it('suppresses a required memory document using only current header facts', async () => {
    const f = await home(
      'memory_doc.v1',
      '{ malformed body must never be loaded }',
    );
    // The owning Artifact route admits 500 rows per structural page. Put the
    // selected document on the next page to distinguish absence from a window.
    for (let index = 0; index < 500; index++) {
      await f.boundary.handle('/v1/artifacts', {
        method: 'POST',
        body: JSON.stringify({
          id: `zz-other-${index}`,
          header: encodePlainArtifactStoredContent({
            v: 1,
            kind: 'prompt_doc.v2',
            title: 'Other',
          }),
          body: encodePlainArtifactStoredContent({ body: 'Never loaded' }),
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }),
      });
    }
    const blocks = await withUiPromptLibraryArtifactReader(
      (reader) =>
        resolvePromptStackSystemAppendBlocksV1({
          surface: 'coding',
          accountEntries: [
            {
              id: 'memory',
              ref: { kind: 'doc', artifactId: 'current' },
              enabled: true,
              required: true,
              placement: 'system_append',
            },
          ],
          memoryEnabled: false,
          ...reader,
        }),
      { serverId: f.home.id },
    );
    expect(blocks).toEqual({ blocks: [], admittedEntries: [] });
    expect(
      f.requests.filter(
        (request) =>
          request.method === 'GET' && request.path === '/v1/artifacts/current',
      ),
    ).toEqual([]);
  });
});
