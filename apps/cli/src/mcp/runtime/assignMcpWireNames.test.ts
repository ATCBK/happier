import { describe, expect, it } from 'vitest';
import { assignMcpWireNames } from './assignMcpWireNames';
describe('MCP session wire names', () => {
  it('preserves catalog names and deterministically suffixes collisions with plugin and native names', () => {
    const items = [
      { serverId: 'plugin:plugin/docs', name: 'docs', serverTitle: 'Plugin docs', plugin: { pluginId: 'plugin', localId: 'docs' } },
      { serverId: 'catalog', name: 'docs', serverTitle: 'Catalog docs' },
      { serverId: 'other', name: 'other', serverTitle: 'Other' },
    ];
    const result = assignMcpWireNames({ items, nativeServerNames: ['other'] });
    expect(result.wireNamesByServerId).toEqual({ catalog: 'docs', 'plugin:plugin/docs': 'docs_2', other: 'other_2' });
    expect(result.mcpServerIdentities.docs).toMatchObject({ serverId: 'catalog', serverTitle: 'Catalog docs' });
    expect(result.mcpServerIdentities.docs_2).toMatchObject({ serverId: 'plugin:plugin/docs', plugin: { pluginId: 'plugin', localId: 'docs' } });
    expect(assignMcpWireNames({ items: [...items].reverse(), nativeServerNames: ['other'] })).toEqual(result);
    expect(result.mcpServerIdentities).not.toHaveProperty('happier');
  });
});
