import { describe, expect, it, vi } from 'vitest';

import { loadCommittedTranscriptLocalIdBaseline } from './committedTranscriptLocalIdBaseline';

describe('loadCommittedTranscriptLocalIdBaseline', () => {
  it('collects session-global local ids through the final page', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({
        messages: [
          { seq: 9, localId: 'segment-9', createdAt: 900,
            meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentState: 'complete', segmentLocalId: 'segment-9', sourceMessageId: 'fact-9', futurePresentation: 'ignored' } } },
          { seq: 8, localId: 'fact-8', createdAt: 800 },
        ],
        hasMore: true,
        nextBeforeSeq: 8,
        nextAfterSeq: 9,
      })
      .mockResolvedValueOnce({
        messages: [{ seq: 7, localId: 'fact-7', createdAt: 700 }],
        hasMore: false,
        nextBeforeSeq: null,
        nextAfterSeq: 9,
      });

    await expect(loadCommittedTranscriptLocalIdBaseline({
      fetchPage,
    })).resolves.toEqual({
      localIds: new Set(['segment-9', 'fact-9', 'fact-8', 'fact-7']),
      complete: true,
    });
    expect(fetchPage).toHaveBeenNthCalledWith(2, {
      limit: 500,
      beforeSeq: 8,
    });
  });

  it.each([
    { segmentState: 'streaming' },
    { segmentState: 'interrupted' },
    { segmentLocalId: 'another-row' },
    { sourceMessageId: '   ' },
    { sourceMessageId: 42 },
  ])('does not grant source identity to malformed or incomplete stored segments (%j)', async (override) => {
    const result = await loadCommittedTranscriptLocalIdBaseline({
      fetchPage: async () => ({ messages: [{ localId: 'segment-1', meta: { happierStreamSegmentV1: {
        v: 1, segmentKind: 'assistant', segmentState: 'complete', segmentLocalId: 'segment-1',
        sourceMessageId: 'native-1', futurePresentation: 'ignored', ...override,
      } } }], hasMore: false, nextBeforeSeq: null }),
    });
    expect(result.localIds).toEqual(new Set(['segment-1']));
  });

  it('completes an identity baseline beyond 5,000 rows', async () => {
    let pageIndex = 0;
    const fetchPage = vi.fn(async () => {
      const offset = pageIndex * 500;
      pageIndex += 1;
      return {
        messages: Array.from({ length: Math.min(500, 6_001 - offset) }, (_, index) => ({
          seq: 6_001 - offset - index,
          localId: `fact-${offset + index}`,
        })),
        hasMore: pageIndex < 13,
        nextBeforeSeq: pageIndex < 13 ? 6_001 - pageIndex * 500 : null,
      };
    });

    const result = await loadCommittedTranscriptLocalIdBaseline({ fetchPage });

    expect(result.complete).toBe(true);
    expect(result.localIds.size).toBe(6_001);
    expect(result.localIds.has('fact-6000')).toBe(true);
  });

  it.each([8, 9])('refuses a non-progressing older cursor (%s)', async nextBeforeSeq => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ messages: [{ localId: 'new' }], hasMore: true, nextBeforeSeq: 8 })
      .mockResolvedValueOnce({ messages: [{ localId: 'old' }], hasMore: true, nextBeforeSeq })
      .mockRejectedValue(new Error('must not fetch a stalled cursor'));

    await expect(loadCommittedTranscriptLocalIdBaseline({ fetchPage })).resolves.toMatchObject({ complete: false });
  });

  it('propagates the containing caller lifetime to every page', async () => {
    const controller = new AbortController();
    const deadlineAtMs = Date.now() + 60_000;
    const fetchPage = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      signal?.throwIfAborted();
      controller.abort();
      return { messages: [{ localId: 'new' }], hasMore: true, nextBeforeSeq: 8 };
    });

    await expect(loadCommittedTranscriptLocalIdBaseline({ fetchPage, signal: controller.signal, deadlineAtMs }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({ limit: 500, signal: controller.signal, deadlineAtMs });
  });
});
