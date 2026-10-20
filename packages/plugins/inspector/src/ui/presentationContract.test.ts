// @vitest-environment jsdom

import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
} from '@happier-dev/plugin-sdk/testing';
import * as React from 'react';
import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

// First-party RNW contract coverage consumes the same public testing subpath
// exposed to external authors.
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { renderSurface } from './renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type InspectorExecuteActionRequest = Readonly<{
  action: unknown;
  input?: unknown;
}>;

function enterText(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('The RNW semantic fixture did not expose an input value setter.');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function createInspectorSurfaceContext() {
  return createSurfaceContextFixture({
    mount: {
      kind: 'destination',
      destination: { pluginId: 'happier.inspector', localId: 'inspector-app' },
      container: 'rightSidebarTab',
    },
    target: { kind: 'app' },
  });
}

async function findInventoryRefreshRow(fixture: Awaited<ReturnType<typeof createPluginUiTestkit>>) {
  // A row's accessible name includes its descriptive subtitle. Locate its
  // real public semantic control instead of assuming the title is the name.
  return vi.waitFor(async () => {
    const roles = await Promise.all([
      fixture.queryAllByRole('button'), fixture.queryAllByRole('option'),
    ]);
    const rows = roles.flat().filter(target => target.name?.startsWith('Refresh with list row'));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  });
}

function verticalScrollAncestors(element: HTMLElement): HTMLElement[] {
  const ancestors: HTMLElement[] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const overflowY = getComputedStyle(ancestor).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') {
      ancestors.push(ancestor);
    }
  }
  return ancestors;
}

describe('Inspector public presentation contract', () => {

  it('waits for shared host readiness before reading inventory and reacquires without Retry', async () => {
    let withdrawn = true;
    let inventoryReads = 0;
    let deferRefresh = false;
    let rejectRefresh: ((error: PluginError) => void) | undefined;
    let title = 'Review Assistant';
    const initial = { ...createInspectorSurfaceContext(), machineConnectionPending: true, machineExecutionReady: false };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'inventory-readiness', mountNonce: 'inventory-readiness-mount' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: initial,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action }: InspectorExecuteActionRequest) => {
        if (action !== 'plugins.list') return { ok: true };
        inventoryReads += 1;
        if (withdrawn) throw new PluginError({ code: 'unavailable', retryable: true,
          diagnostics: [{ code: 'target_unavailable', severity: 'error' }] });
        if (deferRefresh) return new Promise<never>((_resolve, reject) => { rejectRefresh = reject; });
        return { plugins: [{ pluginId: 'com.acme.review-assistant', title, enabled: true }] };
      } },
    });
    try {
      await expect(fixture.queryByRole('alert')).resolves.toBeUndefined();
      expect(inventoryReads).toBe(0);
      await expect(fixture.queryByText('No plugins installed.')).resolves.toBeUndefined();
      withdrawn = false;
      await React.act(async () => { await fixture.updateSurface({ ...initial,
        machineConnectionPending: false, machineExecutionReady: true }); });
      await expect(fixture.getByRole('button', { name: 'Reload Review Assistant' })).resolves.toBeDefined();
      await expect(fixture.queryByRole('alert')).resolves.toBeUndefined();
      deferRefresh = true;
      await fixture.press(await findInventoryRefreshRow(fixture));
      expect(rejectRefresh).toBeTypeOf('function');
      await React.act(async () => { await fixture.updateSurface(initial); });
      await React.act(async () => { rejectRefresh?.(new PluginError({ code: 'unavailable', retryable: true })); });
      await expect(fixture.queryByRole('alert')).resolves.toBeUndefined();
      await expect(fixture.getByRole('button', { name: 'Reload Review Assistant' })).resolves.toBeDefined();
      deferRefresh = false;
      title = 'Updated review assistant';
      await React.act(async () => { await fixture.updateSurface({ ...initial,
        machineConnectionPending: false, machineExecutionReady: true }); });
      await expect(fixture.getByRole('button', { name: 'Reload Updated review assistant' })).resolves.toBeDefined();
    } finally { await fixture.dispose(); }
  });

  it('publishes the settled public Action result for the mounted self-check', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => (
      action === 'plugins.list' ? { plugins: [] } : { ok: true }
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-151', mountNonce: 'fixture-mount-151' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });
    try {
      // In a pane the host's pane header names the Inspector; the pane opens on its purpose.
      await expect(fixture.getByText('Inspect installed plugins, diagnostics, and reload state.'))
        .resolves.toBeDefined();
      await expect(fixture.getAllByRole('button', { name: 'Execute Inspector self-check' }))
        .resolves.toHaveLength(1);
      await fixture.press(await fixture.findByRole('button', { name: 'Execute Inspector self-check' }));
      await expect(fixture.getByText('Self-check passed')).resolves.toEqual({
        content: 'Self-check passed',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('does not offer page navigation through its action panel when the mounted host has not negotiated openSurface', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action === 'plugins.list') return { plugins: [] };
      return { ok: true };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-152', mountNonce: 'fixture-mount-152' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.queryByRole('button', { name: 'Open inspector page' })).resolves.toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('offers page navigation through its action panel only when the mounted host has negotiated openSurface', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action === 'plugins.list') return { plugins: [] };
      return { ok: true };
    });
    const openSurface = vi.fn(async () => undefined);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-153', mountNonce: 'fixture-mount-153' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction, openSurface },
    });

    try {
      await fixture.press(await fixture.findByRole('button', { name: 'Open Inspector quick menu' }));
      await fixture.press(await fixture.findByRole('button', { name: 'Open inspector page' }));

      await vi.waitFor(() => {
        expect(openSurface).toHaveBeenCalledWith(expect.objectContaining({
          view: { pluginId: 'happier.inspector', localId: 'inspector-page' },
          input: { source: 'inspector-action-panel' },
        }));
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('renders the admitted inventory without a bulk reload path and dispatches only that row\'s reload action through the public host boundary', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action === 'plugins.list') {
        return {
          plugins: [{
            pluginId: 'com.acme.review-assistant',
            version: '1.2.3',
            title: 'Review Assistant',
            enabled: true,
          }],
        };
      }
      if (action === 'plugins.reload') {
        return { ok: true, generation: 2, changedPluginIds: [], affectedPluginIds: [] };
      }
      return { ok: true };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-154', mountNonce: 'fixture-mount-154' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.queryByRole('button', { name: 'Reload all' })).resolves.toBeUndefined();
      await fixture.press(await fixture.findByRole('button', { name: 'Open Inspector quick menu' }));
      await expect(fixture.queryByText('Reload all')).resolves.toBeUndefined();

      const pluginReload = await fixture.findByRole('button', { name: 'Reload Review Assistant' });

      await fixture.press(pluginReload);

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'plugins.reload',
          input: { pluginId: 'com.acme.review-assistant' },
        }));
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugins.list', input: {} }));
      });
      const reloadRequests = executeAction.mock.calls
        .map(([request]) => request)
        .filter((request) => request.action === 'plugins.reload');
      expect(reloadRequests.map((request) => request.input)).toEqual([
        { pluginId: 'com.acme.review-assistant' },
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it('names a row\'s current daemon diagnostic in its own words and leaves resolved ones out', async () => {
    const record = (message: string, state: 'current' | 'resolved') => ({
      version: 1,
      id: `happier.agent.codex:normalization:${state}`,
      data: { code: 'plugin_external_session_source_refused', severity: 'error', message },
      plugin: { id: 'happier.agent.codex', version: '0.0.0', source: 'bundled' },
      stage: 'normalization',
      host: 'daemon',
      platform: 'linux',
      occurredAtMs: 1,
      resolution: state === 'current' ? { state } : { state, resolvedAtMs: 2 },
    });
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => (
      action === 'plugins.list'
        ? { plugins: [{
            pluginId: 'happier.agent.codex',
            version: '0.0.0',
            title: 'Codex',
            enabled: true,
            diagnostics: [
              record('Configured External Sessions source for Agent \'codex\' was refused', 'current'),
              record('An earlier refusal that has cleared', 'resolved'),
            ],
          }] }
        : { ok: true }
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-diag', mountNonce: 'fixture-mount-diag' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await vi.waitFor(async () => {
        await expect(fixture.queryByText('Configured External Sessions source for Agent \'codex\' was refused')).resolves.toBeDefined();
      });
      await expect(fixture.queryByText('diagnostic')).resolves.toBeUndefined();
      await expect(fixture.queryByText('An earlier refusal that has cleared', { exact: false })).resolves.toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('scrolls its header, inventory rows and gallery as one page with a single scroll owner', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => action === 'plugins.list'
      ? {
          plugins: [{
            pluginId: 'com.acme.review-assistant',
            title: 'Review Assistant',
            enabled: true,
          }],
        }
      : { ok: true });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-155', mountNonce: 'fixture-mount-155' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.findByRole('button', { name: 'Reload Review Assistant' })).resolves.toBeDefined();

      // The rows get the room: the header above them and the gallery below them scroll with them in one
      // scroller, rather than standing as fixed chrome around a squeezed list.
      const row = document.querySelector<HTMLElement>('[data-testid="inspector-plugin-com.acme.review-assistant"]');
      expect(row, 'the populated inventory row must render').not.toBeNull();
      const scrollers = verticalScrollAncestors(row!);
      expect(scrollers).toHaveLength(1);
      expect(scrollers[0]!.contains(document.querySelector('[data-testid="inspector-self-check-card"]'))).toBe(true);
      expect(scrollers[0]!.contains(document.querySelector('[data-testid="inspector-component-gallery"]'))).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps an inventory failure visible with its host diagnostic and retries the exact read', async () => {
    let listReadCount = 0;
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action !== 'plugins.list') return { ok: true };
      listReadCount += 1;
      if (listReadCount === 1) throw new Error('plugin_action_unavailable');
      return { plugins: [] };
    });
    const context = { ...createInspectorSurfaceContext(), machineConnectionPending: false, machineExecutionReady: true };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-155-error', mountNonce: 'fixture-mount-155-error' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: context,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.getByRole('alert')).resolves.toBeDefined();
      await expect(fixture.getByText('Plugin inventory unavailable')).resolves.toBeDefined();
      await expect(fixture.getByText('A plugin UI test host handler failed.')).resolves.toBeDefined();

      await React.act(async () => { await fixture.updateSurface({ ...context }); });
      expect(listReadCount).toBe(1);
      await expect(fixture.getByRole('alert')).resolves.toBeDefined();

      await fixture.press(await fixture.findByRole('button', { name: 'Try inventory again' }));

      await vi.waitFor(() => {
        expect(listReadCount).toBe(2);
      });
      await expect(fixture.queryByRole('alert')).resolves.toBeUndefined();
      await expect(fixture.getByText('No plugins installed.')).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('uses public Image for a non-brand packaged illustration with an accessible fallback', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => action === 'plugins.list'
      ? { plugins: [] }
      : { ok: true });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-156', mountNonce: 'fixture-mount-156' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.getByText('No plugins installed.')).resolves.toEqual({
        content: 'No plugins installed.',
      });
      const inventoryIllustration = document.querySelector<HTMLElement>(
        '[data-testid="inspector-inventory-illustration"]',
      );
      expect(inventoryIllustration, 'Inspector must maintain a public generic Image consumer').not.toBeNull();
      expect(inventoryIllustration?.getAttribute('aria-label')).toBe('Plugin inventory illustration');
      expect(inventoryIllustration?.tagName).not.toBe('IMG');
      await expect(fixture.getByText('PI')).resolves.toEqual({ content: 'PI' });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the admitted inventory visible and reports an in-flight refresh through the public Progress contract', async () => {
    let listReadCount = 0;
    let resolveRefresh!: (result: unknown) => void;
    const pendingRefresh = new Promise<unknown>((resolve) => {
      resolveRefresh = resolve;
    });
    const reviewAssistant = {
      pluginId: 'com.acme.review-assistant',
      version: '1.2.3',
      title: 'Review Assistant',
      enabled: true,
    };
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action !== 'plugins.list') return { ok: true };
      listReadCount += 1;
      return listReadCount === 1
        ? { plugins: [reviewAssistant] }
        : pendingRefresh;
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-157', mountNonce: 'fixture-mount-157' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.findByRole('button', { name: 'Reload Review Assistant' })).resolves.toBeDefined();

      await React.act(async () => {
        await fixture.press(await fixture.findByRole('button', { name: 'Refresh with icon button' }));
      });

      await vi.waitFor(() => {
        expect(listReadCount).toBe(2);
      });
      await expect(fixture.getByRole('progressbar', {
        name: 'Refreshing plugin inventory',
      })).resolves.toEqual({
        role: 'progressbar',
        name: 'Refreshing plugin inventory',
      });
      // The admitted inventory stays on screen while it refreshes.
      await expect(fixture.getByRole('button', { name: 'Reload Review Assistant' })).resolves.toBeDefined();

      await React.act(async () => {
        resolveRefresh({ plugins: [reviewAssistant] });
        await Promise.resolve();
      });
      await vi.waitFor(async () => {
        await expect(fixture.queryByRole('progressbar', {
          name: 'Refreshing plugin inventory',
        })).resolves.toBeUndefined();
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('shares the pending inventory read across repeated refresh entrances', async () => {
    const plugin = { pluginId: 'com.acme.review-assistant', version: '1.0.0', title: 'Review Assistant', enabled: true };
    let resolveRefresh!: (value: unknown) => void;
    const pending = new Promise<unknown>(resolve => { resolveRefresh = resolve; });
    let reads = 0;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'shared-refresh', mountNonce: 'shared-refresh' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action }: InspectorExecuteActionRequest) => {
        if (action !== 'plugins.list') return { ok: true };
        reads += 1;
        return reads === 1 ? { plugins: [plugin] } : pending;
      } },
    });
    try {
      await fixture.findByRole('button', { name: 'Reload Review Assistant' });
      await fixture.press(await findInventoryRefreshRow(fixture));
      await vi.waitFor(() => expect(reads).toBe(2));
      await fixture.press(await findInventoryRefreshRow(fixture));
      // This counts real host reads: repeated entrances must join the pending read.
      expect(reads).toBe(2);
      await expect(fixture.getByRole('progressbar', { name: 'Refreshing plugin inventory' })).resolves.toBeDefined();
      await React.act(async () => { resolveRefresh({ plugins: [{ ...plugin, version: '2.0.0' }] }); });
      await expect(fixture.getByText('com.acme.review-assistant · v2.0.0 · enabled')).resolves.toBeDefined();
      await expect(fixture.queryByRole('progressbar', { name: 'Refreshing plugin inventory' })).resolves.toBeUndefined();
    } finally { resolveRefresh({ plugins: [plugin] }); await fixture.dispose(); }
  });

  it.each(['success', 'failure', 'rejection'] as const)('preserves the post-reload inventory when an older refresh settles with %s', async settlement => {
    const plugin = { pluginId: 'com.acme.review-assistant', version: '1.0.0', title: 'Review Assistant', enabled: true };
    let resolveOlder!: (value: unknown) => void;
    let rejectOlder!: (reason: Error) => void;
    let resolveNewer!: (value: unknown) => void;
    const older = new Promise<unknown>((resolve, reject) => { resolveOlder = resolve; rejectOlder = reject; });
    const newer = new Promise<unknown>(resolve => { resolveNewer = resolve; });
    let reads = 0;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `refresh-${settlement}`, mountNonce: `refresh-${settlement}` },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action }: InspectorExecuteActionRequest) => {
        if (action === 'plugins.reload') return { ok: true, kind: 'plugins_reload', changedPluginIds: [plugin.pluginId], affectedPluginIds: [] };
        if (action !== 'plugins.list') return { ok: true };
        reads += 1;
        return reads === 1 ? { ok: true, kind: 'plugins_list', plugins: [plugin] } : reads === 2 ? older : newer;
      } },
    });
    try {
      await fixture.findByRole('button', { name: 'Reload Review Assistant' });
      await fixture.press(await findInventoryRefreshRow(fixture));
      await vi.waitFor(() => expect(reads).toBe(2));
      await fixture.press(await fixture.findByRole('button', { name: 'Reload Review Assistant' }));
      await vi.waitFor(() => expect(reads).toBe(3));
      await React.act(async () => { resolveNewer({ ok: true, kind: 'plugins_list', plugins: [{ ...plugin, version: '2.0.0' }] }); });
      await vi.waitFor(async () => { await expect(fixture.getByText('com.acme.review-assistant · v2.0.0 · enabled')).resolves.toBeDefined(); });
      await React.act(async () => {
        if (settlement === 'rejection') rejectOlder(new Error('Older inventory failed'));
        else resolveOlder(settlement === 'success'
          ? { ok: true, kind: 'plugins_list', plugins: [plugin] }
          : { ok: false, kind: 'plugins_list', diagnostics: [{ code: 'older_failure', message: 'Older inventory failed' }] });
      });
      await expect(fixture.getByText('com.acme.review-assistant · v2.0.0 · enabled')).resolves.toBeDefined();
      await expect(fixture.queryByText('Older inventory failed')).resolves.toBeUndefined();
      expect(document.querySelector('[data-testid="inspector-error"]')).toBeNull();
    } finally { resolveOlder({ ok: true, kind: 'plugins_list', plugins: [plugin] }); resolveNewer({ ok: true, kind: 'plugins_list', plugins: [plugin] }); await fixture.dispose(); }
  });

  it('ranks page search by label prefix, exact id, label substring, then byline and restores inventory order when cleared', async () => {
    const plugins = [
      { pluginId: 'com.acme.code-quality', title: 'Code review', enabled: true },
      { pluginId: 'com.acme.review-helper', title: 'Helper', enabled: true },
      { pluginId: 'review', title: 'Agent tools', enabled: true },
      { pluginId: 'com.acme.assistant', title: 'Review assistant', enabled: true },
      { pluginId: 'com.acme.terminal', title: 'Terminal helper', enabled: false },
      { pluginId: 'com.acme.board', title: 'Review board', enabled: true },
    ];
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'ranked-search', mountNonce: 'ranked-search' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture({
        mount: {
          kind: 'destination',
          destination: { pluginId: 'happier.inspector', localId: 'inspector-page' },
          container: 'appPage',
        },
        target: { kind: 'app' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      // The host Action boundary supplies inventory; Inspector and the public Collection stay real.
      handlers: { executeAction: async ({ action }: InspectorExecuteActionRequest) => (
        action === 'plugins.list' ? { plugins } : { ok: true }
      ) },
    });
    const rowNames = async () => (await fixture.queryAllByRole('button'))
      .map(row => row.name)
      .filter(name => name?.startsWith('Reload '));
    try {
      await fixture.findByRole('button', { name: 'Reload Review assistant' });
      const search = document.querySelector<HTMLInputElement>('[data-testid="inspector-plugin-search"]');
      expect(search).not.toBeNull();
      await React.act(async () => { enterText(search!, ' ReViEw '); });
      await vi.waitFor(async () => {
        expect(await rowNames()).toEqual([
          'Reload Agent tools',
          'Reload Review assistant',
          'Reload Review board',
          'Reload Code review',
          'Reload Helper',
        ]);
      });
      await React.act(async () => { enterText(search!, ''); });
      await vi.waitFor(async () => {
        expect(await rowNames()).toEqual(plugins.map(plugin => `Reload ${plugin.title}`));
      });
      await React.act(async () => { enterText(search!, 'no matching plugin'); });
      await vi.waitFor(async () => {
        await expect(fixture.getByText('No matching plugins')).resolves.toBeDefined();
      });
      expect(await rowNames()).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it('filters its rows through the page search and reloads only a row that is still shown', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action === 'plugins.list') {
        return {
          plugins: [{
            pluginId: 'com.acme.review-assistant',
            version: '1.2.3',
            title: 'Review Assistant',
            enabled: true,
          }, {
            pluginId: 'com.acme.terminal-helper',
            version: '2.0.0',
            title: 'Terminal Helper',
            enabled: false,
          }],
        };
      }
      if (action === 'plugins.reload') {
        return { ok: true, generation: 2, changedPluginIds: [], affectedPluginIds: [] };
      }
      return { ok: true };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-158', mountNonce: 'fixture-mount-158' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.findByRole('button', { name: 'Reload Review Assistant' })).resolves.toBeDefined();
      await expect(fixture.getByText('com.acme.review-assistant · v1.2.3 · enabled')).resolves.toEqual({
        content: 'com.acme.review-assistant · v1.2.3 · enabled',
      });
      await expect(fixture.getByText('com.acme.terminal-helper · v2.0.0 · disabled')).resolves.toEqual({
        content: 'com.acme.terminal-helper · v2.0.0 · disabled',
      });
      const search = document.querySelector<HTMLInputElement>('[data-testid="inspector-plugin-search"]');
      expect(search, 'the maintained Inspector surface must expose its public search control').not.toBeNull();
      await React.act(async () => { enterText(search!, 'disabled'); });

      await vi.waitFor(async () => {
        await expect(fixture.queryByRole('button', { name: 'Reload Review Assistant' })).resolves.toBeUndefined();
      });
      await fixture.press(await fixture.findByRole('button', { name: 'Reload Terminal Helper' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'plugins.reload',
          input: { pluginId: 'com.acme.terminal-helper' },
        }));
      });
    } finally {
      await fixture.dispose();
    }
  });
});
