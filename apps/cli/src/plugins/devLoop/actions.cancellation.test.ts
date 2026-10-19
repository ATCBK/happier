import { beforeEach, describe, expect, it, vi } from 'vitest';

const catalog = vi.hoisted(() => ({
  readEntry: vi.fn(),
}));

vi.mock('@/plugins/projection/catalog/installed', () => ({
  installPluginFromLocator: vi.fn(),
  readInstalledPluginCatalog: vi.fn(),
  readInstalledPluginCatalogEntry: catalog.readEntry,
}));

import { executePluginDevLoopAction } from './actions';

describe('executePluginDevLoopAction cancellation', () => {
  beforeEach(() => {
    catalog.readEntry.mockReset();
  });

  it('forwards the canonical Action cancellation signal into daemon reload control', async () => {
    const controller = new AbortController();
    catalog.readEntry.mockResolvedValue({
      source: { kind: 'path', locator: '/plugins/acme.author' },
    });
    const controlPluginDevelopment = vi.fn(async () => ({
      kind: 'status' as const,
      status: { roots: [], plugins: [] },
    }));

    await expect(executePluginDevLoopAction({
      actionId: 'plugins.reload',
      input: { pluginId: 'acme.author' },
      context: { signal: controller.signal },
    }, { controlPluginDevelopment })).resolves.toMatchObject({
      ok: true,
      kind: 'plugins_reload',
    });

    expect(controlPluginDevelopment).toHaveBeenCalledWith({
      kind: 'reload',
      rootPath: '/plugins/acme.author',
    }, { signal: controller.signal });
  });

  it('registers an explicit development root through daemon control', async () => {
    const controlPluginDevelopment = vi.fn(async () => ({
      kind: 'status' as const,
      status: { roots: [], plugins: [] },
    }));

    await expect(executePluginDevLoopAction({
      actionId: 'plugins.dev.submit',
      input: {
        projectRoot: '/plugins/acme.author',
        sdkRegistryOrigin: 'https://registry.example.test',
      },
    }, { controlPluginDevelopment })).resolves.toMatchObject({
      ok: true,
      kind: 'plugins_dev_submit',
    });

    expect(controlPluginDevelopment).toHaveBeenCalledWith({
      kind: 'registerExplicit',
      rootPath: '/plugins/acme.author',
      sdkRegistryOrigin: 'https://registry.example.test',
    }, {});
  });
});
