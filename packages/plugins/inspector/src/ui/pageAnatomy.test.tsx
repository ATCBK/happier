// @vitest-environment jsdom

import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkitExecuteActionInput,
} from '@happier-dev/plugin-sdk/testing';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';

import { renderSurface } from './renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Configuration-surfaces U9: on its full page the Inspector is the maintained
 * plugin consumer of the public page anatomy — `PageHeader` and titled
 * `ItemGroup` sections — while its pane placements keep their compact stack.
 */
function createContext(container: 'appPage' | 'rightSidebarTab') {
  return createSurfaceContextFixture({
    mount: {
      kind: 'destination',
      destination: { pluginId: 'happier.inspector', localId: container === 'appPage' ? 'inspector-page' : 'inspector-app' },
      container,
    },
    target: { kind: 'app' },
  });
}

async function mount(container: 'appPage' | 'rightSidebarTab') {
  const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => action === 'plugins.list'
    ? { plugins: [] }
    : { ok: true });
  return createPluginUiTestkit({
    identity: { instanceId: `fixture-${container}`, mountNonce: `mount-${container}` },
    authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
    surface: renderSurface,
    surfaceContext: createContext(container),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: { executeAction },
  });
}

describe('Inspector page anatomy', () => {
  it('defers automatic and manual inventory reads until requester admission and after withdrawal', async () => {
    const executeAction = vi.fn(async (): Promise<JsonValue> => ({ plugins: [] }));
    const context = { ...createContext('appPage'), requesterExecutionReady: false,
      machineConnectionPending: false, machineExecutionReady: true };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'requester-ready', mountNonce: 'requester-ready' },
      authorPlugin: { id: 'happier.inspector', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: context, adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { executeAction },
    });
    try {
      expect(executeAction).not.toHaveBeenCalled();
      expect((await fixture.getByRole('button', { name: 'Read via Action.Execute' })).state?.disabled).toBe(true);
      await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh with icon button' })); });
      expect(executeAction).not.toHaveBeenCalled();
      await act(async () => { await fixture.updateSurface({ ...context, requesterExecutionReady: true }); });
      await expect(fixture.getByText('No plugins installed.')).resolves.toBeDefined();
      expect(executeAction).toHaveBeenCalledTimes(1);
      const demo = await fixture.getByRole('button', { name: 'Read via Action.Execute' });
      expect(demo.state?.disabled).not.toBe(true);
      await act(async () => { await fixture.press(demo); });
      expect(executeAction).toHaveBeenCalledTimes(2);
      expect(executeAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'plugins.list' }));
      await act(async () => { await fixture.updateSurface(context); });
      expect((await fixture.getByRole('button', { name: 'Read via Action.Execute' })).state?.disabled).toBe(true);
      await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh with icon button' })); });
      expect(executeAction).toHaveBeenCalledTimes(2);
    } finally { await fixture.dispose(); }
  });
  it('opens its full page with the public page header and titled sections', async () => {
    const fixture = await mount('appPage');
    try {
      await expect(fixture.getByText('No plugins installed.')).resolves.toEqual({ content: 'No plugins installed.' });
      await expect(fixture.getByRole('heading', { name: 'Plugin Inspector' })).resolves.toMatchObject({ role: 'heading' });
      // At the page root the location says nothing the title does not; only a sub-page names itself.
      expect(document.querySelector('[data-testid="inspector-location"]')).toBeNull();
      await expect(fixture.getByRole('heading', { name: 'Surface health' })).resolves.toMatchObject({ role: 'heading' });
      await expect(fixture.getByRole('heading', { name: 'Plugin inventory' })).resolves.toMatchObject({ role: 'heading' });
      // The pane's compact heading stack is not drawn on the page.
      expect(document.querySelector('[data-testid="inspector-title"]')).toBeNull();
      expect(document.querySelector('[data-testid="inspector-self-check-action"]')).not.toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it('leaves naming to the host pane header in a pane placement', async () => {
    const fixture = await mount('rightSidebarTab');
    try {
      await expect(fixture.getByText('No plugins installed.')).resolves.toEqual({ content: 'No plugins installed.' });
      expect(document.querySelector('[data-testid="inspector-page-header"]')).toBeNull();
      // The host pane header already says "Plugin Inspector"; the pane opens on its purpose.
      expect(document.querySelector('[data-testid="inspector-title"]')).toBeNull();
      expect(document.querySelector('[data-testid="inspector-pane-description"]')).not.toBeNull();
    } finally {
      await fixture.dispose();
    }
  });
});
