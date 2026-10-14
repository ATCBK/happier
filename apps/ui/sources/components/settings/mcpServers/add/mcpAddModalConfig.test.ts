import { describe, expect, it } from 'vitest';

import { McpRegistryServerV1Schema } from '@happier-dev/protocol/registries';
import { mapMcpRegistryServerV1 } from '@happier-dev/protocol/mcp/servers/registry/mapMcpRegistryServerV1';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import {
  buildMcpAddDetailModel,
  findAddedMcpServer,
  mcpAddCreateInputs,
  missingMcpAddFields,
  seedMcpAddValues,
} from './mcpAddModalConfig';

const input = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  target: 'env',
  required: false,
  secret: false,
  ...extra,
});
const server = (overrides: Record<string, unknown>) =>
  McpRegistryServerV1Schema.parse({
    name: 'io.github.example/server',
    description: 'An example server.',
    version: '1.2.0',
    status: 'active',
    remotes: [],
    packages: [],
    ...overrides,
  });
const npmPackage = (environment: unknown[]) => ({
  ecosystem: 'npm',
  identifier: '@example/server',
  version: '1.2.0',
  transport: 'stdio',
  runtimeArguments: [],
  packageArguments: [],
  environment,
});

describe('registry server → Add details', () => {
  it('asks a local package for its key, waits for a Saved Secret, and sends only what was given', () => {
    const registry = server({
      packages: [npmPackage([input('BRAVE_API_KEY', { required: true, secret: true }), input('BRAVE_REGION', { default: 'us' })])],
    });
    const model = buildMcpAddDetailModel(registry);
    if (!model.supported) throw new Error('expected a supported server');
    expect(model).toMatchObject({ transport: 'local', runs: 'npx', signIn: false });
    expect(model.fields.map((field) => [field.key, field.presentation, field.required, field.secret])).toEqual([
      ['BRAVE_API_KEY', 'env', true, true],
      ['BRAVE_REGION', 'env', false, false],
    ]);

    const seeded = seedMcpAddValues(model.fields);
    expect(missingMcpAddFields(model.fields, seeded).map((field) => field.key)).toEqual(['BRAVE_API_KEY']);
    const given = { ...seeded, BRAVE_API_KEY: { t: 'savedSecret' as const, secretId: 'secret-1' } };
    expect(missingMcpAddFields(model.fields, given)).toEqual([]);
    expect(mcpAddCreateInputs(given)).toEqual({
      BRAVE_API_KEY: { t: 'savedSecret', secretId: 'secret-1' },
      BRAVE_REGION: { t: 'literal', v: 'us' },
    });
    // The same values satisfy the real registry mapper, so Add cannot be offered for a server it would refuse.
    const mapped = mapMcpRegistryServerV1({ server: registry, id: 'id-1', name: 'brave', nowMs: 1, inputs: mcpAddCreateInputs(given) });
    expect(mapped.ok).toBe(true);
    const refused = mapMcpRegistryServerV1({ server: registry, id: 'id-1', name: 'brave', nowMs: 1, inputs: mcpAddCreateInputs(seeded) });
    expect(refused).toMatchObject({ ok: false, missingValues: [{ key: 'BRAVE_API_KEY' }] });
  });

  it('signs in once to a remote that declares no key, and asks the key of one that does', () => {
    const open = buildMcpAddDetailModel(server({ remotes: [{ transport: 'streamable-http', url: 'https://mcp.notion.com/mcp', inputs: [] }] }));
    expect(open).toMatchObject({ supported: true, transport: 'remote', runs: 'remoteSignIn', signIn: true, remoteHost: 'mcp.notion.com', fields: [] });

    const keyed = buildMcpAddDetailModel(server({
      remotes: [{ transport: 'streamable-http', url: 'https://api.example.com/mcp', inputs: [input('X-Api-Key', { target: 'header', required: true, secret: true })] }],
    }));
    if (!keyed.supported) throw new Error('expected a supported server');
    expect(keyed).toMatchObject({ runs: 'remote', signIn: false });
    expect(keyed.fields).toMatchObject([{ key: 'X-Api-Key', presentation: 'header', required: true }]);
  });

  it('prefers the sign-in remote over a package, and a package when the remote needs a key', () => {
    const remoteOpen = { transport: 'streamable-http', url: 'https://mcp.example.com/mcp', inputs: [] };
    expect(buildMcpAddDetailModel(server({ remotes: [remoteOpen], packages: [npmPackage([])] }))).toMatchObject({ transport: 'remote', signIn: true });
    const remoteKeyed = { ...remoteOpen, inputs: [input('X-Key', { target: 'header', required: true })] };
    expect(buildMcpAddDetailModel(server({ remotes: [remoteKeyed], packages: [npmPackage([])] }))).toMatchObject({ transport: 'local', runs: 'npx' });
  });

  it('declines a server whose only package the mapper cannot run', () => {
    const nuget = { ...npmPackage([]), ecosystem: 'nuget' };
    expect(buildMcpAddDetailModel(server({ packages: [nuget] }))).toEqual({ supported: false });
  });

  it('knows a registry item that is already added, so the details offer Open', () => {
    const added = {
      id: 'server-1',
      name: 'brave',
      transport: 'stdio',
      env: {},
      createdAt: 1,
      updatedAt: 1,
      origin: {
        kind: 'registry',
        provenance: {
          sourceId: 'builtin:mcp-registry',
          format: 'mcp-registry',
          sourceUrl: 'https://registry.modelcontextprotocol.io',
          itemId: 'io.github.example/server',
          ref: { kind: 'version', version: '1.2.0' },
          importedAt: 1,
        },
      },
    } as unknown as McpServerCatalogEntryV1;
    expect(findAddedMcpServer([added], { sourceId: 'builtin:mcp-registry', itemId: 'io.github.example/server' })?.id).toBe('server-1');
    expect(findAddedMcpServer([added], { sourceId: 'other', itemId: 'io.github.example/server' })).toBeNull();
  });
});
