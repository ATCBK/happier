import { expect, it } from 'vitest';
import { createActionExecutor } from '../actions/actionExecutor.js';
import { createHomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { flattenWidgetLayoutWidgetsV1 } from './widgetLayoutItemV1.js';

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
