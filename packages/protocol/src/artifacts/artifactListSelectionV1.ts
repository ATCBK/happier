import { deriveArtifactCoarseKindV1, type ArtifactCoarseKindV1, type ArtifactKindCoverageV1 } from './artifactKindV1.js';
import { throwIfAborted } from '../abortSignal.js';

/** Existing structural /v1/artifacts transport page, shared by dependent page reads. */
export const ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 = 500;

export type ArtifactListSelectionOptionsV1 = Readonly<{
  limit?: number; cursor?: string; search?: string; kind?: string;
  kinds?: readonly string[];
  /** Server-visible exact index hints; private-header matching remains owned by `kinds`/`headerFilter`. */
  indexedKinds?: readonly string[];
  coarseKind?: ArtifactCoarseKindV1;
  ownerAccountId?: string;
  /** Keyholding host selection over admitted private headers; never a wire filter. */
  headerFilter?: (header: Readonly<Record<string, unknown>>) => boolean;
  sort?: 'updated_desc' | 'created_desc' | 'title_asc'; includeBody?: boolean; signal?: AbortSignal;
}>;

export type ArtifactListPageOptionsV1 = Readonly<Pick<ArtifactListSelectionOptionsV1,
  'limit' | 'cursor' | 'includeBody' | 'coarseKind' | 'kinds' | 'indexedKinds' | 'ownerAccountId' | 'signal'> & { unclassified?: boolean | 'coarse' }>;

type ArtifactListHeader = Readonly<{
  artifactId: string; header: Readonly<Record<string, unknown>>; createdAt: number; updatedAt: number;
}>;
type ArtifactListPage<T> = Readonly<{ items: readonly T[]; nextCursor?: string; coverage?: 'complete' | 'partial';
  kindCoverage?: ArtifactKindCoverageV1; hasUnclassified?: boolean }>;

/** Decrypted selection shared by keyholding hosts; transport pages retain their own codecs and custody. */
export async function listArtifactHeadersV1<T extends ArtifactListHeader>(params: Readonly<{
  options?: ArtifactListSelectionOptionsV1;
  /** Apply indexed selectors before paging; report readable legacy membership. */
  readPage: (options?: ArtifactListPageOptionsV1) => Promise<ArtifactListPage<T>>;
  readBodies?: (items: readonly T[]) => Promise<readonly T[]>;
  encodeCursor: (item: T) => string;
}>): Promise<Readonly<{ items: readonly T[]; nextCursor?: string; coverage: 'complete' | 'partial'; kindCoverage?: ArtifactKindCoverageV1 }>> {
  const options = params.options;
  throwIfAborted(options?.signal);
  const requestedKinds = options?.kinds ?? (options?.kind ? [options.kind] : undefined);
  const kinds = requestedKinds === undefined ? undefined
    : [...new Set(requestedKinds.filter(kind => !options?.kind || kind === options.kind))].sort();
  if (kinds?.length === 0) return { items: [], coverage: 'complete' };
  // The incumbent /v1/artifacts route admits at most 500 structural rows per request.
  if (!options || (options.limit !== undefined && options.limit <= 500
    && options.search === undefined && options.kind === undefined && kinds === undefined && options.indexedKinds === undefined && options.coarseKind === undefined && !options.headerFilter
    && (options.sort === undefined || options.sort === 'updated_desc'))) {
    const page = await params.readPage(options);
    throwIfAborted(options?.signal);
    return { ...page, coverage: page.coverage ?? 'complete' };
  }
  const all: T[] = [];
  let coverage: 'complete' | 'partial' = 'complete';
  let kindCoverage: ArtifactKindCoverageV1 | undefined;
  // The transport keyset is updatedAt-desc / id-desc. Only other orderings
  // need a complete header view before applying their logical cursor.
  const updatedOrder = options.sort === undefined || options.sort === 'updated_desc';
  let cursor = updatedOrder ? options.cursor : undefined;
  const kindSet = kinds === undefined ? undefined : new Set(kinds);
  const search = options.search?.trim().toLocaleLowerCase();
  const title = (item: T) => typeof item.header.title === 'string' ? item.header.title : '';
  const matches = (item: T) => (!options.kind || item.header.kind === options.kind)
    && (!kindSet || (typeof item.header.kind === 'string' && kindSet.has(item.header.kind)))
    && (!options.headerFilter || options.headerFilter(item.header))
    && (!options.coarseKind || deriveArtifactCoarseKindV1(item.header) === options.coarseKind)
    && (!search || title(item).toLocaleLowerCase().includes(search));
  let hasMorePhysicalRows = false;
  do {
    const page = await params.readPage({ limit: 500, ...(cursor ? { cursor } : {}),
      ...(options.indexedKinds !== undefined ? { indexedKinds: options.indexedKinds }
        : kinds !== undefined ? { kinds } : options.coarseKind ? { coarseKind: options.coarseKind } : {}),
      ...(options.ownerAccountId !== undefined ? { ownerAccountId: options.ownerAccountId } : {}),
      ...(options.includeBody && !params.readBodies ? { includeBody: true } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    throwIfAborted(options.signal);
    // A typed exact-kind witness is resolved by the legacy header pass below;
    // classification lag is not itself unreadable content.
    if (page.hasUnclassified === true && (kinds === undefined || !page.kindCoverage)) coverage = 'partial';
    if (page.coverage === 'partial') coverage = 'partial';
    if (page.kindCoverage) {
      kindCoverage = page.kindCoverage;
      if (kindCoverage.status === 'partial' && kinds === undefined) coverage = 'partial';
    }
    all.push(...page.items.filter(matches));
    cursor = page.nextCursor;
    hasMorePhysicalRows = cursor !== undefined;
    if (updatedOrder && options.limit !== undefined && all.length >= options.limit) break;
    if (!cursor) break;
  } while (true);
  // Legacy membership is resolved only under the server's current typed witness.
  // This same header reader never repairs hints or opens unrelated bodies.
  if (kinds !== undefined && options.indexedKinds === undefined && kindCoverage?.status === 'partial') {
    let legacyCursor = updatedOrder ? options.cursor : undefined;
    const selectedIds = new Set(all.map(item => item.artifactId));
    do {
      const page = await params.readPage({ limit: 500, unclassified: true,
        ...(legacyCursor ? { cursor: legacyCursor } : {}),
        ...(options.ownerAccountId !== undefined ? { ownerAccountId: options.ownerAccountId } : {}),
        ...(options.signal ? { signal: options.signal } : {}) });
      throwIfAborted(options.signal);
      if (page.coverage === 'partial') coverage = 'partial';
      for (const item of page.items) if (!selectedIds.has(item.artifactId) && matches(item)) {
        all.push(item);
        selectedIds.add(item.artifactId);
      }
      legacyCursor = page.nextCursor;
    } while (legacyCursor);
  }
  const compare = (left: T, right: T) => {
    const primary = options.sort === 'title_asc' ? title(left).localeCompare(title(right))
      : options.sort === 'created_desc' ? right.createdAt - left.createdAt : right.updatedAt - left.updatedAt;
    return primary || (updatedOrder ? right.artifactId.localeCompare(left.artifactId) : left.artifactId.localeCompare(right.artifactId));
  };
  all.sort(compare);
  const index = !updatedOrder && options.cursor ? all.findIndex(item => params.encodeCursor(item) === options.cursor) : -1;
  if (!updatedOrder && options.cursor && index < 0) throw Object.assign(new Error('artifact_list_cursor_invalid'), { code: 'invalid_cursor' });
  const pageItems = options.limit === undefined ? all.slice(index + 1) : all.slice(index + 1, index + 1 + options.limit);
  // Only this page needs content. Recheck fresh returned headers rather than
  // attaching a new body to the earlier header/revision or disclosing a kind
  // that changed during the read. Continuation uses the structural frontier.
  const selected = options.includeBody && params.readBodies && pageItems.length > 0 ? await params.readBodies(pageItems) : pageItems;
  throwIfAborted(options.signal);
  const items = selected.filter(matches).sort(compare);
  const last = pageItems.at(-1);
  return { items, coverage, ...(kindCoverage ? { kindCoverage } : {}), ...(last && (hasMorePhysicalRows || index + 1 + pageItems.length < all.length)
    ? { nextCursor: params.encodeCursor(last) } : {}) };
}
