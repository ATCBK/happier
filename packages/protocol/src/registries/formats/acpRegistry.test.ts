import { describe, expect, it } from 'vitest';
import { createRegistryHostV1, detectRegistrySourceV1 } from '../registryHostV1.js';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '../registrySourcesV1.js';
import { RegistryItemV1Schema } from '../registryItemsV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';
import { ACP_REGISTRY_V1_FIXTURE } from './fixtures/acpRegistryV1Fixture.js';
import { acpRegistryAdapterV1 } from './acpRegistry.js';

const sourceUrl = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
function context(value: unknown = ACP_REGISTRY_V1_FIXTURE) {
  const unused = async (): Promise<never> => { throw new Error('Unexpected transport'); };
  const http: RegistryHttpV1 = { getJson: async () => ({ ok: true, value, fetchedAt: 10 }), getText: unused, getBytes: unused };
  const host = createRegistryHostV1({ host: 'web', http, readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 });
  return { host, http };
}
describe('ACP Registry through the registered host reader', () => {
  it('lists, detects and reads pinned live records through strict consumer schemas', async () => {
    const { host, http } = context();
    expect(await detectRegistrySourceV1({ http }, sourceUrl)).toMatchObject({ format: 'acp-registry', kinds: ['agent'], itemCount: 4 });
    expect(await host.execute('registries.items.list', { kind: 'agent', query: 'goose' })).toMatchObject({ pages: [{ status: { state: 'ok' }, items: [{ itemId: 'goose' }] }] });
    const response = await host.fetchRequest({ op: 'read', kind: 'agent', sourceId: 'builtin:acp-registry', itemId: 'goose', version: '1.54.0' });
    expect(response.op).toBe('read');
    if (response.op !== 'read') throw new Error('Missing read');
    expect(RegistryItemV1Schema.parse(response.item)).toMatchObject({ summary: { version: '1.54.0' }, payload: { kind: 'agent', agent: { distributions: { binary: {
      'linux-x64': { command: './goose', args: ['acp'], sha256: 'bf01cb6359f7a2b1acb54ca4827e1d059b18aabb3d2b75202e21066cfd3a3396' },
    } } } } });
    const read = (itemId: string, version?: string) => host.fetchRequest({ op: 'read', kind: 'agent', sourceId: 'builtin:acp-registry', itemId, ...(version ? { version } : {}) });
    expect(await read('claude-acp')).toMatchObject({ op: 'read', item: { payload: { agent: { distributions: { npm: { package: '@agentclientprotocol/claude-agent-acp', version: '0.89.1' } } } } } });
    expect(await read('fast-agent')).toMatchObject({ op: 'read', item: { payload: { agent: { distributions: { uv: { package: 'fast-agent-acp', version: '0.10.1', env: { FAST_AGENT_MODEL: 'codexplan' } } } } } } });
    expect(await read('goose', '1.53.0')).toMatchObject({ op: 'error', status: { state: 'invalid_source' } });
  });
  it('reports new envelope versions and keeps malformed entries visible without admitting executable declarations', async () => {
    expect(await context({ ...ACP_REGISTRY_V1_FIXTURE, version: '2.0.0' }).host.execute('registries.items.list', { kind: 'agent' })).toMatchObject({ pages: [{ status: { state: 'newer_format', found: '2.0.0' } }] });
    const value = { version: '1.0.0', agents: [{ ...ACP_REGISTRY_V1_FIXTURE.agents[0], distribution: { npx: { package: 'package@latest' } } }, ACP_REGISTRY_V1_FIXTURE.agents[1]] };
    expect(await context(value).host.execute('registries.items.list', { kind: 'agent' })).toMatchObject({ pages: [{ status: { state: 'ok' }, items: [{ itemId: 'claude-acp', problem: { code: 'unsupported_entry', reason: 'distribution' } }, { itemId: 'fast-agent' }] }] });
    expect(await context(value).host.fetchRequest({ op: 'read', kind: 'agent', sourceId: 'builtin:acp-registry', itemId: 'claude-acp' })).toMatchObject({ op: 'error', status: { state: 'invalid_source' } });
    const unpinned = { version: '1.0.0', agents: [{ ...ACP_REGISTRY_V1_FIXTURE.agents[2], distribution: {
      ...ACP_REGISTRY_V1_FIXTURE.agents[2]!.distribution, npx: { package: 'agent@latest' },
    } }] };
    expect(await context(unpinned).host.execute('registries.items.list', { kind: 'agent' })).toMatchObject({ pages: [{ items: [{ problem: { code: 'unsupported_entry', reason: 'distribution' } }] }] });
  });
  it('checks updates without turning a corrupt existing entry into removal', async () => {
    const provenance = (itemId: string) => ({ sourceId: 'builtin:acp-registry', sourceUrl, format: 'acp-registry' as const, itemId, ref: { kind: 'version' as const, version: '0.1.0' }, importedAt: 1 });
    const { http } = context();
    expect(await acpRegistryAdapterV1.latest({ http }, [provenance('goose'), provenance('removed')])).toEqual(new Map([
      ['goose', { kind: 'version', version: '1.54.0' }], ['removed', 'removed'],
    ]));
    const corrupt = context({ version: '1.0.0', agents: [{ ...ACP_REGISTRY_V1_FIXTURE.agents[2], version: null }] });
    await expect(acpRegistryAdapterV1.latest({ http: corrupt.http }, [provenance('goose')])).rejects.toMatchObject({ status: { state: 'invalid_source' } });
  });
});
