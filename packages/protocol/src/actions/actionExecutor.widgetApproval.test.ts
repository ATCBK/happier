import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorContext } from './actionExecutor.js';
import type { ActionId } from './actionIds.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import type { WidgetSurfaceRefV1 } from '../widgets/widgetInstanceV1.js';
import { createWidgetActionInputResolverV1 } from '../widgets/widgetActionInputResolverV1.js';
import { readBuiltinWidgetDescriptorV1 } from '../widgets/builtinWidgetDescriptorV1.js';
import { createWidgetAreaActionPortV1, createWidgetAreaLayoutArtifactPortV1, createWidgetSurfaceArtifactPortV1 } from '../widgets/widgetSurfaceArtifactV1.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { createPluginWidgetAreaHostPortV1 } from '../plugins/ui/widgetAreaHost.js';

const account = { serverId: 'home', accountId: 'account' };

async function fixture(owner: WidgetSurfaceRefV1['owner'], shared: boolean, policyHook = true,
  presentUserActionConfirmation?: () => Promise<boolean>, readActionsSettings?: () => ReturnType<typeof normalizeActionsSettingsV1>) {
  const boundary = createWorkBoardArtifactBoundary();
  const transport = boundary.forAccount(account.accountId);
  // Artifact transport is the system boundary; domain ports and approval logic remain real.
  const admittedTransport = { ...transport, delete: boundary.transport.delete,
    read: async (...args: Parameters<typeof transport.read>) => {
      const row = await transport.read(...args);
      return row ? { ...row, shared } : null;
    },
    list: async (...args: Parameters<typeof boundary.transport.list>) => {
      const page = await boundary.transport.list(...args);
      return { ...page, items: page.items.map(row => ({ ...row, bodyVersion: boundary.rows.get(row.artifactId)!.revision.bodyVersion })) };
    },
  };
  const surface: WidgetSurfaceRefV1 = { ...account, owner };
  const presets = [{ id: 'main', name: 'Main', items: [] }, { id: 'other', name: 'Other', items: [] }];
  const artifactFor = (target: WidgetSurfaceRefV1) => createWidgetSurfaceArtifactPortV1(admittedTransport,
    { surface: target, isCurrent: () => true, presets });
  const layoutsFor = (target: WidgetSurfaceRefV1) => createWidgetAreaLayoutArtifactPortV1(admittedTransport,
    { surface: target, isCurrent: () => true, presets });
  const artifact = artifactFor(surface);
  for (const id of ['one', 'two']) await artifact.apply({ kind: 'add', instance: {
    v: 1, id, definition: { kind: 'builtin', id: 'session_summary' }, bindings: {},
  }, size: 'small' });
  await artifact.apply({ kind: 'group_create', groupId: 'group', instanceIds: ['two'] });
  const port = createWidgetAreaActionPortV1(artifactFor);
  const executor = createActionExecutor({ widgetAccountScope: () => account, presentUserActionConfirmation,
    ...(policyHook ? { isActionApprovalRequired: (actionId: ActionId, context: ActionExecutorContext, input: unknown) => isApprovalRequiredByActionsSettings(actionId,
      readActionsSettings?.() ?? context.actionsSettings ?? normalizeActionsSettingsV1({ v: 1 }), context, undefined, undefined, input) } : {}),
    widgetSurfaceActions: { [owner.kind]: port },
    widgetInputs: createWidgetActionInputResolverV1({
      readDescriptor: async ({ instance }) => readBuiltinWidgetDescriptorV1(instance.definition),
      readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
      validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
    }),
    widgetAreaLayouts: {
      reset: (input, _context, signal) => artifactFor(input.surface).resetPreset(input.expectedRevision, signal),
      undo: (capture, _context, signal) => artifactFor(capture.surface).undoReset(capture, signal),
      list: (input, _context, signal) => layoutsFor(input.surface).list(signal),
      create: (input, _context, signal) => layoutsFor(input.surface).create(input, signal),
      rename: (input, _context, signal) => layoutsFor(input.surface).rename(input, signal),
      reorder: (input, _context, signal) => layoutsFor(input.surface).reorder(input, signal),
      delete: (input, _context, signal) => layoutsFor(input.surface).delete(input, signal),
    },
  });
  return { surface, artifact, layouts: layoutsFor(surface), executor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function revision(artifact: Fixture['artifact']) {
  const state = await artifact.readState();
  if (state.kind !== 'present') throw new Error('Expected seeded layout');
  return state.revision;
}
const edits: readonly { name: string; action: ActionId; directUi?: boolean; input: (state: Fixture) => Promise<unknown> | unknown }[] = [
  { name: 'widget rename', action: 'widgets.item.rename', directUi: true, input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, displayName: 'Renamed' }) },
  { name: 'widget size', action: 'widgets.item.size.set', directUi: true, input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, size: 'medium' }) },
  { name: 'widget frame', action: 'widgets.item.frame.set', directUi: true, input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, frameStyle: 'plain' }) },
  { name: 'widget reorder', action: 'widgets.item.move', directUi: true, input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, toIndex: 1 }) },
  { name: 'widget native reorder', action: 'widgets.item.move', directUi: true, input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, to: { surface, index: 1 } }) },
  { name: 'group width', action: 'widgets.item.size.set', directUi: true, input: ({ surface }) => ({ ref: { surface, instanceId: 'group' }, width: 'half' }) },
  { name: 'group dividers', action: 'widgets.group.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'group' }, dividers: 'none' }) },
  { name: 'layout create', action: 'widgets.area.layout.create', input: ({ surface }) => ({ surface, layoutId: 'new', name: 'New' }) },
  { name: 'layout rename', action: 'widgets.area.layout.rename', input: async ({ surface, artifact }) => ({ surface, name: 'Renamed', expectedRevision: await revision(artifact) }) },
  { name: 'layout reorder', action: 'widgets.area.layout.reorder', input: async ({ surface, artifact, layouts }) => ({ surface,
    expectedRevision: await revision(artifact), position: { anchorId: (await layouts.list()).find(row => row.surface.owner.kind === surface.owner.kind && 'layoutId' in row.surface.owner && row.surface.owner.layoutId === 'other')!.artifactId, placement: 'after' } }) },
  { name: 'layout reset', action: 'widgets.area.layout.reset', input: async ({ surface, artifact }) => ({ surface, expectedRevision: await revision(artifact) }) },
  { name: 'layout undo', action: 'widgets.area.layout.undo', input: async ({ artifact }) => {
    const reset = await artifact.resetPreset(await revision(artifact));
    return { capture: reset.undo };
  } },
];

const owners = [
  { name: 'private Project', owner: { kind: 'project', projectId: 'project', layoutId: 'main' }, shared: false, dangerous: false },
  { name: 'shared Project', owner: { kind: 'project', projectId: 'project', layoutId: 'main' }, shared: true, dangerous: true },
  { name: 'plugin area', owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'pinned', layoutId: 'main' }, shared: false, dangerous: false },
  { name: 'shared plugin area', owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'pinned', layoutId: 'main' }, shared: true, dangerous: true },
  { name: 'core page', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, shared: false, dangerous: false },
  { name: 'shared core page', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, shared: true, dangerous: true },
] as const;

const consequentialEdits: readonly { action: ActionId; input: (state: Fixture) => unknown }[] = [
  { action: 'widgets.item.remove', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' } }) },
  { action: 'widgets.item.add', input: ({ surface }) => ({ surface, instance: { v: 1, id: 'added', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } }) },
  { action: 'widgets.item.inputs.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, bindings: {} }) },
  { action: 'widgets.item.inputs.reset', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' } }) },
  { action: 'widgets.group.create', input: ({ surface }) => ({ surface, groupId: 'another-group', instanceIds: ['one'] }) },
  { action: 'widgets.group.ungroup', input: ({ surface }) => ({ ref: { surface, instanceId: 'group' } }) },
  { action: 'widgets.group.inputs.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'group' }, bindings: {} }) },
  { action: 'widgets.group.add', input: ({ surface }) => ({ surface, group: { kind: 'group', id: 'copied-group', width: 'full',
    frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance: { v: 1, id: 'copied-child', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } }] } }) },
  { action: 'widgets.item.move', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' },
    to: { surface: { ...surface, owner: { ...surface.owner, layoutId: 'other' } }, index: 0 } }) },
];

describe('contextual widget approval at the Action executor', () => {
  it.each(['execute', 'prepare'] as const)('retains followed page input only in the live blocking %s invocation', async entry => {
    const boundary = createWorkBoardArtifactBoundary();
    const surface: WidgetSurfaceRefV1 = { ...account, owner: { kind: 'pluginArea', pluginId: 'external.widgets', pageId: 'overview', area: 'pinned' } };
    const artifact = createWidgetSurfaceArtifactPortV1(boundary.forAccount(account.accountId), { surface, isCurrent: () => true });
    let stored: ApprovalRequest | null = null;
    const executor = createActionExecutor({
      widgetAccountScope: () => account,
      widgetSurfaceActions: { pluginArea: createWidgetAreaActionPortV1(() => artifact) },
      widgetInputs: createWidgetActionInputResolverV1({
        readDescriptor: async ({ instance }) => readBuiltinWidgetDescriptorV1(instance.definition),
        readContext: async request => request.context.widgetAreaContext?.values ?? {},
        readViewerValues: async () => ({ values: {} }),
        // Session readability is the external host boundary; the resolver and binder remain real.
        validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
      }),
      // Approval persistence and human decision are the external boundaries.
      approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'approval' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = request; return { ok: true }; },
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'approve', request: {
        ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2 },
      } }),
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const host = createPluginWidgetAreaHostPortV1({ scope: account, pluginId: 'external.widgets', pageId: 'overview',
      declarations: [{ name: 'pinned', contextSchema: { type: 'object', properties: { session: { type: 'object' } }, required: ['session'], additionalProperties: false } }],
      isCurrent: () => true,
      execute: async (id, input, context) => {
        const invocation = { ...context, surface: 'plugin' as const, authority: 'account_automation' as const,
          defaultSessionMachineId: 'machine', runtimeAccountId: account.accountId,
          actionCaller: { kind: 'plugin' as const, pluginId: 'external.widgets', contributionLocalId: 'overview',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'external-root' } } };
        if (entry === 'execute') return executor.execute(id, input, invocation);
        const prepared = await executor.prepare(id, input, invocation);
        return prepared.kind === 'ready' ? prepared.invocation.run() : prepared.result;
      } });
    const copy = { v: 1 as const, id: 'follow', definition: { kind: 'builtin' as const, id: 'session_summary' },
      bindings: { session: { kind: 'context' as const, slot: 'session' } } };
    const result = await host.execute({ area: 'pinned', context: { session: { serverId: account.serverId, sessionId: 'private-session' } },
      operation: { actionId: 'widgets.item.add', instance: copy } }, undefined, 'page-add-request');
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { instance: copy } });
    expect((await artifact.read()).items).toContainEqual(expect.objectContaining({ instance: copy }));
    expect(stored).toMatchObject({ status: 'executed' });
    expect(JSON.stringify(stored)).not.toContain('private-session');
  });
  it('refuses a confirmation when current Account policy changed to Ask-first while the host was open', async () => {
    let settings = normalizeActionsSettingsV1({ v: 1 });
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, true, true,
      async () => {
        settings = normalizeActionsSettingsV1({ v: 1, actions: { 'widgets.item.rename': { approvalRequiredSurfaces: ['ui'] } } });
        return true;
      }, () => settings);
    const before = (await state.artifact.read()).items;
    expect(await state.executor.execute('widgets.item.rename', {
      ref: { surface: state.surface, instanceId: 'one' }, displayName: 'Stale decision',
    }, { surface: 'ui', authority: 'present_user', actionsSettings: settings }))
      .toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect((await state.artifact.read()).items).toEqual(before);
  });

  it('keeps declared-danger confirmation on the same host boundary for non-widget UI actions', async () => {
    const executor = createActionExecutor({ presentUserActionConfirmation: async () => false });
    expect(await executor.execute('projects.trust.revoke', {
      project: { serverId: 'home', projectId: 'project' }, expectedRevision: 1, expectedEffectDigest: 'reviewed-effect',
    }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'approval_canceled' });
  });

  it('offers admitted shared UI confirmation through the host and cancels without a write', async () => {
    let confirmations = 0;
    let approved = false;
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, true, true,
      async () => { confirmations += 1; return approved; });
    const before = (await state.artifact.read()).items;
    expect(await state.executor.execute('widgets.item.rename', {
      ref: { surface: state.surface, instanceId: 'one' }, displayName: 'Changed',
    }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'approval_canceled' });
    expect(confirmations).toBe(1);
    expect((await state.artifact.read()).items).toEqual(before);
    expect(await state.executor.prepare('widgets.item.rename', {
      ref: { surface: state.surface, instanceId: 'one' }, displayName: 'Prepared',
    }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'approvals_not_supported' } });
    expect(confirmations).toBe(1);
    expect((await state.artifact.read()).items).toEqual(before);
    approved = true;
    expect(await state.executor.execute('widgets.item.rename', {
      ref: { surface: state.surface, instanceId: 'one' }, displayName: 'Approved',
    }, { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
    expect(confirmations).toBe(2);
    const applied = (await state.artifact.read()).items;
    expect(applied[0]).toMatchObject({ instance: { id: 'one', displayName: 'Approved' } });
    expect(await state.executor.execute('widgets.item.rename', {
      ref: { surface: state.surface, instanceId: 'one' }, displayName: 'Requires Inbox approval',
    }, { surface: 'ui', authority: 'present_user', actionsSettings: normalizeActionsSettingsV1({ v: 1,
      actions: { 'widgets.item.rename': { approvalRequiredSurfaces: ['ui'] } },
      approvalWaivedSurfaces: { 'widgets.item.rename': ['ui'] },
    }) })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(confirmations).toBe(2);
    expect((await state.artifact.read()).items).toEqual(applied);
  });

  it.each(owners.flatMap(owner => edits.flatMap(edit => ['ui', 'mcp'].map(surface => ({ ...owner, ...edit, surface })))))('$name ($owner.kind, shared=$shared, $surface)', async row => {
    const state = await fixture(row.owner, row.shared);
    const input = await row.input(state);
    const before = [...(await state.artifact.read()).items];
    const result = await state.executor.execute(row.action, input, { surface: row.surface, authority: row.surface === 'ui' ? 'present_user' : 'account_automation' });
    if (row.surface === 'ui' && !row.shared && row.directUi) {
      if (row.owner.kind === 'project' && row.name === 'widget size') {
        expect(result).toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
        expect((await state.artifact.read()).items).toEqual(before);
      } else {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect((await state.artifact.read()).items).not.toEqual(before);
      }
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect((await state.artifact.read()).items).toEqual(before);
  });

  it.each(['ui', 'mcp'] as const)('honors a persisted %s approval waiver for a private widget edit', async surface => {
    // The executor must route persisted policy even without an optional host policy hook.
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, false, false);
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'widgets.item.rename': [surface] } });
    expect(await state.executor.execute('widgets.item.rename', { ref: { surface: state.surface, instanceId: 'one' }, displayName: 'Renamed' }, {
      surface, authority: surface === 'ui' ? 'present_user' : 'account_automation', actionsSettings,
    })).toMatchObject({ ok: true });
    expect((await state.artifact.read()).items[0]).toMatchObject({ instance: { id: 'one', displayName: 'Renamed' } });
  });

  it('fails closed without a policy hook and preserves Ask-first over a supplied waiver', async () => {
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, false, false);
    const input = { ref: { surface: state.surface, instanceId: 'one' }, displayName: 'Renamed' };
    const context = { surface: 'mcp' as const, authority: 'account_automation' as const };
    expect(await state.executor.execute('widgets.item.rename', input, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    const actionsSettings = normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { 'widgets.item.rename': ['mcp'] },
      actions: { 'widgets.item.rename': { approvalRequiredSurfaces: ['mcp'] } },
    });
    expect(await state.executor.execute('widgets.item.rename', input, { ...context, actionsSettings }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect((await state.artifact.read()).items[0]).toMatchObject({ instance: { id: 'one' } });
    expect((await state.artifact.read()).items[0]).not.toHaveProperty('instance.displayName');
  });

  it.each(owners.filter(owner => !owner.dangerous).flatMap(owner => edits.map(edit => ({ ...owner, ...edit }))))('retains explicit Ask-first for $name ($owner.kind)', async row => {
    const state = await fixture(row.owner, row.shared);
    const input = await row.input(state);
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, actions: { [row.action]: { approvalRequiredSurfaces: ['ui'] } } });
    expect(await state.executor.execute(row.action, input, { surface: 'ui', authority: 'present_user', actionsSettings }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });

  it.each(owners)('retains destructive layout deletion for $name', async row => {
    const state = await fixture(row.owner, row.shared);
    const created = await state.layouts.create({ surface: state.surface, layoutId: 'delete-me', name: 'Delete me' });
    expect(await state.executor.execute('widgets.area.layout.delete', { surface: created.surface, expectedRevision: created.revision },
      { surface: 'mcp', authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });

  it.each(['widgets.item.remove', 'widgets.item.network.set'] as const)('retains private present-user danger for %s', async action => {
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, false);
    const before = (await state.artifact.read()).items;
    expect(await state.executor.execute(action, {
      ref: { surface: state.surface, instanceId: 'one' },
      ...(action === 'widgets.item.network.set' ? { network: { network: 'none' } } : {}),
    }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect((await state.artifact.read()).items).toEqual(before);
  });

  it.each(owners.flatMap(owner => consequentialEdits.map(edit => ({ ...owner, ...edit }))))('retains danger for $action on $name', async row => {
    const state = await fixture(row.owner, row.shared);
    expect(await state.executor.execute(row.action, row.input(state), { surface: 'mcp', authority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });
});
