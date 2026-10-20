import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireBundledConversationRuntimeGeneration,
  resetBundledConversationRuntimeGenerationForTests,
} from './bundledConversationRuntimeGeneration';

describe('bundled conversation runtime generation', () => {
  beforeEach(resetBundledConversationRuntimeGenerationForTests);
  it('withdraws old generation authority before aborting its pending requests', () => {
    const old = acquireBundledConversationRuntimeGeneration();
    const authorityAtAbort: boolean[] = [];
    old.signal.addEventListener('abort', () => authorityAtAbort.push(old.isCurrent(), old.canCleanup()));
    const fresh = acquireBundledConversationRuntimeGeneration();
    expect(authorityAtAbort).toEqual([false, false]);
    fresh.revoke();
  });
  it('revokes old callbacks synchronously before a fresh runtime starts while allowing safe cleanup', () => {
    const old = acquireBundledConversationRuntimeGeneration();
    const oldCallback = vi.fn();
    old.runIfCurrent(oldCallback);
    old.revoke();

    expect(old.canCleanup()).toBe(true);
    const fresh = acquireBundledConversationRuntimeGeneration();
    const freshCallback = vi.fn();
    fresh.runIfCurrent(freshCallback);
    old.runIfCurrent(oldCallback);

    expect(oldCallback).toHaveBeenCalledTimes(1);
    expect(freshCallback).toHaveBeenCalledTimes(1);
    expect(old.canCleanup()).toBe(false);
    fresh.revoke();
    expect(fresh.canCleanup()).toBe(true);
  });
});
