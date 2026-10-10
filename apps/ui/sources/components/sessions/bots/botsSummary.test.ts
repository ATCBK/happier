import { describe, expect, it } from 'vitest';

import { createSessionListRenderableSessionFixture } from '@/dev/testkit';

import { createBotsSummaryReader } from './botsSummary';

describe('closed Bots entries summary', () => {
  it('walks the rows only when one of its Homes replaced its row map, not on every store notification', () => {
    let rowReads = 0;
    const bot = createSessionListRenderableSessionFixture({
      id: 'bot',
      metadata: { path: '/project', bot: { kind: 'bot' } },
    });
    const counted = new Proxy(bot, {
      get(target, key, receiver) {
        if (key === 'metadata') rowReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const homeRows = { bot: counted };
    const read = createBotsSummaryReader(['home-a']);

    const first = read({ 'home-a': homeRows, 'home-b': {} });
    const readsAfterFirst = rowReads;
    expect(readsAfterFirst).toBeGreaterThan(0);

    // Another Home changed, or anything else in the store: this Home's map is the same object.
    expect(read({ 'home-a': homeRows, 'home-b': { other: bot } })).toBe(first);
    expect(rowReads).toBe(readsAfterFirst);

    // This Home's rows were replaced with the same Bots: walked again, the same summary object kept.
    expect(read({ 'home-a': { ...homeRows } })).toBe(first);
    expect(rowReads).toBeGreaterThan(readsAfterFirst);
  });

  it('shows only Bots, at most three faces, the most recently active first', () => {
    const rows = Object.fromEntries(
      [
        createSessionListRenderableSessionFixture({
          id: 'plain',
          activeAt: 50,
          metadata: { path: '/p' },
        }),
        ...[1, 2, 3, 4].map((n) =>
          createSessionListRenderableSessionFixture({
            id: `bot-${n}`,
            activeAt: n,
            metadata: { path: '/p', bot: { kind: 'bot' } },
          }),
        ),
      ].map((row) => [row.id, row]),
    );
    const summary = createBotsSummaryReader(['home-a'])({ 'home-a': rows });
    expect(summary.faces.map((face) => face.key)).toEqual([
      'home-a\u0000bot-4',
      'home-a\u0000bot-3',
      'home-a\u0000bot-2',
    ]);
    expect(summary.needsYou).toBe(0);
  });
});
