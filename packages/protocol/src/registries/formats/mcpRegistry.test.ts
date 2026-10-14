import { describe, expect, it } from 'vitest';
import { createRegistryHostV1, detectRegistrySourceV1 } from '../registryHostV1.js';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '../registrySourcesV1.js';
import { RegistryItemV1Schema, RegistryProvenanceV1Schema } from '../registryItemsV1.js';
import { checkRegistryUpstreamV1 } from '../registryUpdatesV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';
import { MCP_REGISTRY_V01_PAGE_FIXTURE, MCP_REGISTRY_V01_READ_FIXTURE } from './fixtures/mcpRegistryV01Fixture.js';
import { MCP_REGISTRY_V01_PACKAGE_FIXTURE } from './fixtures/mcpRegistryV01Fixture.js';
import { mapMcpRegistryServerV1 } from '../../mcp/servers/registry/mapMcpRegistryServerV1.js';
import { McpServerCatalogEntryV1Schema } from '../../mcp/servers/settingsV1.js';

function hostFor(page: unknown = MCP_REGISTRY_V01_PAGE_FIXTURE, read: unknown = MCP_REGISTRY_V01_READ_FIXTURE) {
  const urls: URL[] = [];
  const unused = async (): Promise<never> => { throw new Error('Unexpected transport'); };
  const http: RegistryHttpV1 = { getJson: async raw => { const url = new URL(raw); urls.push(url);
    return { ok: true, value: url.pathname.endsWith('/servers') ? page : read, fetchedAt: 10 }; }, getText: unused, getBytes: unused };
  return { host: createRegistryHostV1({ host: 'web', http, readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 }), http, urls };
}
describe('registered MCP Registry reader', () => {
  it('marks a deleted registry record removed upstream and refuses its pinned install read', async () => {
    const deleted = { ...MCP_REGISTRY_V01_READ_FIXTURE,
      _meta: { 'io.modelcontextprotocol.registry/official': {
        ...MCP_REGISTRY_V01_READ_FIXTURE._meta['io.modelcontextprotocol.registry/official'], status: 'deleted',
      } } };
    const { host, http } = hostFor({ servers: [deleted], metadata: { count: 1 } }, deleted);
    const source = BUILT_IN_REGISTRY_SOURCES_V1.find(source => source.id === 'builtin:mcp-registry')!;
    const provenance = RegistryProvenanceV1Schema.parse({ sourceId: source.id, format: source.format, sourceUrl: source.url,
      itemId: deleted.server.name, ref: { kind: 'version', version: deleted.server.version }, importedAt: 1 });
    expect((await checkRegistryUpstreamV1({ http }, { sources: [source], items: [{ key: 'installed', provenance }] })).get('installed'))
      .toEqual({ state: 'removed_from_source' });
    expect(await host.execute('registries.items.list', { kind: 'mcpServer' })).toMatchObject({ pages: [{
      items: [{ itemId: deleted.server.name, problem: { code: 'removed_from_source' } }],
    }] });
    expect(await host.fetchRequest({ op: 'read', kind: 'mcpServer', sourceId: source.id,
      itemId: deleted.server.name, version: deleted.server.version })).toMatchObject({ op: 'error', status: { state: 'invalid_source' } });
  });

  it('reads captured v0.1 pages and pinned records directly through strict Action consumers', async () => {
    const { host, urls } = hostFor();
    const listed = await host.execute('registries.items.list', { kind: 'mcpServer', query: 'playwright' });
    expect(listed).toMatchObject({ pages: [{ sourceId: 'builtin:mcp-registry', items: [
      { itemId: MCP_REGISTRY_V01_PAGE_FIXTURE.servers[0].server.name },
      { itemId: 'com.playwrightgen/playwrightgen', version: '1.0.0', publisher: { verification: 'registry-checked' } },
    ], nextCursor: MCP_REGISTRY_V01_PAGE_FIXTURE.metadata.nextCursor }] });
    const result = await host.execute('registries.items.read', { kind: 'mcpServer', sourceId: 'builtin:mcp-registry',
      itemId: 'com.playwrightgen/playwrightgen', version: '1.0.0' });
    expect(result).toHaveProperty('item');
    const item = RegistryItemV1Schema.parse((result as { item: unknown }).item);
    expect(item).toMatchObject({ summary: { version: '1.0.0' }, payload: { kind: 'mcpServer', server: {
      packages: [], remotes: [{ inputs: [{ name: 'Authorization', target: 'header', secret: true, required: true }] }],
    } } });
    const browse = urls.find(url => url.searchParams.has('search'));
    expect(browse?.searchParams.get('search')).toBe('playwright');
    expect(Number(browse?.searchParams.get('limit'))).toBeLessThanOrEqual(100);
    expect(urls.at(-1)?.pathname).toContain('/versions/1.0.0');
  });
  it('detects base/v0.1 subregistries and keeps unsupported/deprecated rows visible', async () => {
    const { http } = hostFor();
    expect(await detectRegistrySourceV1({ http }, 'https://registry.modelcontextprotocol.io/v0.1')).toMatchObject({
      format: 'mcp-registry', kinds: ['mcpServer'],
    });
    const empty = { ...MCP_REGISTRY_V01_READ_FIXTURE, server: { ...MCP_REGISTRY_V01_READ_FIXTURE.server, remotes: [] },
      _meta: { 'io.modelcontextprotocol.registry/official': { ...MCP_REGISTRY_V01_READ_FIXTURE._meta['io.modelcontextprotocol.registry/official'], status: 'deprecated' } } };
    expect(await hostFor({ servers: [empty], metadata: { count: 1 } }).host.execute('registries.items.list', { kind: 'mcpServer' }))
      .toMatchObject({ pages: [{ items: [{ flags: { deprecated: true }, problem: { code: 'unsupported_entry' } }] }] });
  });
  it('lists the rest of a live page when one record names its repository without a URL', async () => {
    const odd = { ...MCP_REGISTRY_V01_READ_FIXTURE, server: { ...MCP_REGISTRY_V01_READ_FIXTURE.server, repository: { source: 'github' } } };
    const page = { servers: [odd, ...MCP_REGISTRY_V01_PAGE_FIXTURE.servers], metadata: { count: 3 } };
    const listed = await hostFor(page).host.execute('registries.items.list', { kind: 'mcpServer' });
    expect(listed).toMatchObject({ pages: [{ status: { state: 'ok' } }] });
    expect((listed as { pages: { items: unknown[] }[] }).pages[0]!.items).toHaveLength(3);
  });
  it('refuses a version/identity mismatch instead of creating the latest or another server', async () => {
    const { host } = hostFor();
    expect(await host.fetchRequest({ op: 'read', kind: 'mcpServer', sourceId: 'builtin:mcp-registry',
      itemId: 'com.playwrightgen/playwrightgen', version: '0.9.0' })).toMatchObject({ op: 'error', status: { state: 'invalid_source' } });
  });
  it('maps exact npm and pypi distributions using the same reader and preserves secret refs in URL templates', async () => {
    const pointer = { kind: 'mcpServer' as const, sourceId: 'builtin:mcp-registry', itemId: 'com.playwrightgen/playwrightgen', version: '1.0.0' };
    const map = async (raw: unknown, inputs: Parameters<typeof mapMcpRegistryServerV1>[0]['inputs']) => {
      const result = await hostFor(undefined, raw).host.execute('registries.items.read', pointer);
      const item = RegistryItemV1Schema.parse((result as { item: unknown }).item);
      if (item.payload.kind !== 'mcpServer') throw new Error('Wrong payload');
      return mapMcpRegistryServerV1({ server: item.payload.server, id: 'mapped', name: 'mapped', nowMs: 12, inputs });
    };
    const npm = await map(MCP_REGISTRY_V01_PACKAGE_FIXTURE, { API_KEY: { t: 'savedSecret', secretId: 'canonical-ref' } });
    expect(npm).toMatchObject({ ok: true, entry: { stdio: { command: 'npx', args: ['-y', '@example/mcp-server@2.3.4', '--mode', 'read'] },
      env: { API_KEY: { t: 'savedSecret' }, REGION: { t: 'literal', v: 'eu' } } } });
    const pypi = { ...MCP_REGISTRY_V01_PACKAGE_FIXTURE, server: { ...MCP_REGISTRY_V01_PACKAGE_FIXTURE.server, packages: [{
      ...MCP_REGISTRY_V01_PACKAGE_FIXTURE.server.packages[0], registryType: 'pypi', identifier: 'example-mcp', version: '2.3.4',
    }] } };
    expect(await map(pypi, { API_KEY: { t: 'literal', v: '${API_KEY}' } })).toMatchObject({ ok: true, entry: {
      stdio: { command: 'uvx', args: ['example-mcp==2.3.4', '--mode', 'read'] } } });
    const url = { ...MCP_REGISTRY_V01_READ_FIXTURE, server: { ...MCP_REGISTRY_V01_READ_FIXTURE.server, remotes: [{
      type: 'streamable-http', url: 'https://mcp.example.test/{tenant}?token={api_key}',
      variables: { tenant: { isRequired: true }, api_key: { isRequired: true, isSecret: true } },
    }] } };
    const mapped = await map(url, { tenant: { t: 'literal', v: 'acme' }, api_key: { t: 'savedSecret', secretId: 'canonical-ref' } });
    expect(mapped).toMatchObject({ ok: true, entry: { remote: { urlTemplate: { t: 'template', vars: { api_key: { t: 'savedSecret' } } } } } });
    if (mapped.ok) expect(McpServerCatalogEntryV1Schema.parse(mapped.entry).remote?.url).not.toContain('token');
  });
});
