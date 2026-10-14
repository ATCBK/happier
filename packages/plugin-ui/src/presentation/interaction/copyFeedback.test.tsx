import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useHappierCopyFeedback } from './copyFeedback.js';

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
});

describe('keyed copy feedback', () => {
  it('keeps the newest key for the caller duration and cancels feedback on clear', async () => {
    vi.useFakeTimers();
    let feedback: ReturnType<typeof useHappierCopyFeedback> | undefined;
    function Harness() {
      feedback = useHappierCopyFeedback(1_500);
      return null;
    }
    await act(async () => { renderer = create(<Harness />); });

    act(() => { feedback!.markCopied('first'); });
    act(() => { vi.advanceTimersByTime(1_000); });
    act(() => { feedback!.markCopied('second'); });
    expect(feedback!.isCopied('first')).toBe(false);
    expect(feedback!.isCopied('second')).toBe(true);
    act(() => { vi.advanceTimersByTime(1_499); });
    expect(feedback!.copiedKey).toBe('second');
    act(() => { vi.advanceTimersByTime(1); });
    expect(feedback!.copiedKey).toBeNull();

    act(() => { feedback!.markCopied(); });
    expect(feedback!.isCopied()).toBe(true);
    act(() => { feedback!.clearCopiedFeedback(); });
    expect(feedback!.copiedKey).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
