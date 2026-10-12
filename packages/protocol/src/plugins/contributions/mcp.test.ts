import { describe, expect, it } from 'vitest';

import { PluginMcpDiscoverySourceContributionV1Schema } from './mcp.js';

describe('MCP discovery source session truth', () => {
  it('requires the source to declare whether its detected servers load in Happier sessions', () => {
    const source = { id: 'config', title: 'Native MCP configuration' };
    expect(PluginMcpDiscoverySourceContributionV1Schema.safeParse(source).success).toBe(false);
    for (const loadedInHappierSessions of [false, true]) {
      expect(PluginMcpDiscoverySourceContributionV1Schema.parse({ ...source, loadedInHappierSessions }))
        .toMatchObject({ loadedInHappierSessions });
    }
  });
});
