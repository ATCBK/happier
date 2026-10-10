import { describe, expect, it, vi } from 'vitest';

import type { ActionExecutorDeps } from '../actions/actionExecutor.js';
import { createActionExecutor } from '../actions/actionExecutor.js';
import { executeWidgetInstanceActionV1 } from './executeWidgetInstanceActionV1.js';

const selected = { serverId: 'home', accountId: 'account',
  owner: { kind: 'corePage' as const, pageId: 'usage', area: 'main', layoutId: 'checks' } };
const context = { surface: 'ui' as const, serverId: selected.serverId, bypassApprovals: true };

describe('widget layout selection', () => {
  it('selects through the mounted area without opening a workspace tab and refuses without that owner', async () => {
    const workspaceAction = vi.fn(async () => { throw new Error('Layout selection must not open a tab'); });
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
    expect(workspaceAction).not.toHaveBeenCalled();

    expect(await executeWidgetInstanceActionV1({
      widgetAccountScope: deps.widgetAccountScope,
    }, 'widgets.area.layout.select', { surface: selected }, context))
      .toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_unavailable' });

    // The host's mounted-area port is the answering client; a Companion is unrelated.
    expect(await createActionExecutor({ widgetAccountScope: deps.widgetAccountScope, widgetAreaLayoutSelect })
      .execute('widgets.area.layout.select', { surface: selected }, context)).toMatchObject({ ok: true });
  });
});
