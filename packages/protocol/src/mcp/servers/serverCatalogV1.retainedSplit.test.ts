import { describe, expect, it } from 'vitest';
import { readRetainedMcpServerCatalogSourceV1, applyMcpServerCatalogMutationV1 } from './serverCatalogV1.js';
import { resolveMcpServerConfigForContextV1 } from './resolveMcpServerConfigForContextV1.js';
import { resolveSessionCapabilitiesV1 } from '../../reach/resolveSessionCapabilitiesV1.js';

// Provenance: ../0.2 cd2bb4d853a259ae00ebc3e5981224e3e4bb5380,
// resolveServerBindingV1:119–151,169–214 applies only the winning binding to the original base.
const entry = { id: 's', name: 'server', transport: 'http' as const, remote: { url: 'https://original.test/mcp', headers: { Authorization: { t: 'literal' as const, v: 'original' } } }, env: { REGION: { t: 'literal' as const, v: 'original' } }, createdAt: 1, updatedAt: 1 };
const all = { id: 'all', serverId: 's', target: { t: 'allMachines' as const }, enabled: true, createdAt: 1, updatedAt: 1, overrides: { remote: { url: 'https://everywhere.test/mcp', headersPatch: { Authorization: { t: 'literal' as const, v: 'everywhere' }, Added: { t: 'literal' as const, v: 'new' } } }, envPatch: { REGION: { t: 'literal' as const, v: 'everywhere' }, NEW: { t: 'literal' as const, v: 'new' } } } };

describe('MCP retained binding split', () => {
  it('folds Everywhere and compensates narrower bindings even when they had no overrides', () => {
    const opened = readRetainedMcpServerCatalogSourceV1({ mcpServersSettingsV1: { v: 1, servers: [entry], bindings: [all, { id: 'machine', serverId: 's', target: { t: 'machine', machineId: 'm' }, enabled: true, createdAt: 1, updatedAt: 1 }] } });
    expect(opened.status).toBe('opened');
    if (opened.status !== 'opened') throw new Error('Expected retained source');
    expect(opened.catalog.servers[0]?.remote?.url).toBe('https://everywhere.test/mcp');
    expect(opened.catalog.servers[0]).toMatchObject({ configOverrides: [{ target: { t: 'machine', machineId: 'm' }, remote: { url: entry.remote.url, headersPatch: { Authorization: entry.remote.headers.Authorization, Added: null } }, envPatch: { REGION: entry.env.REGION, NEW: null } }] });
    expect(opened.catalog.bindings[0]).not.toHaveProperty('overrides');
    expect(resolveMcpServerConfigForContextV1(opened.catalog.servers[0]!, { machineId: 'm', directory: '/repo', machinePlatform: 'posix', projectKey: null, agentId: null })).toEqual(entry);
    expect(resolveMcpServerConfigForContextV1(opened.catalog.servers[0]!, { machineId: 'other', directory: '/repo', machinePlatform: 'posix', projectKey: null, agentId: null }))
      .toMatchObject({ remote: { url: 'https://everywhere.test/mcp', headers: { Added: { t: 'literal', v: 'new' } } }, env: { NEW: { t: 'literal', v: 'new' } } });
  });
  it('retains partial narrower overrides while restoring the folded URL', () => {
    const opened = readRetainedMcpServerCatalogSourceV1({ mcpServersSettingsV1: { v: 1, servers: [entry], bindings: [all, { id: 'machine', serverId: 's', target: { t: 'machine', machineId: 'm' }, enabled: true, createdAt: 1, updatedAt: 1, overrides: { envPatch: { REGION: { t: 'literal', v: 'machine' } } } }] } });
    if (opened.status !== 'opened') throw new Error('Expected retained source');
    expect(opened.catalog.servers[0]).toMatchObject({ configOverrides: [{ remote: { url: entry.remote.url }, envPatch: { REGION: { t: 'literal', v: 'machine' }, NEW: null } }] });
    expect(resolveMcpServerConfigForContextV1(opened.catalog.servers[0]!, { machineId: 'm', directory: '/repo', machinePlatform: 'posix', projectKey: null, agentId: null }))
      .toEqual({ ...entry, env: { REGION: { t: 'literal', v: 'machine' } } });
  });
  it('folds an Everywhere-only configuration without another override row', () => {
    const opened = readRetainedMcpServerCatalogSourceV1({ mcpServersSettingsV1: { v: 1, servers: [entry], bindings: [all] } });
    if (opened.status !== 'opened') throw new Error('Expected retained source');
    expect(opened.catalog.servers[0]?.remote?.url).toBe('https://everywhere.test/mcp');
    expect(opened.catalog.servers[0]).not.toHaveProperty('configOverrides');
  });
  it('rejects configuration updates that attempt to replace reach rules', () => {
    const { overrides: _overrides, ...rule } = all;
    const catalog = { v: 1 as const, servers: [entry], bindings: [rule] };
    // @ts-expect-error Retired mutation input must also be rejected at the runtime boundary.
    expect(() => applyMcpServerCatalogMutationV1(catalog, { kind: 'server-update', entry, bindings: [] })).toThrow();
    expect(applyMcpServerCatalogMutationV1(catalog, { kind: 'server-update', entry: { ...entry, title: 'Changed' } }).bindings).toEqual(catalog.bindings);
  });
  it('keeps a narrower empty configuration row from inheriting a machine override', () => {
    const opened = readRetainedMcpServerCatalogSourceV1({ mcpServersSettingsV1: { v: 1, servers: [entry], bindings: [
      { ...all, overrides: {} },
      { id: 'machine', serverId: 's', target: { t: 'machine', machineId: 'm' }, enabled: true, createdAt: 1, updatedAt: 1, overrides: { remote: { url: 'https://machine.test/mcp' } } },
      { id: 'folder', serverId: 's', target: { t: 'workspace', machineId: 'm', workspaceRoot: '/repo' }, enabled: true, createdAt: 1, updatedAt: 1 },
    ] } });
    if (opened.status !== 'opened') throw new Error('Expected retained source');
    expect(resolveMcpServerConfigForContextV1(opened.catalog.servers[0]!, { machineId: 'm', directory: '/repo/child', machinePlatform: 'posix', projectKey: null, agentId: null })).toEqual(entry);
  });
  it('compensates executable command and arguments and keeps configuration separate from reach', () => {
    const stdio = { id: 's', name: 'server', transport: 'stdio', stdio: { command: 'original', args: ['original'] }, env: {}, createdAt: 1, updatedAt: 1 };
    const opened = readRetainedMcpServerCatalogSourceV1({ mcpServersSettingsV1: { v: 1, servers: [stdio], bindings: [
      { ...all, enabled: false, overrides: { stdio: { command: 'everywhere', args: ['everywhere'] } } },
      { id: 'machine', serverId: 's', target: { t: 'machine', machineId: 'm' }, enabled: false, createdAt: 1, updatedAt: 1, overrides: { stdio: { args: ['machine'] } } },
    ] } });
    if (opened.status !== 'opened') throw new Error('Expected retained source');
    const context = { machineId: 'm', directory: '/repo', machinePlatform: 'posix' as const, projectKey: null, agentId: null };
    const resolved = resolveSessionCapabilitiesV1({ context, mcp: { ...opened.catalog, strictMode: false }, skills: null, selection: {}, agentAcceptsUserMcp: true });
    expect(resolved.mcp.items[0]).toMatchObject({ selected: false, reason: 'rule_off', effectiveConfig: { stdio: { command: 'original', args: ['machine'] } } });
  });
});
