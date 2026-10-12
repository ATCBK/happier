import { describe, expect, it } from 'vitest';
import { SpawnDaemonSessionRequestSchema } from './spawnSessionOptionsContract';

describe('spawn capability selection transport', () => {
  it('accepts the predecessor MCP carrier and emits only the canonical selection', () => {
    const mcpSelection = { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['docs'], forceExcludeServerIds: ['linear'] };
    const request = SpawnDaemonSessionRequestSchema.parse({ directory: '/workspace', mcpSelection });
    expect(request).toMatchObject({ capabilitySelection: { mcp: mcpSelection } });
    expect(request).not.toHaveProperty('mcpSelection');
  });

  it('retains skill and MCP selections at the daemon boundary', () => {
    const capabilitySelection = {
      mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['linear'] },
      skills: { v: 1, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: ['review'], excludeNativeSkillNames: [] },
    };
    expect(SpawnDaemonSessionRequestSchema.parse({ directory: '/workspace', capabilitySelection }))
      .toMatchObject({ capabilitySelection });
  });

  it('rejects malformed canonical or predecessor selections instead of losing the request', () => {
    for (const selection of [{ capabilitySelection: { skills: { v: 2 } } }, { mcpSelection: { v: 2 } }]) {
      expect(SpawnDaemonSessionRequestSchema.safeParse({ directory: '/workspace', ...selection }).success).toBe(false);
    }
  });
});
