import { describe, expect, it } from 'vitest';

import { reconcileCodexSharedJsonlState } from './fixedJsonlState.js';

describe('reconcileCodexSharedJsonlState', () => {
  it('adopts only exact complete-line extensions of the same rollout', () => {
    const entryPath = 'sessions/2026/10/19/rollout-2026-10-19T15-51-26-01a1546e-701a-7b41-8277-bdf4e72f2b28.jsonl';
    const metadata = '{"type":"session_meta","payload":{"id":"01a1546e-701a-7b41-8277-bdf4e72f2b28"}}\n';
    const answer = '{"type":"response_item","payload":{"role":"assistant"}}\n';
    expect(reconcileCodexSharedJsonlState({ entryPath, currentContents: metadata, incomingContents: metadata + answer }))
      .toEqual({ appendText: answer });
    expect(reconcileCodexSharedJsonlState({ entryPath, currentContents: metadata + answer, incomingContents: metadata }))
      .toEqual({ appendText: '' });
    expect(reconcileCodexSharedJsonlState({ entryPath, currentContents: metadata + answer, incomingContents: metadata + answer }))
      .toEqual({ appendText: '' });
    expect(reconcileCodexSharedJsonlState({ entryPath, currentContents: metadata, incomingContents: metadata + '{"type":' }))
      .toBeNull();
    expect(reconcileCodexSharedJsonlState({ entryPath, currentContents: metadata + answer, incomingContents: metadata + '{"type":"other"}\n' }))
      .toBeNull();
  });

  it('appends missing history and only newer per-session index records', () => {
    const historyFirst = '{"session_id":"first","ts":1,"text":"first prompt"}\n';
    const historySecond = '{"session_id":"second","ts":2,"text":"second prompt"}\n';
    const indexFirst = [
      '{"id":"first","thread_name":"First","updated_at":"2026-08-24T10:00:00.000Z"}',
      '{"id":"shared","thread_name":"Old","updated_at":"2026-08-24T09:00:00.000Z"}',
      '',
    ].join('\n');
    const indexSecond = [
      '{"id":"second","thread_name":"Second","updated_at":"2026-08-24T11:00:00.000Z"}',
      '{"id":"shared","thread_name":"New","updated_at":"2026-08-24T12:00:00.000Z"}',
      '',
    ].join('\n');
    let history = '';
    let index = '';
    for (const [incomingHistory, incomingIndex] of [
      [historyFirst, indexFirst], [historySecond, indexSecond], [historyFirst, indexFirst],
    ]) {
      history += reconcileCodexSharedJsonlState({
        entryPath: 'history.jsonl', currentContents: history, incomingContents: incomingHistory!,
      })!.appendText;
      index += reconcileCodexSharedJsonlState({
        entryPath: 'session_index.jsonl', currentContents: index, incomingContents: incomingIndex!,
      })!.appendText;
    }
    expect(history.trimEnd().split('\n')).toEqual([
      '{"session_id":"first","ts":1,"text":"first prompt"}',
      '{"session_id":"second","ts":2,"text":"second prompt"}',
    ]);
    expect(index.trimEnd().split('\n')).toEqual([
      '{"id":"first","thread_name":"First","updated_at":"2026-08-24T10:00:00.000Z"}',
      '{"id":"shared","thread_name":"Old","updated_at":"2026-08-24T09:00:00.000Z"}',
      '{"id":"second","thread_name":"Second","updated_at":"2026-08-24T11:00:00.000Z"}',
      '{"id":"shared","thread_name":"New","updated_at":"2026-08-24T12:00:00.000Z"}',
    ]);
    expect(reconcileCodexSharedJsonlState({
      entryPath: 'sessions/rollout.jsonl', currentContents: null, incomingContents: historyFirst,
    })).toBeNull();
    expect(reconcileCodexSharedJsonlState({
      entryPath: 'history.jsonl', currentContents: 'prior prompt', incomingContents: historyFirst,
    })!.appendText).toBe('\n' + historyFirst);
  });
});
