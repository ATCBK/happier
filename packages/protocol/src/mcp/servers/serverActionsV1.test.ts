import { describe, expect, it } from 'vitest';
import { MCP_SERVER_ACTION_SPECS_V1 } from '../../actions/specs/mcpServers.js';
import { MCP_SERVER_ACTION_IDS_V1 } from './serverActionIdsV1.js';
import { createMcpServerActionExecuteV1, MCP_SERVER_ACTION_INPUT_SCHEMAS_V1,
  MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from './serverActionsV1.js';
import { applyMcpServerCatalogMutationV1, commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from './serverCatalogV1.js';
import type { McpServerCatalogV1 } from './serverRowsV1.js';
import { reachRulesToDraftsV1 } from '../../reach/reachRulesChangeV1.js';

describe('canonical MCP Action owner', () => {
  it('changes named server rules in one catalog CAS and returns the committed value and Undo input', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'linear', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'old-rule', serverId: 'server', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
    let revision = 9;
    const originalRules = catalog.bindings.map(({ serverId: _serverId, ...rule }) => rule);
    const execute = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
        ctx: { nowMs: 2, newId: () => 'new-rule' },
        writeCatalog: async candidate => {
          if (candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
          catalog = candidate.catalog;
          return { status: 'updated', revision: ++revision, cursor: revision };
        } }),
      machine: async () => { throw new Error('Rules are Account-owned'); },
    });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    const result = await execute({ actionId: 'mcp.rules.set', input: {
      items: [{ name: 'linear' }], change: { kind: 'write', write: { place: { t: 'machine', machineId: 'machine' }, state: 'off' } },
    }, context });
    const currentRules = catalog.bindings.map(({ serverId: _serverId, ...rule }) => rule);
    expect(result).toEqual({ ok: true, result: { ok: true, revision: 10,
      items: [{ serverId: 'server', rules: currentRules, previous: originalRules }] } });
    expect(currentRules).toEqual([...originalRules, { id: 'new-rule', target: { t: 'machine', machineId: 'machine' },
      enabled: false, createdAt: 2, updatedAt: 2 }]);
    const undo = await execute({ actionId: 'mcp.rules.set', input: {
      items: [{ serverId: 'server' }], change: { kind: 'replace', rules: reachRulesToDraftsV1(originalRules) },
    }, context });
    expect(undo).toMatchObject({ ok: true, result: { ok: true, revision: 11, items: [{ rules: originalRules }] } });
    const beforeMissing = catalog;
    expect(await execute({ actionId: 'mcp.rules.set', input: {
      items: [{ name: 'missing' }], change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } },
    }, context })).toEqual({ ok: true, result: { ok: false, code: 'not_found' } });
    expect(catalog).toBe(beforeMissing);
  });
  it('declares the complete closed family and requires explicit destructive cleanup input', () => {
    expect(new Set(MCP_SERVER_ACTION_SPECS_V1.map(spec => spec.id))).toEqual(new Set(MCP_SERVER_ACTION_IDS_V1));
    expect(new Set(Object.keys(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1))).toEqual(new Set(MCP_SERVER_ACTION_IDS_V1));
    expect(new Set(Object.keys(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1))).toEqual(new Set(MCP_SERVER_ACTION_IDS_V1));
    const deletion = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.delete'];
    expect(deletion.safeParse({ expectedRevision: 9, serverId: 'server' }).success).toBe(false);
    expect(deletion.safeParse({ expectedRevision: 9, serverId: 'server', removeBindings: true, shell: 'unsafe' }).success).toBe(false);
    expect(deletion.safeParse({ expectedRevision: 9, serverId: 'server', removeBindings: true }).success).toBe(true);
    const draftTest = { t: 'draft', machineId: 'machine', directory: '/repo', server: {
      id: 'server', name: 'server', transport: 'http', remote: { url: 'https://example.test/mcp', headers: {} },
      env: {}, createdAt: 1, updatedAt: 1 }, binding: { id: 'rule', serverId: 'server', enabled: true,
      target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 } };
    expect(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.test'].safeParse(draftTest).success).toBe(true);
    expect(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.test'].safeParse({ ...draftTest,
      binding: { ...draftTest.binding, overrides: { envPatch: { TOKEN: null } } } }).success).toBe(false);
    const byIdTest = { t: 'byId', machineId: 'machine', directory: '/repo', serverId: 'server' };
    expect(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.test'].safeParse(byIdTest).success).toBe(true);
    expect(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.test'].safeParse({ ...byIdTest,
      unownedLaunch: 'unsafe' }).success).toBe(false);
    for (const id of ['mcp.servers.create', 'mcp.servers.delete', 'mcp.servers.test'] as const) {
      expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === id)?.safety).toBe('danger');
    }
    expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === 'mcp.servers.test')?.executionPlacement).toBe('machine');
    expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === 'mcp.servers.list')?.executionPlacement).toBe('account');
  });

  it('refuses unsupported plugin items atomically even when their reserved rules are readable', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'linear', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'reserved-rule', serverId: 'plugin:unknown/item', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
    const original = catalog;
    let revision = 9;
    // Only row persistence is replaced; the loader, Action, reducer and CAS
    // stay real so a syntactic plugin id cannot acknowledge dormant reach.
    const execute = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
        ctx: { nowMs: 2, newId: () => 'new-rule' },
        writeCatalog: async candidate => {
          if (candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
          catalog = candidate.catalog;
          return { status: 'updated', revision: ++revision, cursor: revision };
        } }),
      machine: async () => { throw new Error('Rules are Account-owned'); },
    });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(await execute({ actionId: 'mcp.rules.set', input: {
      items: [{ serverId: 'server' }, { serverId: 'plugin:unknown/item' }],
      change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } },
    }, context })).toEqual({ ok: true, result: { ok: false, code: 'not_found' } });
    expect(catalog).toBe(original);
    expect(revision).toBe(9);
  });

  it('keeps list configuration private and removes referenced bindings only on explicit cleanup', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'server', transport: 'http',
      remote: { url: 'https://example.test/private-path', headers: { Authorization: { t: 'literal', v: 'private-header' } } },
      env: { TOKEN: { t: 'literal', v: 'private-token' } }, createdAt: 1, updatedAt: 2 }],
      bindings: [{ id: 'binding', serverId: 'server', enabled: true, target: { t: 'allMachines' },
        createdAt: 1, updatedAt: 2 }] };
    const original = catalog;
    let revision = 9;
    // The row persistence boundary is in-memory. The real catalog loader,
    // semantic reducer and public MCP Action executor remain beneath it.
    const execute = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: async (change, expectedRevision) => {
        expect(expectedRevision).toBe(revision);
        catalog = applyMcpServerCatalogMutationV1(catalog, change);
        return { status: 'updated', revision: ++revision, cursor: revision };
      },
      machine: async () => { throw new Error('Catalog operations cannot execute on a Machine'); },
    });
    const context = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(await execute({ actionId: 'mcp.servers.list', input: {}, context })).toEqual({ ok: true, result: {
      status: 'ready', revision: 9, authority: 'active', diagnostics: [], catalog: { v: 1,
        servers: [{ id: 'server', name: 'server', transport: 'http', createdAt: 1, updatedAt: 2 }],
        bindings: [{ id: 'binding', serverId: 'server', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 2 }] },
    } });
    expect(await execute({ actionId: 'mcp.servers.read', input: { serverId: 'server' }, context })).toMatchObject({
      ok: true, result: { status: 'present', server: original.servers[0], bindings: original.bindings, revision: 9 },
    });
    await expect(execute({ actionId: 'mcp.servers.delete', input: {
      expectedRevision: 9, serverId: 'server', removeBindings: false }, context })).rejects.toThrow();
    expect(catalog).toEqual(original);
    expect(revision).toBe(9);
    expect(await execute({ actionId: 'mcp.servers.delete', input: {
      expectedRevision: 9, serverId: 'server', removeBindings: true }, context })).toEqual({
      ok: true, result: { status: 'updated', revision: 10, cursor: 10 },
    });
    expect(catalog).toEqual({ v: 1, servers: [], bindings: [] });
  });

  it('creates imported definitions and default rules in one row CAS and refuses a batch atomically', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
    let revision = 9;
    const entries = [
      { entry: { id: 'alpha', name: 'alpha', transport: 'stdio', stdio: { command: 'echo', args: [] },
        env: { TOKEN: { t: 'literal', v: 'private-batch-token' } }, createdAt: 1, updatedAt: 1 } },
      { entry: { id: 'beta', name: 'beta', transport: 'http', remote: { url: 'https://example.test/mcp', headers: {} },
        env: {}, createdAt: 1, updatedAt: 1 } },
    ] satisfies { entry: McpServerCatalogV1['servers'][number] }[];
    const ruleIds = ['alpha-binding', 'beta-binding'];
    // Only the durable row boundary is replaced. Batch admission, reduction,
    // validation, commit sequencing and Action projection remain canonical.
    const execute = createMcpServerActionExecuteV1({
      ruleWriteContext: () => ({ nowMs: 1, newId: () => ruleIds.shift() ?? 'other-binding' }),
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: async (change, expectedRevision) => {
        if (expectedRevision !== revision) return { status: 'conflict', revision };
        return commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
          writeCatalog: async candidate => {
            if (candidate.expectedRevision !== revision) return { status: 'conflict', revision };
            catalog = candidate.catalog;
            return { status: 'updated', revision: ++revision, cursor: revision };
          } });
      },
      machine: async () => { throw new Error('Import cannot execute on a Machine'); },
    });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(await execute({ actionId: 'mcp.servers.create', input: { expectedRevision: 9, entries }, context }))
      .toEqual({ ok: true, result: { status: 'updated', revision: 10, cursor: 10 } });
    expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === 'mcp.servers.create')?.projectObservationInput?.({
      expectedRevision: 9, entries,
    })).toEqual({ expectedRevision: 9, serverIds: ['alpha', 'beta'] });
    const committed = { v: 1, servers: entries.map(item => item.entry), bindings: entries.map(item => ({
      id: `${item.entry.id}-binding`, serverId: item.entry.id, enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1,
    })) };
    expect(catalog).toEqual(committed);
    expect(await execute({ actionId: 'mcp.servers.list', input: {}, context })).toMatchObject({
      ok: true, result: { status: 'ready', authority: 'active', revision: 10,
        catalog: { servers: [{ id: 'alpha' }, { id: 'beta' }], bindings: [{ id: 'alpha-binding' }, { id: 'beta-binding' }] } },
    });
    const first = entries[0]!;
    expect(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.create'].safeParse({ expectedRevision: 10,
      entries, entry: first.entry }).success).toBe(false);
    await expect(execute({ actionId: 'mcp.servers.create', input: { expectedRevision: 10, entries: [
      { entry: { ...first.entry, id: 'next', name: 'next' } },
      first,
    ] }, context })).rejects.toMatchObject({ code: 'invalid-mutation' });
    expect(catalog).toEqual(committed);
    expect(revision).toBe(10);
  });
});
