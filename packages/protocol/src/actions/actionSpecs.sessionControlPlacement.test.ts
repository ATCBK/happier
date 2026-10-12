import { describe, expect, it } from 'vitest';

// Source transformation belongs to collection, not the operation's test deadline.
let catalog: typeof import('./actionSpecs.js') | undefined;
let initializationError: unknown;
try {
  catalog = await import('./actionSpecs.js');
} catch (error) {
  initializationError = error;
}

describe('Session control catalog initialization', () => {
  it('resolves the existing MCP and connected-account Session transports without widening their surfaces', async () => {
    expect(initializationError).toBeUndefined();
    if (!catalog) throw new Error('The Action catalog did not initialize');
    for (const id of ['session.mcp_selection.set', 'session.connected_services_auth.set'] as const) {
      const spec = catalog.getActionSpec(id);
      expect(spec.executionPlacement).toBe('session');
      expect(spec.surfaces).toMatchObject({ ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false });
    }
  });
});
