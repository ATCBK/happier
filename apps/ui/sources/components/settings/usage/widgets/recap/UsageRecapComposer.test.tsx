import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { UsageRecapComposer } from './UsageRecapComposer';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { storage } from '@/sync/domains/state/storageStore';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; vi.restoreAllMocks(); });
const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 3, estimatedUsd: 0, currency: 'USD' } } };

async function mount(route: Parameters<typeof serveAccountHomes>[0]['route'], query = normalizeUsageQuery({ agents: ['claude', 'codex'] }), beforeRender?: () => void) {
  await import('@/sync/ops/actions/defaultActionExecutor');
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://recap-compose.test', accountId: 'a' }],
    route: request => request.path === '/v1/account/encryption/currentness'
      ? Response.json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 })
      : route(request) });
  const server = home.homes.a!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  let updateQuery!: (next: UsageQuery) => void;
  function Host() {
    const [shownQuery, setQuery] = React.useState(query);
    updateQuery = setQuery;
    return <UsageRecapComposer query={shownQuery} serverId={server.id} onClose={() => {}} />;
  }
  beforeRender?.();
  const screen = await renderScreen(<Host />);
  return { screen, updateQuery };
}

describe('recap composer through authorized query and composition', () => {
  it.each(['style', 'format'] as const)('admits %s changes through the same composition Action instead of altering an authorized preview locally', async choice => {
    const { screen } = await mount(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
    storage.setState(current => ({ settings: { ...current.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
      v: 1, actions: { 'usage.recap.compose': { enabled: false } },
    }) } }));
    await act(async () => {
      if (choice === 'style') screen.findAllByType(SelectionTiles)[0]!.props.onChange('sigil');
      else screen.findAllByType(SegmentedTabBar).find(node => node.props.testIDPrefix === 'usage-recap-format')!.props.onSelectTab('story');
    });
    await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'error')).toBe(true));
    expect(screen.findByTestId('usage-recap-composer.card')).toBeNull();
    expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(true);
  });
  it('composes useful accounting with truthful incomplete coverage while private sources remain pending', async () => {
    const heldPrivate = createDeferred<Response>();
    const { screen } = await mount(request => request.path === '/v2/usage/query'
      ? Response.json({ ...accounting, contributions: [{ id: 'cost', observedAtMs: 500, sessionId: 'work-session',
        turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
        tokens: accounting.totals.tokens, cost: accounting.totals.cost }] })
      : request.path === '/v2/sessions/work-session' ? heldPrivate.promise : undefined,
      normalizeUsageQuery({ session: 'work-session' }));
    try {
      await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
      expect(screen.findByTestId('usage-recap-composer.card')!.props.accessibilityLabel).toContain('12');
      expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(false);
    } finally { heldPrivate.resolve(Response.json({ error: 'not_found' }, { status: 404 })); }
  });

  it('withdraws a ready preview when its admitted Account authority retires', async () => {
    const { screen } = await mount(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
    await act(async () => { retireActiveServerAccountScopeLifetime(); });
    expect(screen.findByTestId('usage-recap-composer.card')).toBeNull();
    expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(true);
  });

  it('settles one admitted composition despite equivalent query and selected-field identity churn', async () => {
    const pending: ReturnType<typeof createDeferred<Response>>[] = [];
    const { screen, updateQuery } = await mount(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const deferred = createDeferred<Response>();
      pending.push(deferred);
      return deferred.promise;
    });
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const admitted = [...pending];
    await act(async () => {
      updateQuery(normalizeUsageQuery({ agents: ['codex', 'claude', 'claude'] }));
      screen.findByTestId('usage-recap-field-tokens.switch')!.props.onValueChange(true);
    });
    await act(async () => { admitted.forEach(deferred => deferred.resolve(Response.json(accounting))); });
    await vi.waitFor(() => expect({ ready: screen.findByTestId('usage-recap-composer.card') !== null,
      failure: screen.findAllByType(SurfaceStateCard).map(node => node.props.diagnosticCode) }).toMatchObject({ ready: true }));
    expect(screen.findByTestId('usage-recap-composer.card')!.props.accessibilityLabel).toContain('12');
    expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(false);
    pending.forEach(deferred => deferred.resolve(Response.json(accounting)));
  });

  it('keeps the last preview and style tiles while a format switch composes, never blanking them', async () => {
    let hold: ReturnType<typeof createDeferred<Response>> | null = null;
    const { screen } = await mount(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      if (!hold) return Response.json(accounting);
      return hold.promise;
    });
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
    hold = createDeferred<Response>();
    await act(async () => {
      screen.findAllByType(SegmentedTabBar).find(node => node.props.testIDPrefix === 'usage-recap-format')!.props.onSelectTab('story');
    });
    // Still composing the story: the square card and every style tile stay on screen.
    expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull();
    expect(screen.findAllByType(SelectionTiles)[0]!.props.options.every((option: { preview?: unknown }) => option.preview !== undefined)).toBe(true);
    expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(true);
    await act(async () => { hold!.resolve(Response.json(accounting)); });
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(false));
  });
  it('exposes a rejected preparation as a recoverable terminal failure', async () => {
    // Invalid clock evidence rejects query preparation before the Action resolves; keep its internal path real.
    const clock = vi.spyOn(Date, 'now');
    const { screen } = await mount(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined,
      undefined, () => { clock.mockReturnValue(Number.NaN); });
    clock.mockRestore();
    await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'error')).toBe(true));
    const failure = screen.findAllByType(SurfaceStateCard).find(node => node.props.kind === 'error')!;
    await act(async () => { failure.props.action.onPress(); });
    await vi.waitFor(() => expect({ ready: screen.findByTestId('usage-recap-composer.card') !== null,
      failure: screen.findAllByType(SurfaceStateCard).map(node => node.props.diagnosticCode) }).toMatchObject({ ready: true }));
    expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(false);
  });
});
