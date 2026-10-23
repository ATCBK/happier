import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { createSessionFollowRuleCache } from './sessionFollowRuleCache';
import { createAccountSessionFollowRuleCache } from './accountSessionFollowRuleCache';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import type { SessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';

const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }),
  policy: { preset: 'important' as const } };
const receiver = { kind: 'account' as const };
const row = { ruleId: 'rule', receiver, version: 1,
  sources: [{ sourceSessionId: 'current-source', delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1 }], content: sealSessionFollowRuleContentV1({
  ruleId: 'rule', receiver, definition, mode: 'plain', material: null }) };

describe('Account Follow rule cache', () => {
  it('refreshes receiver progress only for enabled receiver rules and reloads absent rules after invalidation', async () => {
    const receiverSessionId = 'receiver';
    const sessionRule = { ...row, receiver: { kind: 'session' as const, sessionId: receiverSessionId },
      content: sealSessionFollowRuleContentV1({ ruleId: row.ruleId,
        receiver: { kind: 'session', sessionId: receiverSessionId }, definition, mode: 'plain', material: null }) };
    let rules: SessionFollowRuleV1[] = [row];
    let available = true;
    let invalidate: (change?: Readonly<{ full: boolean }>) => void = () => {};
    const reads: string[] = [];
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v2/account/session-follow-preferences') return { status: 200,
        data: { assigned: false, direct: false, team: false, group: false } };
      if (path === '/v2/account/session-follow-rules') return available ? { status: 200, data: { rules } }
        : { status: 503, data: {} };
      throw new Error(`Unexpected Follow request ${path}`);
    });
    const lifetime = new AbortController();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://receiver-progress.test', signal: lifetime.signal, isCurrent: async () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; } });
    try {
      expect(await cache.read()).toMatchObject({ status: 'available' });
      reads.length = 0;
      expect(await cache.read({ refreshForSessionReceiver: receiverSessionId })).toMatchObject({ status: 'available' });
      expect(reads).toEqual([]);
      rules = [sessionRule];
      invalidate({ full: true });
      expect(await cache.read({ refreshForSessionReceiver: receiverSessionId })).toMatchObject({ status: 'available',
        rules: [{ receiver: sessionRule.receiver }] });
      expect(reads.filter(path => path.endsWith('/session-follow-rules'))).toHaveLength(1);
      rules = [{ ...sessionRule, sources: [{ sourceSessionId: 'current-source',
        delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 4 } }] }];
      expect(await cache.read({ refreshForSessionReceiver: receiverSessionId })).toMatchObject({ status: 'available',
        rules: [{ sources: rules[0]!.sources }] });
      expect(reads.filter(path => path.endsWith('/session-follow-rules'))).toHaveLength(2);
      available = false;
      invalidate({ full: true });
      expect(await cache.read({ refreshForSessionReceiver: receiverSessionId })).toMatchObject({ status: 'unavailable' });
      available = true;
      expect(await cache.read({ refreshForSessionReceiver: receiverSessionId })).toMatchObject({ status: 'available' });
      lifetime.abort();
      const beforeRetiredRead = reads.length;
      expect(await cache.read({ refreshForSessionReceiver: receiverSessionId })).toMatchObject({ status: 'unavailable' });
      expect(reads).toHaveLength(beforeRetiredRead);
    } finally { cache.dispose(); http.mockRestore(); }
  });
  it('retains rule configuration for source-only notifications and reloads it on a rule change', async () => {
    let invalidate: (change?: Readonly<{ full: boolean }>) => void = () => {};
    let ruleReads = 0;
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(new URL(String(url)).origin).toBe('https://bob-follow.test');
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (String(url).endsWith('/v2/account/session-follow-preferences')) return { status: 200,
        data: { assigned: false, direct: false, team: false, group: false } };
      if (String(url).endsWith('/v2/account/session-follow-rules')) {
        ruleReads++;
        return { status: 200, data: { rules: [row] } };
      }
      throw new Error(`Unexpected Follow request ${String(url)}`);
    });
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://bob-follow.test', signal: new AbortController().signal, isCurrent: async () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; } });
    try {
      expect(await cache.read()).toMatchObject({ status: 'available', rules: [{ ruleId: row.ruleId }] });
      invalidate({ full: false });
      expect(await cache.read()).toMatchObject({ status: 'available', rules: [{ ruleId: row.ruleId }] });
      expect(ruleReads).toBe(1);
      invalidate({ full: true });
      expect(await cache.read()).toMatchObject({ status: 'available', rules: [{ ruleId: row.ruleId }] });
      expect(ruleReads).toBe(2);
    } finally { cache.dispose(); http.mockRestore(); }
  });
  it('withdraws a private Bob read retired during HTTP, without borrowing the installed Account', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    let current = true;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reads: Readonly<{ url: string; authorization: unknown }>[] = [];
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      reads.push({ url: String(url), authorization: config?.headers?.Authorization });
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith('/v2/account/session-follow-preferences')) return { status: 200,
        data: { assigned: true, direct: false, team: false, group: false } };
      if (String(url).endsWith('/v2/account/session-follow-rules')) {
        await gate;
        return { status: 200, data: { rules: [row] } };
      }
      return { status: 404, data: {} };
    });
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://bob-follow.test', signal: new AbortController().signal,
      isCurrent: async () => current, subscribeInvalidation: () => () => {} });
    try {
      const pending = cache.read();
      await vi.waitFor(() => expect(reads.some(read => read.url.endsWith('/session-follow-rules'))).toBe(true));
      current = false;
      release();
      expect(await pending).toMatchObject({ status: 'unavailable' });
      expect(await cache.read()).toMatchObject({ status: 'unavailable' });
      expect(reads.every(read => read.url.startsWith('https://bob-follow.test/') && read.authorization === `Bearer ${token}`)).toBe(true);
    } finally { release(); cache.dispose(); http.mockRestore(); }
  });
  it('keeps personal default preferences in the same invalidated Account snapshot', async () => {
    let invalidate = () => {};
    let preferences = { assigned: true, direct: false, team: false, group: false };
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; },
      read: async () => ({ mode: 'plain', material: null, rules: [row], defaultPreferences: preferences }) });
    expect(await cache.read()).toMatchObject({ status: 'available', defaultPreferences: preferences });
    preferences = { ...preferences, team: true };
    invalidate();
    expect(await cache.read()).toMatchObject({ status: 'available', defaultPreferences: preferences });
    cache.dispose();
  });
  it('withdraws cached rules invalidated while the Account adapter awaits its final currentness check', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    let invalidate = () => {};
    let checking = false;
    let currentnessChecks = 0;
    let reached!: () => void;
    let release!: () => void;
    const atFinalCheck = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith('/v2/account/session-follow-preferences')) return { status: 200,
        data: { assigned: true, direct: false, team: false, group: false } };
      if (String(url).endsWith('/v2/account/session-follow-rules')) return { status: 200, data: { rules: [row] } };
      return { status: 404, data: {} };
    });
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://bob-follow.test', signal: new AbortController().signal,
      isCurrent: async () => {
        // A cached demand checks Account authority before and after reading.
        if (checking && ++currentnessChecks === 2) { reached(); await gate; }
        return true;
      }, subscribeInvalidation: listener => { invalidate = listener; return () => {}; } });
    try {
      expect(await cache.read()).toMatchObject({ status: 'available' });
      checking = true;
      const pending = cache.read();
      await atFinalCheck;
      invalidate();
      release();
      expect(await pending).toMatchObject({ status: 'unavailable', reason: 'rules-changed' });
    } finally { release(); cache.dispose(); http.mockRestore(); }
  });
  it('keeps a completed range refresh usable when another range refreshes during Account validation', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    let currentnessChecks = 0;
    let reached!: () => void;
    let release!: () => void;
    const atFinalCheck = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith('/v2/account/session-follow-preferences')) return { status: 200,
        data: { assigned: true, direct: false, team: false, group: false } };
      if (String(url).endsWith('/v2/account/session-follow-rules')) return { status: 200, data: { rules: [row] } };
      return { status: 404, data: {} };
    });
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://bob-follow.test', signal: new AbortController().signal,
      isCurrent: async () => {
        // First refresh: admission, source entry, encryption, HTTP, then final authority.
        if (++currentnessChecks === 5) { reached(); await gate; }
        return true;
      }, subscribeInvalidation: () => () => {} });
    try {
      const wider = cache.read({ refresh: true });
      await atFinalCheck;
      expect(await cache.read({ refresh: true })).toMatchObject({ status: 'available' });
      release();
      expect(await wider).toMatchObject({ status: 'available', rules: [{ ruleId: row.ruleId }] });
    } finally { release(); cache.dispose(); http.mockRestore(); }
  });
  it('refreshes progress once at a catchup range boundary without publishing an older pending read', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const fresh = { ...row, sources: [{ sourceSessionId: 'current-source',
      delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 4 } }] };
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: () => () => {}, read: async () => {
        reads++;
        if (reads === 1) { await gate; return { mode: 'plain', material: null, rules: [row] }; }
        return { mode: 'plain', material: null, rules: [fresh] };
      } });
    try {
      const older = cache.read();
      const current = cache.read({ refresh: true });
      release();
      expect(await older).toMatchObject({ status: 'unavailable', reason: 'rules-changed' });
      expect(await current).toMatchObject({ status: 'available', rules: [{ sources: fresh.sources }] });
      expect(await cache.read()).toBe(await current);
      expect(reads).toBe(2);
    } finally { release(); cache.dispose(); }
  });
  it('reads and validates defaults on the captured Account transport beside private rules', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const preferences = { assigned: true, direct: false, team: true, group: false };
    let valid = true;
    let invalidate = () => {};
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(String(url)).toMatch(/^https:\/\/bob-follow\.test\//);
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith('/v2/account/session-follow-rules')) return { status: 200, data: { rules: [row] } };
      if (String(url).endsWith('/v2/account/session-follow-preferences')) return { status: 200, data: valid ? preferences : { assigned: true } };
      return { status: 404, data: {} };
    });
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://bob-follow.test', signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; } });
    try {
      expect(await cache.read()).toMatchObject({ status: 'available', defaultPreferences: preferences });
      valid = false;
      invalidate();
      expect(await cache.read()).toMatchObject({ status: 'unavailable' });
    } finally { cache.dispose(); http.mockRestore(); }
  });
  it('opens once, shares concurrent demand, and reloads only after the existing change feed invalidates', async () => {
    let reads = 0;
    let invalidate = () => {};
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; },
      read: async () => { reads++; return { mode: 'plain', material: null, rules: [row] }; } });
    const [first, second] = await Promise.all([cache.read(), cache.read()]);
    expect(first).toMatchObject({ status: 'available', rules: [{ definition, sources: row.sources }] });
    expect(second).toBe(first);
    await cache.read();
    expect(reads).toBe(1);
    invalidate();
    await cache.read();
    expect(reads).toBe(2);
    cache.dispose();
  });

  it('does not reinterpret missing E2EE material or a mismatched mode as an empty rule set', async () => {
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) };
    const encrypted = { ...row, content: sealSessionFollowRuleContentV1({ ruleId: row.ruleId, receiver,
      definition, mode: 'e2ee', material }) };
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: () => () => {}, read: async () => ({ mode: 'e2ee', material: null, rules: [encrypted] }) });
    expect(await cache.read()).toMatchObject({ status: 'unavailable', reason: 'encryption-material-unavailable' });
    cache.dispose();
  });

  it.each(['retirement', 'invalidation'] as const)('withdraws overlapping refreshes that finish after Account %s', async cause => {
    let finish!: (value: { mode: 'plain'; material: null; rules: typeof row[] }) => void;
    let invalidate = () => {};
    const lifetime = new AbortController();
    const cache = createSessionFollowRuleCache({ signal: lifetime.signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; },
      read: async () => await new Promise(resolve => { finish = resolve; }) });
    const pending = cache.read({ refresh: true });
    const overlapping = cache.read({ refresh: true });
    if (cause === 'retirement') lifetime.abort();
    else invalidate();
    finish({ mode: 'plain', material: null, rules: [row] });
    const unavailable = { status: 'unavailable', reason: cause === 'retirement' ? 'account-retired' : 'rules-changed' };
    expect(await pending).toMatchObject(unavailable);
    expect(await overlapping).toMatchObject(unavailable);
    cache.dispose();
  });

  it.each(['retirement', 'invalidation'] as const)('withdraws a shared refresh invalidated during its promise handoff by %s', async cause => {
    let finish!: (value: { mode: 'plain'; material: null; rules: typeof row[] }) => void;
    let invalidate = () => {};
    let initial = true;
    const lifetime = new AbortController();
    const cache = createSessionFollowRuleCache({ signal: lifetime.signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; },
      read: async () => {
        if (!initial) return { mode: 'plain', material: null, rules: [{ ...row, version: 2 }] };
        initial = false;
        return await new Promise(resolve => { finish = resolve; });
      } });
    try {
      const refresh = cache.read({ refresh: true });
      const ordinary = cache.read();
      finish({ mode: 'plain', material: null, rules: [row] });
      expect(await ordinary).toMatchObject({ status: 'available' });
      if (cause === 'retirement') lifetime.abort();
      else invalidate();
      const overlapping = cache.read({ refresh: true });
      const unavailable = { status: 'unavailable', reason: cause === 'retirement' ? 'account-retired' : 'rules-changed' };
      expect(await refresh).toMatchObject(unavailable);
      const next = await overlapping;
      if (next.status === 'unavailable') expect(next).toMatchObject(unavailable);
      else expect(next.rules).toMatchObject([{ version: 2 }]);
    } finally { cache.dispose(); }
  });

  it('releases a failed shared refresh so a later demand can recover', async () => {
    let reject!: (reason: Error) => void;
    let failed = false;
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: () => () => {}, read: async () => {
        if (!failed) return await new Promise((_resolve, rejectRead) => { reject = rejectRead; });
        return { mode: 'plain', material: null, rules: [row] };
      } });
    try {
      const refresh = cache.read({ refresh: true });
      const overlapping = cache.read({ refresh: true });
      reject(new Error('Rules transport failed'));
      expect(await refresh).toMatchObject({ status: 'unavailable', reason: 'private-rules-unavailable' });
      expect(await overlapping).toMatchObject({ status: 'unavailable', reason: 'private-rules-unavailable' });
      failed = true;
      expect(await cache.read({ refresh: true })).toMatchObject({ status: 'available', rules: [{ ruleId: row.ruleId }] });
    } finally { cache.dispose(); }
  });
});
