import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '../serverWork';
import { startPublicProfileRefresh } from './publicProfileRefresh';
import { createNativePublicProfileRefreshFixture } from './publicProfileRefresh.testkit';

const DAY_MS = 24 * 60 * 60 * 1_000;

describe('native Account public-profile refresh participant', () => {
  const handles: ReturnType<typeof startPublicProfileRefresh>[] = [];
  const fixtures: Awaited<ReturnType<typeof createNativePublicProfileRefreshFixture>>[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
  });
  afterEach(async () => {
    for (const fixture of fixtures) fixture.releaseReads();
    for (const handle of handles.splice(0)) await handle.stop();
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
    vi.useRealTimers();
  });

  async function fixture() {
    const account = await createNativePublicProfileRefreshFixture();
    fixtures.push(account);
    let online = true;
    const lifetime = new AbortController();
    const scheduler = createDaemonServerWorkScheduler({
      budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }),
      gate: () => online ? { status: 'open' } : { status: 'deferred', reason: 'offline' },
    });
    const start = () => {
      const handle = startPublicProfileRefresh({ actions: account.actions, scheduler,
        signal: lifetime.signal, isCurrent: account.isCurrent });
      handles.push(handle);
      return handle;
    };
    return { ...account, scheduler, start, lifetime, setOnline: (value: boolean) => { online = value; } };
  }

  it('checks at startup and retries the real shared preparation refusal only on the daily cadence', async () => {
    const f = await fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toEqual([
      { method: 'GET', path: '/v1/account/public-profile' },
      { method: 'GET', path: '/v1/account/public-profile' },
    ]);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters).toMatchObject({ written: 0, suppressed: 1 });
    await vi.advanceTimersByTimeAsync(DAY_MS - 1);
    expect(f.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters).toMatchObject({ written: 0, suppressed: 2 });
    expect(f.requests).toHaveLength(4);
    expect(f.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('uses the stored snapshot computation time for the exact first daily deadline', async () => {
    const f = await fixture();
    f.setComputedAt(Date.now() - DAY_MS + 123);
    f.start();
    await vi.advanceTimersByTimeAsync(122);
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.requests).toHaveLength(3);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(0);
  });

  it('defers offline and wakes on reconnect without resuming a paused remote profile', async () => {
    const f = await fixture();
    f.setOnline(false);
    const loop = f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toEqual([]);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.deferred).toBe(1);
    loop.pause();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    f.setOnline(true);
    loop.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(2);
    loop.pause();
    f.pauseProfile();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    loop.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(3);
    expect(f.requests.every(request => request.method === 'GET')).toBe(true);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(0);
  });

  it.each([
    { name: 'Ask', settings: { v: 1 } },
    { name: 'UI/Agent-only waiver', settings: { v: 1, approvalWaivedSurfaces: { 'account.public_profile.refresh': ['ui', 'agent'] } } },
    { name: 'Off', settings: { v: 1, actions: { 'account.public_profile.refresh': { enabled: false } } } },
  ])('does not prepare or write under $name CLI policy', async ({ settings }) => {
    const f = await fixture();
    f.setSettings(settings);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    // Only the maintenance read reaches the Account; native policy rejects
    // refresh before shared preparation can issue its own read.
    expect(f.requests).toEqual([{ method: 'GET', path: '/v1/account/public-profile' }]);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters).toMatchObject({ written: 0, suppressed: 1 });
    await vi.advanceTimersByTimeAsync(DAY_MS - 1);
    expect(f.requests).toHaveLength(1);
  });

  it('rejects a response after captured credentials retire and never dispatches preparation', async () => {
    const f = await fixture();
    const pending = f.holdNextRead();
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    await pending.accepted;
    f.retire();
    pending.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(1);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(0);
  });

  it('aborts and drains a pending Account HTTP request before stop completes', async () => {
    const f = await fixture();
    const pending = f.holdNextRead();
    const loop = f.start();
    await vi.advanceTimersByTimeAsync(0);
    await pending.accepted;
    let stopped = false;
    const stopping = loop.stop().then(() => { stopped = true; });
    expect(f.getRequestSignal()?.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    pending.release();
    await stopping;
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(f.requests).toHaveLength(1);
  });

  it('aborts pending Account HTTP immediately when the captured lifetime retires', async () => {
    const f = await fixture();
    const pending = f.holdNextRead();
    const loop = f.start();
    await vi.advanceTimersByTimeAsync(0);
    await pending.accepted;
    f.lifetime.abort();
    expect(f.getRequestSignal()?.aborted).toBe(true);
    pending.release();
    await loop.stop();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(f.requests).toHaveLength(1);
  });
});
