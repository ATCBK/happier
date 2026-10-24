import type {
  PromptLibraryArtifactStore,
  PromptLibraryStoredArtifact,
} from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import { listArtifactHeadersV1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { deriveArtifactCoarseKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import type { WorkflowDefinitionArtifactOperations } from '@happier-dev/protocol/actions';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { awaitPendingArtifactInventory } from '@/sync/engine/artifacts/syncArtifacts';
import { encodeArtifactListCursor } from '@/sync/api/artifacts/apiArtifacts';
import type { ArtifactFolderActionPortV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { randomUUID } from '@/platform/randomUUID';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PromptLibraryCatalogProjection } from '@/sync/store/settings/promptLibraryCatalogSnapshot';

function readCompleteAccountArtifactInventory(scope: ServerAccountScope) {
  const state = readRegisteredStorageState();
  if (!state?.artifactsLoaded
    || !areServerAccountScopesEqual(getActiveServerAccountScope(), scope)
    || !areServerAccountScopesEqual(state.settingsScope, scope)) return null;
  const rows = Object.values(state.artifacts);
  // Loaded membership can still contain a refused header observation.
  return rows.every(artifact => artifact.isDecrypted && artifact.rawHeader && artifact.access !== undefined) ? rows : null;
}

/** Keep reads and the writes they derive in one exact Home/Account lifetime. */
export async function withUiPromptLibraryArtifactStore<T>(
  run: (store: PromptLibraryArtifactStore, account: LazyActionAccountContext) => Promise<T>,
  options?: Readonly<{ serverId?: string | null; expectedAccountId?: string; signal?: AbortSignal }>,
): Promise<T> {
  throwIfAborted(options?.signal);
  const serverId =
    options?.serverId?.trim() || getActiveServerAccountScope()?.serverId;
  if (!serverId)
    throw Object.assign(new Error('Prompt library Home is unavailable'), {
      code: 'content_unavailable',
    });
  const { captureLazyActionAccountContext } =
    await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(
    serverId,
    options?.signal,
  );
  try {
    if (options?.expectedAccountId !== undefined && options.expectedAccountId !== account.accountId)
      throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    return await run(
      createUiPromptLibraryArtifactStore(account.workflowArtifacts, account),
      account,
    );
  } finally {
    account.dispose();
  }
}

/** A preparation owns these qualified reads and discards them when it finishes. */
export async function withUiPromptLibraryArtifactReader<T>(
  run: (
    reader: Readonly<{
      readArtifact(
        ref: PromptArtifactRefV1,
      ): Promise<PromptLibraryStoredArtifact | null>;
      readArtifactHeader(
        ref: PromptArtifactRefV1,
      ): Promise<Readonly<{
        header: Readonly<Record<string, unknown>> | null;
        access: PromptLibraryStoredArtifact['access'];
      }> | null>;
    }>,
  ) => Promise<T>,
  options?: Readonly<{ serverId?: string | null; signal?: AbortSignal; accountContext?: LazyActionAccountContext }>,
): Promise<T> {
  const defaultServerId =
    options?.serverId?.trim() || options?.accountContext?.serverId || getActiveServerAccountScope()?.serverId;
  const accounts = new Map<string, Promise<LazyActionAccountContext>>();
  const headers = new Map<
    string,
    Promise<Readonly<{ items: ReadonlyMap<string, Readonly<{ header: Readonly<Record<string, unknown>>; access: PromptLibraryStoredArtifact['access'] }>>; coverage: 'complete' | 'partial' }>>
  >();
  const accountFor = (ref: PromptArtifactRefV1) => {
    throwIfAborted(options?.signal);
    const serverId = ref.serverId?.trim() || defaultServerId;
    if (!serverId)
      throw Object.assign(new Error('Prompt library Home is unavailable'), {
        code: 'content_unavailable',
      });
    const borrowed = options?.accountContext;
    if (borrowed && areServerProfileIdentifiersEquivalent(serverId, borrowed.serverId)) {
      borrowed.assertCurrent();
      return { serverId: borrowed.serverId, pending: Promise.resolve(borrowed) };
    }
    let pending = accounts.get(serverId);
    if (!pending) {
      pending = import('@/sync/ops/actions/actionAccountContext').then(
        ({ captureLazyActionAccountContext }) =>
          captureLazyActionAccountContext(serverId, options?.signal),
      );
      accounts.set(serverId, pending);
    }
    return { serverId, pending };
  };
  try {
    return await run({
      readArtifact: async (ref) => {
        const { pending } = accountFor(ref);
        const account = await pending;
        return createUiPromptLibraryArtifactStore(
          account.workflowArtifacts, account,
        ).read(ref.artifactId, { signal: options?.signal });
      },
      readArtifactHeader: async (ref) => {
        const { serverId, pending } = accountFor(ref);
        let inventory = headers.get(serverId);
        if (!inventory) {
          inventory = pending.then(async (account) => {
            const page = await listArtifactHeadersV1({
              options: { includeBody: false, signal: options?.signal },
              readPage: (options) => account.listArtifacts(options ?? {}),
              encodeCursor: (item) =>
                account.encodeArtifactListCursor({
                  artifactId: item.artifactId,
                  updatedAt: item.updatedAt,
                }),
            });
            account.assertCurrent();
            return { items: new Map(page.items.map((item) => [item.artifactId, { header: item.header, access: item.access }])), coverage: page.coverage };
          });
          headers.set(serverId, inventory);
        }
        const page = await inventory;
        const artifact = page.items.get(ref.artifactId);
        (await pending).assertCurrent();
        if (!artifact) {
          if (page.coverage !== 'complete') throw Object.assign(new Error('Artifact header inventory is incomplete'), { code: 'artifact_read_unavailable' });
          return null;
        }
        if (Object.keys(artifact.header).length === 0)
          throw Object.assign(new Error('Artifact header is locked'), {
            code: 'content_unavailable',
          });
        return artifact;
      },
    });
  } finally {
    await Promise.all(
      [...accounts.values()].map(async (pending) => {
        try {
          (await pending).dispose();
        } catch {
          /* Failed captures release their own lifetime. */
        }
      }),
    );
  }
}

/** The Action host already owns an exact Account Artifact transport and CAS. */
export function createUiPromptLibraryArtifactStore(
  artifacts: WorkflowDefinitionArtifactOperations,
  account?: LazyActionAccountContext,
): PromptLibraryArtifactStore {
  const storedArtifact = (artifact: Awaited<ReturnType<WorkflowDefinitionArtifactOperations['read']>>): PromptLibraryStoredArtifact | null => artifact ? {
    id: artifact.artifactId, revision: artifact.revision, header: artifact.header,
    body: typeof artifact.body === 'string' ? artifact.body : null,
    owned: artifact.access === 'owner', access: artifact.access,
  } : null;
  // Parallel row demands share this captured read only until it settles. The
  // observed catalog lifecycle alone owns retained Settings/history maintenance.
  let catalogRead: Readonly<{ signal: AbortSignal | undefined; pending: Promise<PromptLibraryCatalogProjection> }> | null = null;
  const organization: ArtifactFolderActionPortV1 | undefined = account ? {
    serverId: account.serverId,
    matchesServerId: serverId => areServerProfileIdentifiersEquivalent(serverId, account.serverId),
    assertCurrent: account.assertCurrent,
    readCatalog: async (signal, key = 'folders') => {
      const { getPromptLibraryCatalogSnapshot, getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
      throwIfAborted(signal);
      account.assertCurrent();
      const scope = { serverId: account.serverId, accountId: account.accountId };
      // The reviewed fresh row is usable authority; the Home CAS detects any unobserved remote edit.
      // A known-stale row is never used to construct a mutation.
      const row = getPromptLibraryCatalogValue(scope, key);
      if (row.status !== 'ready' || row.stale) {
        if (!catalogRead || catalogRead.signal !== signal) {
          const read = { signal, pending: import('@/sync/api/account/apiPromptLibraryCatalog')
            .then(({ readPromptLibraryCatalogProjectionInContext }) => readPromptLibraryCatalogProjectionInContext(account, signal)) };
          catalogRead = read;
          const release = () => { if (catalogRead === read) catalogRead = null; };
          void read.pending.then(release, release);
        }
        const projection = await catalogRead.pending;
        throwIfAborted(signal);
        account.assertCurrent();
        return projection;
      }
      throwIfAborted(signal);
      account.assertCurrent();
      const projection = getPromptLibraryCatalogSnapshot(scope);
      if (!projection) throw new Error('Artifact folder catalog is unavailable');
      return projection;
    },
    writeRecord: async (input, signal) => {
      const { writePromptLibraryRecordAndPublishInContext } = await import('@/sync/api/account/apiPromptLibraryCatalog');
      return await writePromptLibraryRecordAndPublishInContext(account, input, signal);
    },
    readArtifactHeader: async (artifactId, signal) => {
      const inventory = await organization!.listArtifactHeaders(signal);
      account.assertCurrent();
      const artifact = inventory.items.find(item => item.artifactId === artifactId);
      if (!artifact) {
        if (inventory.coverage !== 'complete') throw Object.assign(new Error('artifact_inventory_incomplete'), { code: 'artifact_inventory_incomplete' });
        return null;
      }
      if (Object.keys(artifact.header).length === 0) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
      return { header: artifact.header, owned: artifact.owned };
    },
    listArtifactHeaders: async signal => {
      const page = await listArtifactHeadersV1({ options: { includeBody: false, signal },
        readPage: options => account.listArtifacts(options ?? {}),
        encodeCursor: item => account.encodeArtifactListCursor({ artifactId: item.artifactId, updatedAt: item.updatedAt }) });
      account.assertCurrent();
      return { items: page.items.map(item => ({ artifactId: item.artifactId, header: item.header, owned: item.access === 'owner' })),
        coverage: page.nextCursor ? 'partial' : page.coverage };
    },
  } : undefined;
  return {
    ...(organization ? { organization } : {}),
    ...(account ? { readMany: async (ids: readonly string[], options?: Readonly<{ signal?: AbortSignal }>) => {
      throwIfAborted(options?.signal);
      const results = await account.readArtifactContents(ids, options);
      account.assertCurrent(); throwIfAborted(options?.signal);
      return results.map(result => result.status === 'rejected' ? result
        : { status: 'fulfilled' as const, value: storedArtifact(result.value) });
    } } : {}),
    read: async (id, options) => {
      throwIfAborted(options?.signal);
      const artifact = await (account ? account.readArtifactContent(id, options) : artifacts.read(id, options));
      return storedArtifact(artifact);
    },
    create: async (input) => {
      throwIfAborted(input.signal);
      const artifactId = randomUUID();
      if (account) {
        const created = await account.createArtifactDocument({ ...input, artifactId });
        return { artifactId: created.artifactId, revision: created.revision };
      }
      await artifacts.create({ ...input, artifactId });
      return artifactId;
    },
    update: async (input) => {
      throwIfAborted(input.signal);
      const result = await artifacts.update(input);
      if (!result.ok)
        throw Object.assign(new Error(result.error), {
          code: result.errorCode,
        });
      return { revision: result.revision };
    },
    delete: async ({ artifactId, expectedRevision, signal }) => {
      throwIfAborted(signal);
      const result = await artifacts.delete(artifactId, { expectedRevision, ...(signal ? { signal } : {}) });
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    },
    list: async (options) => {
      throwIfAborted(options?.signal);
      account?.assertCurrent();
      const scope = account?.accountLifetime.scope;
      // A selective read must not wait for an unrelated full inventory scan.
      const filtered = (options?.coarseKind !== undefined || options?.kinds !== undefined) && account !== undefined;
      let rows = scope ? readCompleteAccountArtifactInventory(scope) : null;
      if (!filtered && !rows && account && scope
        && areServerAccountScopesEqual(getActiveServerAccountScope(), scope)
        && areServerAccountScopesEqual(readRegisteredStorageState()?.settingsScope, scope)) {
        await withActionAccountRequestSignal(account, options?.signal, async signal => {
          await awaitPendingArtifactInventory({ scope, credentials: account.credentials, signal });
        });
        account.assertCurrent();
        throwIfAborted(options?.signal);
        rows = readCompleteAccountArtifactInventory(scope);
      }
      if (account && rows) {
        // The shared selector expects physical updated-desc pages, including
        // cursor advancement, even when the headers are already admitted locally.
        const page = await listArtifactHeadersV1({
          options: { ...options, search: '' },
          readPage: async pageOptions => {
            const kinds = pageOptions?.kinds;
            const selectedRows = rows.map(artifact => ({ artifactId: artifact.id,
              header: artifact.isDecrypted ? artifact.rawHeader ?? {} : {},
              createdAt: artifact.createdAt, updatedAt: artifact.updatedAt, access: artifact.access }))
              .filter(item => (!pageOptions?.coarseKind || deriveArtifactCoarseKindV1(item.header) === pageOptions.coarseKind)
                && (!kinds || (typeof item.header.kind === 'string' && kinds.includes(item.header.kind))))
              .sort((left, right) => right.updatedAt - left.updatedAt || right.artifactId.localeCompare(left.artifactId));
            const index = pageOptions?.cursor
              ? selectedRows.findIndex(item => account.encodeArtifactListCursor(item) === pageOptions.cursor) : -1;
            if (pageOptions?.cursor && index < 0)
              throw Object.assign(new Error('artifact_list_cursor_invalid'), { code: 'invalid_cursor' });
            const items = selectedRows.slice(index + 1,
              pageOptions?.limit === undefined ? undefined : index + 1 + pageOptions.limit);
            const last = items.at(-1);
            return { items, coverage: 'complete',
              ...(last && index + 1 + items.length < selectedRows.length
                ? { nextCursor: account.encodeArtifactListCursor(last) } : {}) };
          },
          encodeCursor: item => account.encodeArtifactListCursor(item),
        });
        account.assertCurrent();
        return { items: page.items.map(item => ({ id: item.artifactId, header: item.header,
          updatedAtMs: item.updatedAt, owned: item.access === 'owner' })), coverage: page.coverage,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      }
      const page = account ? await listArtifactHeadersV1({
        options: { ...options, includeBody: false },
        readPage: pageOptions => account.listArtifacts(pageOptions ?? {}),
        encodeCursor: encodeArtifactListCursor,
      }) : await artifacts.list({ ...options, includeBody: false });
      return {
        items: page.items.map((item) => ({
          id: item.artifactId,
          header: item.header,
          updatedAtMs: item.updatedAt,
          owned: item.access === 'owner',
        })),
        coverage: page.coverage === 'partial' || page.items.some(
          (item) => Object.keys(item.header).length === 0,
        )
          ? 'partial'
          : 'complete',
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  };
}
