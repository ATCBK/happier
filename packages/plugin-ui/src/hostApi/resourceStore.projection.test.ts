import { describe, expect, it, vi } from 'vitest';
import type { ResourceContent, ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiResourceStore, type PluginUiResourceProjection } from './resourceStore.js';

type Status = Readonly<{ status: Readonly<{ state: string }>; checkedAt: number }>;
const content = (state: string, checkedAt: number): ResourceContent => ({ contentType: 'application/json',
  digest: `${state}:${checkedAt}`, bytes: new TextEncoder().encode(JSON.stringify({ state, checkedAt })) });

function createProjection() {
  const decode = vi.fn((value: ResourceContent, previous: Status | undefined): Status => {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(value.bytes));
    if (!parsed || typeof parsed !== 'object' || !('state' in parsed) || typeof parsed.state !== 'string'
      || !('checkedAt' in parsed) || typeof parsed.checkedAt !== 'number') throw new Error('Invalid status');
    return { status: previous?.status.state === parsed.state ? previous.status : { state: parsed.state }, checkedAt: parsed.checkedAt };
  });
  return { projection: { decode } satisfies PluginUiResourceProjection<Status>, decode };
}

describe('shared typed Resource projections', () => {
  it('only decodes demanded snapshots and shares each demanded model across selectors', async () => {
    let current = content('running', 1);
    let denied = false;
    const store = createPluginUiResourceStore({ client: { readResource: async () => {
      if (denied) throw Object.assign(new Error('Denied'), { code: 'denied' });
      return current;
    } } });
    const { projection, decode } = createProjection();
    const entry = store.getEntry('status');
    const first = entry.select(projection, snapshot => snapshot.value);
    const second = entry.select(projection, snapshot => snapshot.value?.status);
    try {
      await entry.refresh();
      expect(decode).not.toHaveBeenCalled();
      expect(first.getSnapshot()?.status.state).toBe('running');
      expect(second.getSnapshot()).toBe(first.getSnapshot()?.status);
      expect(decode).toHaveBeenCalledTimes(1);
      current = content('passed', 2);
      await entry.refresh();
      expect(decode).toHaveBeenCalledTimes(1);
      expect(second.getSnapshot()?.state).toBe('passed');
      expect(first.getSnapshot()?.checkedAt).toBe(2);
      expect(decode).toHaveBeenCalledTimes(2);
      denied = true;
      await entry.refresh();
      denied = false;
      current = content('passed', 3);
      await entry.refresh();
      // Even without a read during denial, a replacement cannot inherit the
      // typed baseline from the withdrawn authority.
      expect(first.getSnapshot()?.checkedAt).toBe(3);
      expect(decode).toHaveBeenLastCalledWith(current, undefined);
    } finally { store.dispose(); }
  });

  it('settles a refused replacement admission without retrying or revealing expired values', async () => {
    vi.useFakeTimers();
    const oldContent = content('running', 1);
    let deliver: ((event: ResourceSubscriptionEvent) => void) | undefined;
    let retired = false;
    const readResource = vi.fn(async () => {
      if (retired) throw Object.assign(new Error('Unavailable'), { code: 'unavailable', retryable: false });
      return oldContent;
    });
    const watchResource = vi.fn(async (_ref: unknown, listener: (event: ResourceSubscriptionEvent) => void) => {
      if (retired) throw Object.assign(new Error('Expired'), { code: 'expired_resource', retryable: false });
      deliver = listener;
      return { admittedDigest: oldContent.digest, dispose() {} };
    });
    const store = createPluginUiResourceStore({ client: { readResource, watchResource } });
    const { projection } = createProjection();
    const entry = store.getEntry('status');
    const selected = entry.select(projection, snapshot => snapshot.value?.status);
    const release = selected.subscribe(() => {}, true);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(selected.getSnapshot()?.state).toBe('running');
      retired = true;
      deliver!({ version: 1, subscriptionId: 'initial', kind: 'error', code: 'expired_resource', diagnostics: [] });
      expect(selected.getSnapshot()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(selected.getSnapshot()).toBeUndefined();
      expect(entry.getSnapshot()).toMatchObject({ pending: 'idle', subscription: 'ended' });
      expect(readResource).toHaveBeenCalledTimes(2);
      expect(watchResource).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { release(); store.dispose(); vi.useRealTimers(); }
  });

  it('withdraws expired bytes and typed baselines immediately while preserving ordinary invalidation values', async () => {
    const oldContent = content('running', 1);
    const listeners: Array<(event: ResourceSubscriptionEvent) => void> = [];
    const reads: Array<{
      resolve(value: ResourceContent): void;
      reject(error: Error): void;
      signal?: AbortSignal;
    }> = [];
    let unavailable = false;
    const watchResource = vi.fn(async (_ref: unknown, listener: (event: ResourceSubscriptionEvent) => void) => {
      listeners.push(listener);
      return { admittedDigest: oldContent.digest, dispose() {} };
    });
    const store = createPluginUiResourceStore({ client: {
      readResource: async (_ref, options) => {
        if (unavailable) throw Object.assign(new Error('Replacement unavailable'), { code: 'unavailable', retryable: false });
        return new Promise<ResourceContent>((resolve, reject) => { reads.push({ resolve, reject, signal: options?.signal }); });
      },
      watchResource,
    } });
    const { projection, decode } = createProjection();
    const entry = store.getEntry('status');
    const selected = entry.select(projection, snapshot => snapshot.value?.status);
    const notify = vi.fn();
    const release = selected.subscribe(notify, true);
    try {
      reads[0]!.resolve(oldContent);
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      const oldValue = selected.getSnapshot();
      expect(oldValue?.state).toBe('running');
      listeners[0]!({ version: 1, subscriptionId: 'initial', kind: 'invalidated', digest: 'ordinary-refresh' });
      expect(entry.getSnapshot().value).toBe(oldContent);
      expect(selected.getSnapshot()).toBe(oldValue);
      reads[1]!.resolve(oldContent);
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      notify.mockClear();

      listeners[0]!({ version: 1, subscriptionId: 'initial', kind: 'error', code: 'expired_resource', diagnostics: [] });
      expect(entry.getSnapshot().value).toBeUndefined();
      expect(entry.getSnapshot().digest).toBeUndefined();
      expect(selected.getSnapshot()).toBeUndefined();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(watchResource).toHaveBeenCalledTimes(2);
      expect(reads).toHaveLength(3);
      expect(entry.getSnapshot().pending).toBe('initial');

      unavailable = true;
      reads[2]!.reject(Object.assign(new Error('Replacement unavailable'), { code: 'unavailable', retryable: false }));
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      expect(entry.getSnapshot().value).toBeUndefined();
      expect(selected.getSnapshot()).toBeUndefined();
      expect(decode).toHaveBeenCalledTimes(1);

      unavailable = false;
      const refresh = entry.refresh();
      reads[3]!.resolve(content('running', 2));
      await refresh;
      expect(decode).toHaveBeenLastCalledWith(expect.anything(), undefined);
      expect(selected.getSnapshot()).not.toBe(oldValue);
      const replacement = selected.getSnapshot();
      const replacementContent = entry.getSnapshot().value;
      const readCount = reads.length;
      listeners[0]!({ version: 1, subscriptionId: 'initial', kind: 'error', code: 'expired_resource', diagnostics: [] });
      expect(selected.getSnapshot()).toBe(replacement);
      expect(entry.getSnapshot().value).toBe(replacementContent);
      expect(reads).toHaveLength(readCount);
      expect(watchResource).toHaveBeenCalledTimes(2);
    } finally { release(); store.dispose(); }
  });

  it('decodes each changed ingress once and publishes only changed selected facts', async () => {
    let current = content('running', 1);
    const readResource = vi.fn(async () => current);
    const store = createPluginUiResourceStore({ client: { readResource } });
    const { projection, decode } = createProjection();
    const entry = store.getEntry('status');
    const first = entry.select(projection, snapshot => snapshot.value?.status);
    const second = store.getEntry('status').select(projection, snapshot => snapshot.value?.status);
    const freshness = entry.select(projection, snapshot => snapshot.value?.checkedAt);
    const notifyA = vi.fn();
    const notifyB = vi.fn();
    const releaseA = first.subscribe(notifyA, false);
    const releaseB = second.subscribe(notifyB, false);
    const releaseFreshness = freshness.subscribe(() => {}, false);
    try {
      await vi.waitFor(() => expect(first.getSnapshot()?.state).toBe('running'));
      const admitted = first.getSnapshot();
      expect(second.getSnapshot()).toBe(admitted);
      expect(readResource).toHaveBeenCalledTimes(1);
      expect(decode).toHaveBeenCalledTimes(1);
      notifyA.mockClear(); notifyB.mockClear();
      current = content('running', 2);
      await first.refresh();
      expect(decode).toHaveBeenCalledTimes(2);
      expect(first.getSnapshot()).toBe(admitted);
      expect(freshness.getSnapshot()).toBe(2);
      expect(notifyA).not.toHaveBeenCalled();
      expect(notifyB).not.toHaveBeenCalled();
      await first.refresh();
      expect(decode).toHaveBeenCalledTimes(2);
      current = content('passed', 3);
      await second.refresh();
      expect(first.getSnapshot()).toEqual({ state: 'passed' });
      expect(notifyA).toHaveBeenCalledTimes(1);
      expect(notifyB).toHaveBeenCalledTimes(1);
    } finally { releaseA(); releaseB(); releaseFreshness(); store.dispose(); }
  });

  it('retains admitted typed values on decode/read failure, clears them on authority loss and retirement', async () => {
    let current = content('running', 1);
    let failure = false;
    let watchListener: ((event: ResourceSubscriptionEvent) => void) | undefined;
    const store = createPluginUiResourceStore({ client: {
      readResource: async () => { if (failure) throw new Error('Offline'); return current; },
      watchResource: async (_ref, listener) => { watchListener = listener; return { admittedDigest: current.digest, dispose() {} }; },
    } });
    const { projection } = createProjection();
    const selected = store.getEntry('status').select(projection, snapshot => snapshot);
    const release = selected.subscribe(() => {}, true);
    try {
      await vi.waitFor(() => expect(selected.getSnapshot().subscription).toBe('live'));
      await vi.waitFor(() => expect(selected.getSnapshot().value).toBeDefined());
      const admitted = selected.getSnapshot().value;
      current = { ...content('bad', 2), bytes: new TextEncoder().encode('{}') };
      await selected.refresh();
      expect(selected.getSnapshot()).toMatchObject({ value: admitted, freshness: 'stale', error: { message: 'Invalid status' } });
      failure = true;
      await selected.refresh();
      expect(selected.getSnapshot()).toMatchObject({ value: admitted, freshness: 'stale', error: { message: 'Offline' } });
      watchListener!({ version: 1, subscriptionId: 'status', kind: 'error', code: 'denied', diagnostics: [], retryable: false });
      expect(selected.getSnapshot().value).toBeUndefined();
      failure = false; current = content('passed', 3);
      await selected.refresh();
      expect(selected.getSnapshot().value?.status.state).toBe('passed');
      store.dispose();
      expect(selected.getSnapshot()).toMatchObject({ freshness: 'unknown', subscription: 'ended' });
      expect(selected.getSnapshot().value).toBeUndefined();
    } finally { release(); store.dispose(); }
  });
});
