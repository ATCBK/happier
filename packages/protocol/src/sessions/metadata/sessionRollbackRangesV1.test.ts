import { describe, expect, it } from 'vitest';

import {
  buildSessionRollbackRangesV1,
  readSessionRollbackRangesV1FromMetadata,
  SessionRollbackRangesV1Schema,
} from './sessionRollbackRangesV1.js';
import { SessionRollbackRpcParamsSchema } from '../rollback.js';

describe('sessionRollbackRangesV1', () => {
  it('projects retained target fields without erasing range annotations or weakening rollback admission', () => {
    const target = { type: 'before_user_message', userMessageSeq: 7 };
    const range = { target: { ...target, retired: true }, startSeqInclusive: 7, endSeqInclusive: 11,
      rolledBackAt: 122, annotation: { native: true } };
    const retained = { v: 1, updatedAt: 123, ranges: [range], annotation: { owner: 'native' } };
    expect(readSessionRollbackRangesV1FromMetadata({ sessionRollbackRangesV1: retained }))
      .toEqual({ ...retained, ranges: [{ ...range, target }] });
    expect(readSessionRollbackRangesV1FromMetadata({ sessionRollbackRangesV1: {
      ...retained, ranges: [{ ...range, target: { ...target, userMessageSeq: -1 } }],
    } })).toBeNull();
    expect(SessionRollbackRpcParamsSchema.safeParse({ v: 1, target: range.target }).success).toBe(false);
  });
  it('parses latest-turn rollback transcript ranges from metadata', () => {
    const built = buildSessionRollbackRangesV1({
      updatedAt: 123,
      ranges: [
        {
          target: { type: 'latest_turn' },
          startSeqInclusive: 7,
          endSeqInclusive: 11,
          rolledBackAt: 122,
        },
      ],
    });

    const parsed = SessionRollbackRangesV1Schema.parse({ ...built, extra: 'ok' });
    expect(parsed).toMatchObject({
      v: 1,
      updatedAt: 123,
      ranges: [
        {
          target: { type: 'latest_turn' },
          startSeqInclusive: 7,
          endSeqInclusive: 11,
          rolledBackAt: 122,
        },
      ],
      extra: 'ok',
    });
  });

  it('reads rollback ranges from session metadata safely', () => {
    expect(
      readSessionRollbackRangesV1FromMetadata({
        sessionRollbackRangesV1: {
          v: 1,
          updatedAt: 123,
          ranges: [
            {
              target: { type: 'latest_turn' },
              startSeqInclusive: 7,
              endSeqInclusive: 11,
              rolledBackAt: 122,
            },
          ],
        },
      }),
    ).toMatchObject({
      ranges: [expect.objectContaining({ startSeqInclusive: 7, endSeqInclusive: 11 })],
    });
    expect(readSessionRollbackRangesV1FromMetadata(null)).toBeNull();
    expect(readSessionRollbackRangesV1FromMetadata({ sessionRollbackRangesV1: { v: 1, ranges: [] } })).toBeNull();
  });
});
