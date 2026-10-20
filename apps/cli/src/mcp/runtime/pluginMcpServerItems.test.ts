import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { McpServerCatalogEntryV1Schema, McpServersSettingsV1Schema, mcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { projectPluginMcpServerItems } from './pluginMcpServerItems';
import type { ResolvedMcpServerContribution } from '@/plugins/projection/registry/types';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

describe('declared plugin MCP items', () => {
  it('reads installed translated plugin names through the metadata catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-metadata-'));
    const happyHomeDir = join(root, 'home');
    const pluginRoot = join(root, 'plugin');
    const pluginId = 'acme.translated-mcp';
    try {
      await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
      await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
        id: pluginId, displayName: { key: 'plugin.name', fallback: 'Acme tools' },
        contributes: { mcp: { servers: [{ id: 'tools', title: 'Tools', kind: 'static',
          transport: { kind: 'http', url: 'https://example.test/mcp' } }] } },
      })));
      await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}');
      await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
      // The Home directory is the environment boundary; installed discovery and
      // the declaration/schema projection remain real.
      vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
      vi.resetModules();
      const { readPluginMcpServerMetadata } = await import('./pluginMcpServerItems');
      const metadata = await readPluginMcpServerMetadata();
      expect(metadata.find(item => item.id === `plugin:${pluginId}/tools`)?.source)
        .toEqual({ kind: 'plugin', pluginId, pluginName: 'Acme tools' });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps each transport and stored rules through the catalog consumer', async () => {
    const declaration = (id: string, definition: ResolvedMcpServerContribution['definition']): ResolvedMcpServerContribution => ({
      pluginId: 'acme.tools', provenance: 'external', source: { kind: 'path' }, definition: { ...definition, id },
    });
    const itemId = mcpPluginItemIdV1({ pluginId: 'acme.tools', localId: 'docs/nested' });
    const catalog = McpServersSettingsV1Schema.parse({ bindings: [{ id: 'off', serverId: itemId,
      target: { t: 'allMachines' }, enabled: false, createdAt: 1, updatedAt: 1 }] });
    const items = await projectPluginMcpServerItems({ catalog, activePlugins: [
      declaration('docs/nested', { id: 'docs/nested', kind: 'static', title: 'Docs', transport: { kind: 'http', url: 'https://example.test/mcp' } }),
      declaration('local', { id: 'local', kind: 'static', title: 'Local', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'echo' }, args: ['declared'] } }),
      declaration('live', { id: 'live', kind: 'dynamic', title: 'Live', sessionScope: 'session' }),
      declaration('happier', { id: 'happier', kind: 'dynamic', title: 'Reserved local name', sessionScope: 'global' }),
    ], resolveExecutable: async () => ({ command: '/tools/echo', args: ['owner'] }) });
    expect(items.map(item => McpServerCatalogEntryV1Schema.parse(item.config).id)).toEqual([
      itemId, 'plugin:acme.tools/local', 'plugin:acme.tools/live', 'plugin:acme.tools/happier',
    ]);
    expect(items[0]).toMatchObject({ itemId, name: 'docs_nested', title: 'Docs', rules: catalog.bindings });
    expect(items[1]?.config.stdio).toEqual({ command: '/tools/echo', args: ['owner', 'declared'] });
    expect(items[2]?.config.transport).toBe('http');
    expect(items[3]?.config.name).not.toBe('happier');
  });
});
