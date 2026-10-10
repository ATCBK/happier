import { describe, expect, it, vi } from 'vitest';

import type { ActionExecutorDeps } from '../actions/actionExecutor.js';
import { executeWidgetInstanceActionV1 } from './executeWidgetInstanceActionV1.js';

const selected = { serverId: 'home', accountId: 'account',
  owner: { kind: 'corePage' as const, pageId: 'usage', area: 'main', layoutId: 'checks' } };
const context = { surface: 'ui' as const, serverId: selected.serverId, bypassApprovals: true };

describe('widget layout selection', () => {
  it('opens through the mounted workspace and refuses when no answering client exists', async () => {
    const workspaceAction = vi.fn(async () => ({ ok: true as const }));
    const widgetAreaLayoutSelect = vi.fn(async () => ({ ok: true as const, result: {
      surface: selected, instances: [], canEdit: true,
    } }));
    const deps = {
      widgetAccountScope: () => ({ serverId: selected.serverId, accountId: selected.accountId }),
      workspaceAction,
      widgetAreaLayoutSelect,
    } satisfies ActionExecutorDeps;

    expect(await executeWidgetInstanceActionV1(deps, 'widgets.area.layout.select', { surface: selected }, context))
      .toMatchObject({ ok: true });
    expect(workspaceAction).toHaveBeenCalledWith({ actionId: 'workspace.tabs.open', input: {}, signal: undefined });
    expect(widgetAreaLayoutSelect).toHaveBeenCalledOnce();

    expect(await executeWidgetInstanceActionV1({
      widgetAccountScope: deps.widgetAccountScope,
      widgetAreaLayoutSelect,
    }, 'widgets.area.layout.select', { surface: selected }, context))
      .toEqual({ ok: false, errorCode: 'unavailable', error: 'noClient' });
  });
});
