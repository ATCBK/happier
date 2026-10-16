import { readStreamedTranscriptSourceMessageId } from '../../streamedTranscriptWriter/buildStreamedTranscriptSegmentSnapshot';

export type CommittedTranscriptLocalIdBaseline = Readonly<{
  localIds: Set<string>;
  complete: boolean;
}>;

const committedLocalIdsBySession = new WeakMap<object, Set<string>>();

/** Live projection and follow retain the same custody identities for the Session lifetime. */
export function getSessionCommittedTranscriptLocalIds(session: object): Set<string> {
  let localIds = committedLocalIdsBySession.get(session);
  if (!localIds) {
    localIds = new Set<string>();
    committedLocalIdsBySession.set(session, localIds);
  }
  return localIds;
}

type TranscriptLocalIdBaselinePage = Readonly<{
  messages: readonly Readonly<{
    seq?: unknown;
    localId?: unknown;
    meta?: unknown;
  }>[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
}>;

export async function loadCommittedTranscriptLocalIdBaseline(params: Readonly<{
  take?: number;
  localIds?: Set<string>;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  fetchPage(input: Readonly<{
    limit: number;
    beforeSeq?: number;
    signal?: AbortSignal;
    deadlineAtMs?: number;
  }>): Promise<TranscriptLocalIdBaselinePage>;
}>): Promise<CommittedTranscriptLocalIdBaseline> {
  const take = typeof params.take === 'number' && Number.isFinite(params.take) && params.take > 0
    ? Math.trunc(params.take)
    : 5_000;
  const localIds = params.localIds ?? new Set<string>();
  let remaining = take;
  let beforeSeq: number | undefined;
  let complete = true;

  while (remaining > 0) {
    const page = await params.fetchPage({
      limit: Math.min(500, remaining),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      ...(params.signal === undefined ? {} : { signal: params.signal }),
      ...(params.deadlineAtMs === undefined
        ? {}
        : { deadlineAtMs: params.deadlineAtMs }),
    });
    for (const row of page.messages) {
      if (typeof row.localId === 'string' && row.localId.trim().length > 0) {
        localIds.add(row.localId);
        const sourceMessageId = readStreamedTranscriptSourceMessageId(row.localId, row.meta);
        if (sourceMessageId) localIds.add(sourceMessageId);
      }
    }
    remaining -= page.messages.length;
    if (!page.hasMore) break;
    if (
      page.messages.length === 0
      || page.nextBeforeSeq === null
      || remaining <= 0
    ) {
      complete = false;
      break;
    }
    beforeSeq = page.nextBeforeSeq;
  }

  return Object.freeze({
    localIds,
    complete,
  });
}
