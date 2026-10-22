import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import { renderHook } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { storage } from '@/sync/domains/state/storageStore';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
const policy = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
  'widgets.item.add': ['ui'], 'widgets.area.layout.create': ['ui'], 'widgets.item.remove': ['ui'],
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

async function openArea() {
  return renderHook(() => {
    const execution = useMountedActionExecution({ serverId: runtime.serverId, accountId: 'account-a' });
    return usePublicProfileWidgetArea(runtime.serverId, execution);
  });
}

it('compiles the acknowledged named area and copied placements, preserving a saved empty layout', async () => {
  const hook = await openArea();
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(hook.getCurrent().candidate?.layout.items.map(item => item.id)).toEqual(['days', 'crew', 'planet']);
    expect(artifacts.list()).toHaveLength(0);
    const original = hook.getCurrent().candidate!;
    await act(async () => { expect(await hook.getCurrent().binding.createLayout('empty', 'Empty')).toMatchObject({ ok: true }); });
    await act(async () => { expect(await hook.getCurrent().binding.selectLayout('empty')).toMatchObject({ ok: true }); });
    await vi.waitFor(() => expect(hook.getCurrent().binding.surface?.owner).toMatchObject({ layoutId: 'empty' }));
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    // Create copies the current layout. Removing its last widget is an acknowledged empty document.
    for (const id of ['days', 'crew', 'planet']) {
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

it('withdraws Apply while an area observation is pending, unavailable, or its Account retires', async () => {
  const hook = await openArea();
  let release: (() => void) | undefined;
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    const captured = hook.getCurrent().candidate!;
    readGate = new Promise(resolve => { release = resolve; });
    let pending!: ReturnType<ReturnType<typeof hook.getCurrent>['area']['reload']>;
    await act(async () => { pending = hook.getCurrent().area.reload(); });
    expect(captured.isCurrent()).toBe(false);
    failReads = true;
    await act(async () => { readGate = null; release?.(); await pending; });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('unavailable'));
    expect(hook.getCurrent().candidate).toBeNull();
    failReads = false;
    await act(async () => { await hook.getCurrent().area.reload(); });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    const current = hook.getCurrent().candidate!;
    retireActiveServerAccountScopeLifetime();
    expect(current.isCurrent()).toBe(false);
  } finally { readGate = null; release?.(); await hook.unmount(); }
});
