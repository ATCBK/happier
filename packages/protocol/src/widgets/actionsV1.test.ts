import { expect, it } from 'vitest';
import { createActionExecutor } from '../actions/actionExecutor.js';
import { createHomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { flattenWidgetLayoutWidgetsV1 } from './widgetLayoutItemV1.js';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1 } from './widgetSurfaceArtifactV1.js';

it('keeps surface-read failure and cancellation separate from a real Account scope change, then admits retry', async () => {
  const boundary = createWorkBoardArtifactBoundary();
  let scope = { serverId: 'home', accountId: 'owner' };
  const surface = { ...scope, owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'coach' } } as const;
  let fail = true;
  let changeScope = false;
  let cancel: AbortController | undefined;
  const transport = { ...boundary.forAccount('owner'), read: async () => {
    if (changeScope) scope = { ...scope, accountId: 'other' };
    if (cancel) { cancel.abort(); cancel.signal.throwIfAborted(); }
    if (fail) throw new Error('Artifact read failed');
    return null;
  } };
  const owner = createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1(transport, {
    surface: target, presets: [{ id: 'coach', name: 'Coach', items: [] }], isCurrent: () => true,
  }));
  const executor = createActionExecutor({ widgetAccountScope: () => scope, widgetSurfaceActions: { corePage: owner } });
  const read = (signal?: AbortSignal) => executor.execute('widgets.item.list', { surface }, { surface: 'ui', ...(signal ? { signal } : {}) });
  expect(await read()).toMatchObject({ ok: false, errorCode: 'widget_area_unavailable' });
  cancel = new AbortController();
  expect(await read(cancel.signal)).toMatchObject({ ok: false, errorCode: 'cancelled' });
  cancel = undefined;
  fail = false;
  expect(await read()).toMatchObject({ ok: true, result: { surface, preset: { id: 'coach' } } });
  changeScope = true;
  expect(await read()).toMatchObject({ ok: false, errorCode: 'widget_scope_unavailable' });
  changeScope = false;
  expect(await read()).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
  scope = { serverId: 'home', accountId: 'owner' };
  expect(await read()).toMatchObject({ ok: true, result: { surface } });
});

it('changes and copies only the stored guest-network choice through the widget Action owner', async () => {
  const boundary = createWorkBoardArtifactBoundary();
  const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'home' } } as const;
  const port = createHomeHubArtifactPortV1(boundary.forAccount('owner'), { accountId: 'owner' });
  const defaults = flattenWidgetLayoutWidgetsV1((await port.read()).items).map(item => item.instance);
  const instance = { v: 1, id: 'original', definition: { kind: 'builtin', id: 'summary' },
    bindings: { period: { kind: 'value', value: 'week' } } } as const;
  await port.apply({ kind: 'widget_add', instance });
  const executor = createActionExecutor({ homeHubArtifacts: port,
    widgetAccountScope: () => ({ serverId: 'home', accountId: 'owner' }) });
  const result = await executor.execute('widgets.item.network.set', {
    ref: { surface, instanceId: instance.id }, network: { networkOrigins: ['https://cdn.example.com'] },
  }, { surface: 'mcp', bypassApprovals: true });
  expect(result).toMatchObject({ ok: true, result: { instance: {
    ...instance, networkOverride: { networkOrigins: ['https://cdn.example.com'] },
  } } });
  const saved = flattenWidgetLayoutWidgetsV1((await port.read()).items).find(item => item.instance.id === instance.id)!.instance;
  await port.apply({ kind: 'widget_add', instance: { ...saved, id: 'copy' } });
  expect(await executor.execute('widgets.item.network.set', {
    ref: { surface, instanceId: instance.id }, network: { network: 'none' },
  }, { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: true });
  expect(flattenWidgetLayoutWidgetsV1((await port.read()).items).map(item => item.instance)).toEqual([
    ...defaults,
    { ...instance, networkOverride: { network: 'none' } },
    { ...saved, id: 'copy' },
  ]);
  const before = await port.read();
  expect(await executor.execute('widgets.item.network.set', {
    ref: { surface, instanceId: instance.id }, network: { network: 'open', actions: ['session.send'] },
  }, { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: false });
  expect(await port.read()).toEqual(before);
});

it('admits group references through the deferred Action graph without widening their surface authority', async () => {
  const { WidgetInstanceActionInputSchemasV1 } = await import('./actionsV1.js');
  const schema = WidgetInstanceActionInputSchemasV1['widgets.group.ungroup'];
  const ref = { surface: { serverId: 'home', accountId: 'owner', owner: { kind: 'home' } }, instanceId: 'group' };

  expect(schema.parse({ ref })).toEqual({ ref });
  expect(schema.safeParse({ ref: { ...ref, surface: { ...ref.surface, owner: { kind: 'sessionBoard', sessionId: 'session' } } } }).success).toBe(false);
  expect(schema.safeParse({ ref: { ...ref, extra: true } }).success).toBe(false);
});
