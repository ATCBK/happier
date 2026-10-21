import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createAccountSessionFollowRuleCache } from '@/agent/runtime/session/follow/accountSessionFollowRuleCache';
import { createSessionFollowOccurrenceDispatcher } from '@/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher';
import { createRequesterSessionFollowSourceReconciliation } from './requesterSessionFollowSourceReconciliation';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

afterEach(() => vi.restoreAllMocks());

it('suppresses Account refresh but retains one Run-demand list read per idle recovery, reconnect and Run-only invalidation', async () => {
  const destinationSessionId = 'c222222222222222222222222';
  const lifetime = new AbortController();
  let hint: (sourceSessionId: string | null) => void = () => {};
  let invalidate = () => {};
  let enabled = false;
  let runAttached = false;
  let beforeSourceList: (() => Promise<void>) | undefined;
  const runSource = { kind: 'workflow_run' as const, runId: 'workflow-one' };
  let ruleSourceReads = 0;
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    reads.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-rules') {
      if (options?.params?.destinationSessionId) ruleSourceReads++;
      return { status: 200, data: { rules: enabled ? [{ ruleId: 'added-rule', version: 0,
        receiver: { kind: 'session', sessionId: destinationSessionId }, content: { t: 'plain', v: { v: 1, enabled: true,
          filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }), policy: { preset: 'quiet' } } } }] : [],
        ...(options?.params?.destinationSessionId ? { sourceRanges: { status: 'available', sources: [] } } : {}) } };
    }
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path.endsWith('/follows/sessions')) {
      await beforeSourceList?.();
      return { status: 200, data: { sources: runAttached ? [{
        source: runSource, destinationSessionId, relation: 'follower', policy: { preset: 'quiet' },
        deliveryState: 'eligible', sourceAvailability: 'available', hasPendingUpdates: true,
      }] : [] } };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  const writes = vi.spyOn(axios, 'post').mockImplementation(async url => {
    if (new URL(String(url)).pathname.endsWith('/run-occurrence-routes')) return { status: 200,
      data: { ok: true, v: 1, original: { source: runSource, revision: 1 }, event: { kind: 'finished' }, routes: [] } };
    throw new Error('No pending work');
  });
  const input = { accountId: 'account-1', credentials: { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null },
    serverHttpBaseUrl: 'http://receiver-recovery.test', signal: lifetime.signal,
    isCurrent: async () => true, subscribeInvalidation: (listener: () => void) => { invalidate = listener; return () => {}; } };
  const cache = createAccountSessionFollowRuleCache(input);
  const dispatcher = createSessionFollowOccurrenceDispatcher({ ...input, serverId: 'home', machineId: 'machine',
    installationId: 'installation', rulesCache: cache, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  const recovery = createRequesterSessionFollowSourceReconciliation({ bootstrap: {
    getBoundSessionId: () => destinationSessionId,
    subscribeSessionFollowSources: listener => { hint = listener; return () => {}; },
  }, sessionFollowRuleCache: cache, isCurrent: input.isCurrent });
  const completed: (string | null)[] = [];
  recovery.bind(async sourceSessionId => {
    // The canonical inactive-observation owner has returned no pending work.
    await dispatcher.dispatchReceiverRange({ destinationSessionId, observations: [],
      ...(sourceSessionId ? { sourceSessionId } : {}) });
    completed.push(sourceSessionId);
  }, lifetime.signal);
  try {
    expect(await cache.read()).toMatchObject({ status: 'available', rules: [] });
    reads.length = 0;
    for (let index = 0; index < 5; index++) {
      hint(destinationSessionId);
      await vi.waitFor(() => expect(completed).toHaveLength(index + 1));
    }
    const idleReads = [...reads];
    expect(idleReads.filter(path => !path.endsWith('/follows/sessions'))).toEqual([]);
    // Orchestrator ruling: the configured-source list is the canonical Run-demand
    // read; retain one per pass rather than extend the inactive-observation wire.
    expect(idleReads.filter(path => path.endsWith('/follows/sessions'))).toHaveLength(5);
    reads.length = 0;
    hint(null);
    await vi.waitFor(() => expect(completed).toHaveLength(6));
    expect(reads.filter(path => path.endsWith('/follows/sessions'))).toHaveLength(1);
    expect(writes).not.toHaveBeenCalled();
    runAttached = true;
    reads.length = 0;
    hint(destinationSessionId);
    await vi.waitFor(() => expect(completed).toHaveLength(7));
    expect(reads.filter(path => path.endsWith('/follows/sessions'))).toHaveLength(1);
    expect(reads.filter(path => !path.endsWith('/follows/sessions'))).toEqual([]);
    expect(writes).toHaveBeenCalledWith(expect.stringMatching(/\/run-occurrence-routes$/),
      { v: 1, source: runSource }, expect.any(Object));
    runAttached = false;
    writes.mockClear();
    reads.length = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let readingSources = false;
    beforeSourceList = async () => { readingSources = true; await gate; };
    hint(destinationSessionId);
    try {
      await vi.waitFor(() => expect(readingSources).toBe(true));
      // The idle pass began with a warmed absence. Configuration invalidation
      // during its source read must withdraw that absence before demand is read.
      enabled = true;
      invalidate();
    } finally { release(); }
    await vi.waitFor(() => expect(completed).toHaveLength(8));
    expect(ruleSourceReads).toBe(1);
    expect(writes).not.toHaveBeenCalled();
  } finally { recovery.dispose(); dispatcher.dispose(); cache.dispose(); lifetime.abort(); }
});

it('coalesces overlapping receiver hints into two Run-demand list reads without Account refresh, retaining binding retirement', async () => {
  const destinationSessionId = 'c222222222222222222222222';
  const lifetime = new AbortController();
  let hint: (sourceSessionId: string | null) => void = () => {};
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    reads.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [] } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path.endsWith('/follows/sessions')) {
      if (reads.length === 1) await blocked;
      return { status: 200, data: { sources: [] } };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  const input = { accountId: 'account-1',
    credentials: { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null },
    serverHttpBaseUrl: 'http://receiver-recovery.test', signal: lifetime.signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {} };
  const cache = createAccountSessionFollowRuleCache(input);
  const dispatcher = createSessionFollowOccurrenceDispatcher({ ...input, serverId: 'home', machineId: 'machine',
    installationId: 'installation', rulesCache: cache, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  const recovery = createRequesterSessionFollowSourceReconciliation({ bootstrap: {
    getBoundSessionId: () => destinationSessionId,
    subscribeSessionFollowSources: listener => { hint = listener; return () => {}; },
  }, sessionFollowRuleCache: cache, isCurrent: async () => true });
  const started: (string | null)[] = [];
  const completed: (string | null)[] = [];
  recovery.bind(async source => {
    started.push(source);
    await dispatcher.dispatchReceiverRange({ destinationSessionId, observations: [],
      ...(source ? { sourceSessionId: source } : {}) });
    completed.push(source);
  }, lifetime.signal);
  try {
    expect(await cache.read()).toMatchObject({ status: 'available', rules: [] });
    reads.length = 0;
    hint(destinationSessionId);
    await vi.waitFor(() => expect(reads.filter(path => path.endsWith('/follows/sessions'))).toHaveLength(1));
    for (let index = 0; index < 5; index++) hint(destinationSessionId);
    hint(null);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(started).toEqual([null]);
    release();
    await vi.waitFor(() => expect(completed).toEqual([null, null]));
    expect(reads.filter(path => path.endsWith('/follows/sessions'))).toHaveLength(2);
    expect(reads.filter(path => !path.endsWith('/follows/sessions'))).toEqual([]);
    lifetime.abort();
    hint(destinationSessionId);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(started).toHaveLength(2);
  } finally { release(); recovery.dispose(); dispatcher.dispose(); cache.dispose(); lifetime.abort(); }
});

it.each(['complete', 'abort', 'dispose', 'rebind', 'retire'] as const)(
  'preserves merged source hints and withdraws queued work on %s during a recovery', async boundary => {
    const destinationSessionId = 'c222222222222222222222222';
    const lifetime = new AbortController();
    const successor = new AbortController();
    let hint: (sourceSessionId: string | null) => void = () => {};
    let current = true;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let sourceLists = 0;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [{
        ruleId: 'enabled-rule', version: 0, receiver: { kind: 'session', sessionId: destinationSessionId },
        content: { t: 'plain', v: { v: 1, enabled: true,
          filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }), policy: { preset: 'quiet' } } },
      }], sourceRanges: { status: 'available', sources: [] } } };
      if (path === '/v2/account/session-follow-preferences') return { status: 200,
        data: { assigned: false, direct: false, team: false, group: false } };
      if (path.endsWith('/follows/sessions')) {
        if (++sourceLists === 1) await gate;
        return { status: 200, data: { sources: [] } };
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    const input = { accountId: 'account-1',
      credentials: { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null },
      serverHttpBaseUrl: 'http://receiver-recovery.test', signal: lifetime.signal,
      isCurrent: async () => current, subscribeInvalidation: () => () => {} };
    const cache = createAccountSessionFollowRuleCache(input);
    const dispatcher = createSessionFollowOccurrenceDispatcher({ ...input, serverId: 'home', machineId: 'machine',
      installationId: 'installation', rulesCache: cache, resolveSourceKeyContext: async () => null,
      isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
    const recovery = createRequesterSessionFollowSourceReconciliation({ bootstrap: {
      getBoundSessionId: () => destinationSessionId,
      subscribeSessionFollowSources: listener => { hint = listener; return () => {}; },
    }, sessionFollowRuleCache: cache, isCurrent: input.isCurrent });
    const started: (string | null)[] = [];
    const completed: (string | null)[] = [];
    const reconcile = async (source: string | null) => {
      started.push(source);
      await dispatcher.dispatchReceiverRange({ destinationSessionId, observations: [],
        ...(source ? { sourceSessionId: source } : {}) });
      completed.push(source);
      // Arrive at the completion boundary of the merged pass, rather than only
      // while HTTP is held. This hint must survive the loop's next pending check.
      if (boundary === 'complete' && completed.length === 2) hint('source-d');
    };
    recovery.bind(reconcile, lifetime.signal);
    try {
      hint('source-a');
      await vi.waitFor(() => expect(sourceLists).toBe(1));
      hint('source-b');
      hint('source-c');
      hint('source-c');
      if (boundary === 'abort') lifetime.abort();
      if (boundary === 'dispose') recovery.dispose();
      if (boundary === 'retire') current = false;
      if (boundary === 'rebind') {
        recovery.bind(reconcile, successor.signal);
        hint(destinationSessionId);
        await vi.waitFor(() => expect(started).toEqual(['source-a', null]));
      }
      release();
      await vi.waitFor(() => expect(completed).toHaveLength(boundary === 'complete' ? 3 : boundary === 'rebind' ? 2 : 1));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(started).toEqual(boundary === 'complete' ? ['source-a', null, 'source-d']
        : boundary === 'rebind' ? ['source-a', null] : ['source-a']);
      if (boundary === 'complete') {
        // A hint after the loop has drained starts another pass.
        hint('source-e');
        await vi.waitFor(() => expect(completed).toEqual(['source-a', null, 'source-d', 'source-e']));
      }
    } finally { release(); recovery.dispose(); dispatcher.dispose(); cache.dispose(); lifetime.abort(); successor.abort(); }
  });
