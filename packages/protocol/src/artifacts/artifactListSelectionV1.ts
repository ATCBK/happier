import { deriveArtifactCoarseKindV1, type ArtifactCoarseKindV1 } from './artifactKindV1.js';
import { throwIfAborted } from '../abortSignal.js';

export type ArtifactListSelectionOptionsV1 = Readonly<{
  limit?: number; cursor?: string; search?: string; kind?: string;
  coarseKind?: ArtifactCoarseKindV1;
  /** Keyholding host selection over admitted private headers; never a wire filter. */
  headerFilter?: (header: Readonly<Record<string, unknown>>) => boolean;
  sort?: 'updated_desc' | 'created_desc' | 'title_asc'; includeBody?: boolean; signal?: AbortSignal;
}>;

type ArtifactListHeader = Readonly<{
  artifactId: string; header: Readonly<Record<string, unknown>>; createdAt: number; updatedAt: number;
}>;
type ArtifactListPage<T> = Readonly<{ items: readonly T[]; nextCursor?: string; coverage?: 'complete' | 'partial'; hasUnclassified?: boolean }>;

/** Decrypted selection shared by keyholding hosts; transport pages retain their own codecs and custody. */
export async function listArtifactHeadersV1<T extends ArtifactListHeader>(params: Readonly<{
  options?: ArtifactListSelectionOptionsV1;
  /** Apply requested coarse-kind filtering and report any readable unclassified rows. */
  readPage: (options?: Readonly<{ limit?: number; cursor?: string; includeBody?: boolean; coarseKind?: ArtifactCoarseKindV1; signal?: AbortSignal }>) => Promise<ArtifactListPage<T>>;
  readBodies?: (items: readonly T[]) => Promise<readonly T[]>;
  encodeCursor: (item: T) => string;
}>): Promise<Readonly<{ items: readonly T[]; nextCursor?: string; coverage: 'complete' | 'partial' }>> {
  const options = params.options;
  throwIfAborted(options?.signal);
  // The incumbent /v1/artifacts route admits at most 500 structural rows per request.
  if (!options || (options.limit !== undefined && options.limit <= 500
    && options.search === undefined && options.kind === undefined && options.coarseKind === undefined && !options.headerFilter
    && (options.sort === undefined || options.sort === 'updated_desc'))) {
    const page = await params.readPage(options);
    throwIfAborted(options?.signal);
    return { ...page, coverage: page.coverage ?? 'complete' };
  }
  const all: T[] = [];
  let coverage: 'complete' | 'partial' = 'complete';
  // The transport keyset is updatedAt-desc / id-desc. Only other orderings
  // need a complete header view before applying their logical cursor.
  const updatedOrder = options.sort === undefined || options.sort === 'updated_desc';
  let cursor = updatedOrder ? options.cursor : undefined;
  let coarseKind = options.coarseKind;
  const search = options.search?.trim().toLocaleLowerCase();
  const title = (item: T) => typeof item.header.title === 'string' ? item.header.title : '';
  const matches = (item: T) => (!options.kind || item.header.kind === options.kind)
    && (!options.headerFilter || options.headerFilter(item.header))
    && (coarseKind !== undefined || !options.coarseKind || deriveArtifactCoarseKindV1(item.header) === options.coarseKind)
    && (!search || title(item).toLocaleLowerCase().includes(search));
  let hasMorePhysicalRows = false;
  do {
    const page = await params.readPage({ limit: 500, ...(cursor ? { cursor } : {}),
      ...(coarseKind ? { coarseKind } : {}),
      ...(options.includeBody && !params.readBodies ? { includeBody: true } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    throwIfAborted(options.signal);
    // Widget families originate in the one-way 0.3 cut: their writers always
    // classify them. Unclassified predecessor documents cannot be widgets.
    // Reclassifying pre-cut development rows belongs to the existing inventory
    // writer, never a widget read that opens every unrelated Account key.
    const widgetKind = coarseKind === 'widget_area_layout' || coarseKind === 'widget_definition' || coarseKind === 'widget_layout_fragment';
    if (coarseKind && page.hasUnclassified === true && !widgetKind) {
      // Unknown membership is not an empty library. Restart from the complete
      // inventory; no classifier or backfill at a consumer can prove absence.
      coarseKind = undefined;
      all.length = 0;
      coverage = 'complete';
      cursor = updatedOrder ? options.cursor : undefined;
      continue;
    }
    if (page.coverage === 'partial') coverage = 'partial';
    all.push(...page.items.filter(matches));
    cursor = page.nextCursor;
    hasMorePhysicalRows = cursor !== undefined;
    if (updatedOrder && options.limit !== undefined && all.length >= options.limit) break;
    if (!cursor) break;
  } while (true);
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
  return { items, coverage, ...(last && (hasMorePhysicalRows || index + 1 + pageItems.length < all.length)
    ? { nextCursor: params.encodeCursor(last) } : {}) };
}
