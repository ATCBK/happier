import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('Kilo agent definition', () => {
  it('advertises the MCP servers passed through its canonical ACP runtime', () => {
    expect(AGENT_DEFINITION.core.tools).toEqual({
      delivery: 'native_mcp',
      support: 'experimental',
      mcpToolControl: { off: 'blocked', approval: 'host' },
    });
  });

  it('does not retain a private catalog callback bag beside the public Agent declaration', () => {
    expect(AGENT_DEFINITION).not.toHaveProperty('runtimeContributions.agentCatalogEntry');
  });
});
