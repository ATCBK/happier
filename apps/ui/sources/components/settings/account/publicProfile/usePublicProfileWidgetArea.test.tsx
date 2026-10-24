import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { WidgetDefinitionDraftV1Schema } from '@happier-dev/protocol/widgets';

import { renderHook } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { storage } from '@/sync/domains/state/storageStore';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readUsageWidgetPageContext, readUsageWidgetPageScope, usageWidgetSurfaceContext } from '@/components/settings/usage/usageWidgetPageContext';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
const policy = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
  'widgets.item.add': ['ui'], 'widgets.area.layout.create': ['ui'], 'widgets.item.remove': ['ui'],
  'widgets.definition.create': ['ui'], 'widgets.definition.update': ['ui'],
} });
let failReads = false;
let readGate: Promise<void> | null = null;
const runtime = installSessionPaneRuntimeTestHarness({ request: async (url, init) => {
  const path = new URL(String(url)).pathname;
  if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { actionsSettingsV1: policy } }, version: 0 });
  if (/^\/v1\/artifacts\/[^/]+$/.test(path) && (init?.method ?? 'GET') === 'GET') {
    if (readGate) await readGate;
    if (failReads) return Response.json({ error: 'Artifact read unavailable' }, { status: 500 });
  }
  return artifacts.handle(path + new URL(String(url)).search, init);
} });

let disposeLoader: (() => void) | undefined;
let usePublicProfileWidgetArea: typeof import('./usePublicProfileWidgetArea')['usePublicProfileWidgetArea'];
let useMountedActionExecution: typeof import('@/components/approvals/useMountedActionExecution')['useMountedActionExecution'];
beforeAll(async () => {
  const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
  disposeLoader = await installRealActionExecutorModuleLoader();
  ({ usePublicProfileWidgetArea } = await import('./usePublicProfileWidgetArea'));
  ({ useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution'));
});
afterAll(() => disposeLoader?.());
beforeEach(() => {
  artifacts.clear(); failReads = false; readGate = null;
  storage.setState({ settingsScope: { serverId: runtime.serverId, accountId: 'account-a' },
    settings: { ...storage.getState().settings, actionsSettingsV1: policy } });
});

async function openArea(context?: () => WidgetSurfaceContext) {
  return renderHook(() => {
    const execution = useMountedActionExecution({ serverId: runtime.serverId, accountId: 'account-a' });
    return { ...usePublicProfileWidgetArea(runtime.serverId, execution, undefined, context?.()), execution };
  });
}

it('compiles the acknowledged named area and copied placements, preserving a saved empty layout', async () => {
  const hook = await openArea();
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(hook.getCurrent().candidate?.layout.items.map(item => item.id)).toEqual(['totals', 'days', 'crew', 'planet']);
    expect(artifacts.list()).toHaveLength(0);
    const original = hook.getCurrent().candidate!;
    await act(async () => { expect(await hook.getCurrent().binding.createLayout('empty', 'Empty')).toMatchObject({ ok: true }); });
    await act(async () => { expect(await hook.getCurrent().binding.selectLayout('empty')).toMatchObject({ ok: true }); });
    await vi.waitFor(() => expect(hook.getCurrent().binding.surface?.owner).toMatchObject({ layoutId: 'empty' }));
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    // Create copies the current layout. Removing its last widget is an acknowledged empty document.
    for (const id of ['totals', 'days', 'crew', 'planet']) {
      await act(async () => { expect(await hook.getCurrent().binding.port!.execute({ actionId: 'widgets.item.remove', instanceId: id })).toMatchObject({ ok: true }); });
    }
    await act(async () => { await hook.getCurrent().area.reload(); });
    await vi.waitFor(() => expect(hook.getCurrent().candidate?.layout.items).toEqual([]));
    expect(original.isCurrent()).toBe(false);
    await act(async () => { const added = await hook.getCurrent().binding.port!.execute({ actionId: 'widgets.item.add',
      instance: { v: 1, id: 'copied-shipped', definition: { kind: 'builtin', id: 'usage_outcomes' }, bindings: { style: { kind: 'value', value: 'shipped' } } },
      size: 'wide' }); if (!added.ok) throw new Error(JSON.stringify(added)); });
    await act(async () => { await hook.getCurrent().area.reload(); });
    await vi.waitFor(() => expect(hook.getCurrent().candidate?.layout).toEqual({ v: 1, items: [expect.objectContaining({ id: 'copied-shipped', size: 'wide',
      presentation: { kind: 'usage', widgetId: 'usage_outcomes', inputs: { style: 'shipped' } } })] }));
  } finally { await hook.unmount(); }
});

it('keeps the reviewed copy through an unchanged pending and settled reread, but withdraws it on failure or Account retirement', async () => {
  const hook = await openArea();
  let release: (() => void) | undefined;
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    const captured = hook.getCurrent().candidate!;
    readGate = new Promise(resolve => { release = resolve; });
    let pending!: ReturnType<ReturnType<typeof hook.getCurrent>['area']['reload']>;
    await act(async () => { pending = hook.getCurrent().area.reload(); });
    const state = hook.getCurrent().area.state;
    if (state.status !== 'ready') throw new Error('Expected retained admitted layout');
    expect(state.isReadPending()).toBe(true);
    expect(state.isCurrent()).toBe(true);
    expect(captured.isCurrent()).toBe(true);
    await act(async () => { readGate = null; release?.(); await pending; });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(captured.isCurrent()).toBe(true);
    expect(hook.getCurrent().candidate?.layout).toEqual(captured.layout);
    failReads = true;
    await act(async () => { await hook.getCurrent().area.reload(); });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('unavailable'));
    expect(hook.getCurrent().candidate).toBeNull();
    expect(captured.isCurrent()).toBe(false);
    failReads = false;
    await act(async () => { await hook.getCurrent().area.reload(); });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    const current = hook.getCurrent().candidate!;
    retireActiveServerAccountScopeLifetime();
    expect(current.isCurrent()).toBe(false);
  } finally { readGate = null; release?.(); await hook.unmount(); }
});

it('invalidates a reviewed copy when its page source changes even if the placed layout is unchanged', async () => {
  const pageContext = (period: '90days' | '7days') => usageWidgetSurfaceContext(
    readUsageWidgetPageContext(readUsageWidgetPageScope(normalizeUsageQuery({ period: { relative: period } }))), period);
  let context = pageContext('90days');
  const hook = await openArea(() => context);
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    const captured = hook.getCurrent().candidate!;
    context = pageContext('7days');
    await hook.rerender();
    expect(captured.isCurrent()).toBe(false);
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(hook.getCurrent().candidate?.layout).toEqual(captured.layout);
    expect(captured.isCurrent()).toBe(false);
  } finally { await hook.unmount(); }
});

it('invalidates a reviewed copy on its actual Artifact definition edit without invalidating it for unrelated definitions', async () => {
  const hook = await openArea();
  const account = { serverId: runtime.serverId, accountId: 'account-a' };
  const definition = WidgetDefinitionDraftV1Schema.parse({ name: 'Shared days',
    sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
    inputSchema: { type: 'object', additionalProperties: false },
    body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Private live body' } } },
    publicPresentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Active days',
      data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'activeDays'], type: 'number' } } } },
  });
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    await act(async () => {
      await hook.getCurrent().execution.executeValue('widgets.definition.create', { account, artifactId: 'reviewed-days', definition });
      expect(await hook.getCurrent().binding.port!.execute({ actionId: 'widgets.item.add', size: 'medium',
        instance: { v: 1, id: 'reviewed-days-copy', definition: { kind: 'artifact', artifactId: 'reviewed-days' }, bindings: {} },
      })).toMatchObject({ ok: true });
      await hook.getCurrent().area.reload();
    });
    await vi.waitFor(() => expect(hook.getCurrent().candidate?.layout.items).toContainEqual(expect.objectContaining({
      id: 'reviewed-days-copy', title: 'Shared days',
    })));
    const captured = hook.getCurrent().candidate!;
    await act(async () => {
      await hook.getCurrent().execution.executeValue('widgets.definition.create', { account, artifactId: 'unrelated-days', definition });
    });
    expect(captured.isCurrent()).toBe(true);
    await act(async () => {
      await hook.getCurrent().execution.executeValue('widgets.definition.update', {
        account, artifactId: 'reviewed-days', patch: { name: 'Updated days' },
      });
    });
    expect(captured.isCurrent()).toBe(false);
    await vi.waitFor(() => expect(hook.getCurrent().candidate?.layout.items).toContainEqual(expect.objectContaining({
      id: 'reviewed-days-copy', title: 'Updated days',
    })));
    expect(captured.isCurrent()).toBe(false);
  } finally { await hook.unmount(); }
});
