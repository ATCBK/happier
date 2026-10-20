import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageRecapExportResultSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { standardCleanup } from '@/dev/testkit';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore } from '@/sync/api/account/usageQueryResource';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });
const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 99, estimatedUsd: 0, currency: 'USD' } },
  breakdowns: { model: [{ key: 'private-id', label: 'Private Model', eventCount: 1,
    tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 }, cost: { reportedUsd: 99, estimatedUsd: 0, currency: 'USD' } }] } };
async function context(denied = false, route?: Parameters<typeof serveAccountHomes>[0]['route']) {
  const sessionBatch = createSessionReadBatchHttpBoundary(async request => (await route?.(request)) ?? (request.path === '/v2/usage/query'
    ? denied ? new Response('denied', { status: 403 }) : Response.json(accounting) : undefined));
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://recap-export.test', accountId: 'account-a' }],
    route: sessionBatch.handle });
  const focused = home.homes.a!;
  publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
  return { surface: 'ui' as const, actionCaller: { kind: 'host' as const }, serverId: focused.id, expectedAccountId: 'account-a' };
}
const input = { query: normalizeUsageQuery({ period: { startMs: 100, endMs: 900 } }), style: 'holo', format: 'square', selectedFields: ['tokens', 'modelMix'] };

describe('recap export through the real captured UI Account Action', () => {
  it('refuses unavailable shared Resource admission without starting a separate read', async () => {
    const caller = await context();
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
    const captured = captureUiUsageQueryAccountContext(credentials)!;
    getUsageQueryResourceStore(captured).dispose();
    const settled: ActionExecuteResult[] = [];
    const controller = new AbortController();
    const pending = createDefaultActionExecutor().execute('usage.query', { queries: [input.query] }, { ...caller, signal: controller.signal })
      .then(result => { settled.push(result); });
    try {
      await vi.waitFor(() => expect(settled[0]).toMatchObject({ ok: false, errorCode: 'plugin_surface_retired' }));
      expect(home!.requests.some(request => request.path === '/v2/usage/query')).toBe(false);
    } finally {
      controller.abort();
      await pending.catch(error => {
        if (!(error instanceof Error && error.name === 'AbortError')) throw error;
      });
    }
  });

  it('shares the progressing page Resource and leaves its subscriber alive after a one-shot Action settles', async () => {
    const privateSession = createDeferred<Response>();
    const caller = await context(false, request => request.path === '/v2/usage/query'
      ? Response.json({ ...accounting, contributions: [{ id: 'cost', observedAtMs: 500, sessionId: 'work-session',
        turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
        tokens: accounting.totals.tokens, cost: accounting.totals.cost }] })
      : request.path === '/v2/sessions/work-session' ? privateSession.promise
        : request.path === '/v1/account/encryption/currentness' ? Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) : undefined);
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
    const captured = captureUiUsageQueryAccountContext(credentials)!;
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [input.query] }) });
    const release = entry.subscribe(() => {}, true);
    const read = () => entry.getSnapshot().value ? decodeUsageQueryResource(entry.getSnapshot().value!) : undefined;
    try {
      await vi.waitFor(() => expect(read()?.results[0]?.accounting).toBeDefined());
      const executed = await createDefaultActionExecutor().execute('usage.query', { queries: [input.query] }, caller);
      expect(executed.ok).toBe(true);
      if (!executed.ok) throw new Error(executed.errorCode);
      const admitted = UsageQueryBatchResultSchema.parse(executed.result);
      expect(admitted.results[0]?.pending).toBe(true);
      expect(admitted).toEqual(read());
      privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      expect(read()?.results[0]?.sources).not.toContainEqual({ source: 'how_you_work', status: 'pending' });
      expect(entry.getSnapshot().subscription).toBe('live');
      expect(admitted.results[0]?.pending).toBe(true);
    } finally { privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 })); release(); }
  });

  it('returns the one-shot query snapshot without harvesting held private evidence', async () => {
    const privateSession = createDeferred<Response>();
    const caller = await context(false, request => request.path === '/v2/usage/query'
      ? Response.json({ ...accounting, contributions: [{ id: 'cost', observedAtMs: 500, sessionId: 'work-session',
        turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
        tokens: accounting.totals.tokens, cost: accounting.totals.cost }] })
      : request.path === '/v2/sessions/work-session' ? privateSession.promise
        : request.path === '/v1/account/encryption/currentness' ? Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) : undefined);
    const settled: ActionExecuteResult[] = [];
    const pending = createDefaultActionExecutor().execute('usage.query', { queries: [input.query] }, caller)
      .then(result => { settled.push(result); });
    try {
      await vi.waitFor(() => expect(settled[0]?.ok).toBe(true));
      const executed = settled[0]!;
      if (!executed.ok) throw new Error('Expected useful snapshot');
      const result = UsageQueryBatchResultSchema.parse(executed.result).results[0]!;
      expect(result.accounting?.totals.tokens.total).toBe(12);
      expect(result.pending).toBe(true);
      expect(result.howYouWork?.intervals).toBeNull();
      expect(result.sources).toContainEqual({ source: 'how_you_work', status: 'pending' });
      const exported = await createDefaultActionExecutor({ usageRecapRender: async compose => {
        expect(compose.coverage.pending).toBe(true);
        expect(compose.unavailableFields).toContain('parallel');
        return { kind: 'rendered', base64: 'iVBORw==' };
      } }).execute('usage.recap.export', { ...input, selectedFields: ['tokens', 'parallel'] }, caller);
      expect(exported.ok).toBe(true);
      if (!exported.ok) throw new Error(exported.errorCode);
      expect(UsageRecapExportResultSchema.parse(exported.result)).toMatchObject({ kind: 'exported',
        compose: { coverage: { pending: true }, unavailableFields: ['parallel'] } });
    } finally { privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 })); await pending; }
  });

  it('renders the authorized selected query and delivers the same strict PNG result used by local surfaces', async () => {
    const caller = await context();
    let painted: unknown;
    // Rasterization is the client/platform boundary, never substituted Usage or Action logic.
    const executor = createDefaultActionExecutor({ usageRecapRender: async compose => {
      painted = compose;
      return { kind: 'rendered', base64: 'iVBORw==' };
    } });
    const executed = await executor.execute('usage.recap.export', input, caller);
    expect(executed.ok).toBe(true);
    if (!executed.ok) throw new Error(executed.errorCode);
    const result = UsageRecapExportResultSchema.parse(executed.result);
    expect(result).toMatchObject({ kind: 'exported', compose: painted,
      file: { mediaType: 'image/png', base64: 'iVBORw==', selectedFields: ['tokens', 'modelMix'] } });
    expect(JSON.stringify(result)).not.toMatch(/Private Model|private-id|reportedUsd|USD/);
  });
  it('withdraws PNG bytes if the real Account lifetime retires while rendering', async () => {
    const caller = await context();
    const executor = createDefaultActionExecutor({ usageRecapRender: async () => {
      retireActiveServerAccountScopeLifetime();
      return { kind: 'rendered', base64: 'iVBORw==' };
    } });
    const executed = await executor.execute('usage.recap.export', input, caller);
    expect(executed).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(JSON.stringify(executed)).not.toContain('iVBORw==');
  });
  it('does not render or return file bytes for an accounting permission denial', async () => {
    const caller = await context(true);
    const executor = createDefaultActionExecutor({ usageRecapRender: async () => { throw new Error('denied facts must not render'); } });
    const executed = await executor.execute('usage.recap.export', input, caller);
    expect(executed).toMatchObject({ ok: false, errorCode: 'denied' });
    expect(JSON.stringify(executed)).not.toContain('base64');
  });
});
