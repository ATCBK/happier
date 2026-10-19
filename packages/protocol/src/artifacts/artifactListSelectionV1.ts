import { deriveArtifactCoarseKindV1, type ArtifactCoarseKindV1 } from './artifactKindV1.js';

export type ArtifactListSelectionOptionsV1 = Readonly<{
  limit?: number; cursor?: string; search?: string; kind?: string;
  coarseKind?: ArtifactCoarseKindV1;
  sort?: 'updated_desc' | 'created_desc' | 'title_asc'; includeBody?: boolean; signal?: AbortSignal;
}>;

type ArtifactListHeader = Readonly<{
  artifactId: string; header: Readonly<Record<string, unknown>>; createdAt: number; updatedAt: number;
}>;
type ArtifactListPage<T> = Readonly<{ items: readonly T[]; nextCursor?: string; coverage?: 'complete' | 'partial'; hasUnclassified?: boolean }>;

/** Decrypted selection shared by keyholding hosts; transport pages retain their own codecs and custody. */
export async function listArtifactHeadersV1<T extends ArtifactListHeader>(params: Readonly<{
  options?: ArtifactListSelectionOptionsV1;
  readPage: (options?: Readonly<{ limit?: number; cursor?: string; includeBody?: boolean; coarseKind?: ArtifactCoarseKindV1; signal?: AbortSignal }>) => Promise<ArtifactListPage<T>>;
  readBodies?: (items: readonly T[]) => Promise<readonly T[]>;
  encodeCursor: (item: T) => string;
}>): Promise<Readonly<{ items: readonly T[]; nextCursor?: string; coverage: 'complete' | 'partial' }>> {
  const options = params.options;
  options?.signal?.throwIfAborted();
  // The incumbent /v1/artifacts route admits at most 500 structural rows per request.
  if (!options || (options.limit !== undefined && options.limit <= 500
    && options.search === undefined && options.kind === undefined && options.coarseKind === undefined
    && (options.sort === undefined || options.sort === 'updated_desc'))) {
    const page = await params.readPage(options);
    options?.signal?.throwIfAborted();
    return { ...page, coverage: page.coverage ?? 'complete' };
  }
  const all: T[] = [];
  let coverage: 'complete' | 'partial' = 'complete';
  let cursor: string | undefined;
  let coarseKind = options.coarseKind;
  do {
    const page = await params.readPage({ limit: 500, ...(cursor ? { cursor } : {}),
      ...(coarseKind ? { coarseKind } : {}),
      ...(options.includeBody && !params.readBodies ? { includeBody: true } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    options.signal?.throwIfAborted();
    if (coarseKind && page.hasUnclassified === true) {
      // Unknown membership is not an empty library. Restart from the complete
      // inventory; no classifier or backfill at a consumer can prove absence.
      coarseKind = undefined;
      all.length = 0;
      coverage = 'complete';
      cursor = undefined;
      continue;
    }
    if (page.coverage === 'partial') coverage = 'partial';
    all.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  } while (true);
  const search = options.search?.trim().toLocaleLowerCase();
  const title = (item: T) => typeof item.header.title === 'string' ? item.header.title : '';
  const matchesKind = (item: T) => (!options.kind || item.header.kind === options.kind)
    && (!options.coarseKind || deriveArtifactCoarseKindV1(item.header) === options.coarseKind);
  const matching = all.filter(matchesKind);
  // Open selected bodies before sorting/cursors so a fresh read keeps content and revisions aligned.
  const selected = options.includeBody && params.readBodies ? await params.readBodies(matching) : matching;
  options.signal?.throwIfAborted();
  const items = selected.filter(item => matchesKind(item)
    && (!search || title(item).toLocaleLowerCase().includes(search)));
  items.sort((left, right) => {
    const primary = options.sort === 'title_asc' ? title(left).localeCompare(title(right))
      : options.sort === 'created_desc' ? right.createdAt - left.createdAt : right.updatedAt - left.updatedAt;
    return primary || left.artifactId.localeCompare(right.artifactId);
  });
  const index = options.cursor ? items.findIndex(item => params.encodeCursor(item) === options.cursor) : -1;
  if (options.cursor && index < 0) throw Object.assign(new Error('artifact_list_cursor_invalid'), { code: 'invalid_cursor' });
  const pageItems = options.limit === undefined ? items.slice(index + 1) : items.slice(index + 1, index + 1 + options.limit);
  const last = pageItems.at(-1);
  return { items: pageItems, coverage, ...(last && index + 1 + pageItems.length < items.length
    ? { nextCursor: params.encodeCursor(last) } : {}) };
}
