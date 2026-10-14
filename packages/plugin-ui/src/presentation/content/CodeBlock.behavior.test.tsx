import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useHappierCodeBlockBehavior } from './CodeBlock.js';

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared code-block copy settlement', () => {
  it('accepts void success, clears feedback on refusal or rejection, and permits retry', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onCopy = vi.fn<() => Promise<boolean | void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('private clipboard data'));
    let behavior: ReturnType<typeof useHappierCodeBlockBehavior> | undefined;
    function Harness() {
      behavior = useHappierCodeBlockBehavior({
        showHeaderRow: true,
        showCopyButton: true,
        hasHeaderLeft: false,
        hasHeaderRight: false,
        onCopy,
      });
      return null;
    }
    await act(async () => { renderer = create(<Harness />); });

    await act(async () => { expect(await behavior!.copy()).toBe(true); });
    expect(behavior!.copied).toBe(true);
    await act(async () => { expect(await behavior!.copy()).toBe(false); });
    expect(behavior!.copied).toBe(false);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/clipboard/i));
    warning.mockClear();

    await act(async () => { expect(await behavior!.copy()).toBe(true); });
    expect(behavior!.copied).toBe(true);
    await act(async () => { expect(await behavior!.copy()).toBe(false); });
    expect(behavior!.copied).toBe(false);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/clipboard/i));
    expect(warning.mock.calls.flat()).not.toContain('private clipboard data');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retain a feedback timer when clipboard settlement outlives unmount', async () => {
    vi.useFakeTimers();
    let settle: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    let behavior: ReturnType<typeof useHappierCodeBlockBehavior> | undefined;
    function Harness() {
      behavior = useHappierCodeBlockBehavior({
        showHeaderRow: true,
        showCopyButton: true,
        hasHeaderLeft: false,
        hasHeaderRight: false,
        onCopy: () => pending,
      });
      return null;
    }
    await act(async () => { renderer = create(<Harness />); });
    const copying = behavior!.copy();
    act(() => { renderer!.unmount(); renderer = null; });
    await act(async () => { settle!(); await copying; });
    expect(vi.getTimerCount()).toBe(0);
  });
});
