import { describe, expect, it } from 'vitest';

import { reconcileCodexSharedJsonlState } from './fixedJsonlState.js';

describe('reconcileCodexSharedJsonlState', () => {
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
