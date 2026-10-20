import { describe, expect, it } from 'vitest';

import { AcpBackendDefinitionV1Schema, AcpCatalogSettingsV1Schema, AcpCatalogSettingsV1StoredSchema } from './settingsV1.js';
import { openAcpCatalogContentV1 } from './catalogRowsV1.js';
import { RegistryProvenanceV1Schema } from '../../registries/registryItemsV1.js';
import { RegistryUpstreamV1Schema } from '../../registries/registryUpdatesV1.js';

describe('AcpCatalogSettingsV1Schema', () => {
  // Captured from ../0.2 at cd2bb4d853a259ae00ebc3e5981224e3e4bb5380.
  const predecessorDefinition = {
    id: 'kiro', name: 'kiro', title: 'Kiro', command: 'kiro-cli', args: ['acp'],
    env: {}, createdAt: 1, updatedAt: 2,
  };

  it('reads prior catalog runtime shapes without inventing native permission mappings', () => {
    const { command, args, ...fields } = predecessorDefinition;
    for (const runtime of [undefined, { stderrRules: { suppress: [{ includes: ['quiet'] }] } }]) {
      const definition = { ...fields, launch: { kind: 'command', command, args }, ...(runtime ? { runtime } : {}) };
      const parsed = AcpBackendDefinitionV1Schema.parse(definition);
      expect(parsed.runtime).toEqual(runtime);
      expect(parsed.runtime?.permissionModeMapping).toBeUndefined();
    }
  });

  it('retains canonical registry provenance and upstream through the Account-row reader', () => {
    const { command, args, ...fields } = predecessorDefinition;
    const origin = { kind: 'registry' as const,
      provenance: RegistryProvenanceV1Schema.parse({ sourceId: 'builtin:acp-registry', format: 'acp-registry',
        sourceUrl: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json', itemId: 'kiro',
        ref: { kind: 'version', version: '1.2.3' }, importedAt: 2 }),
      iconUrl: 'https://example.com/kiro.svg', publisher: 'Kiro', license: 'Apache-2.0',
      repository: 'https://example.com/repo', website: 'https://example.com',
      upstream: RegistryUpstreamV1Schema.parse({ state: 'update_available', latest: { kind: 'version', version: '1.2.4' } }),
    };
    const definition = { ...fields, launch: { kind: 'command', command, args }, origin };
    const parsed = AcpBackendDefinitionV1Schema.parse(definition);
    expect(parsed.origin).toEqual(origin);
    expect(openAcpCatalogContentV1({ mode: 'plain', material: null,
      content: { t: 'plain', v: { v: 1, definitions: [parsed] } },
    })).toMatchObject({ status: 'opened', record: { definitions: [{ origin }] } });
    expect(AcpBackendDefinitionV1Schema.safeParse({ ...definition, origin: {
      ...origin, provenance: { ...origin.provenance, credentialRef: 'hidden' },
    } }).success).toBe(false);
  });

  it('reads predecessor commands as typed launches without keeping the old writer fields', () => {
    const read = AcpCatalogSettingsV1StoredSchema.parse({ v: 2, backends: [predecessorDefinition] });
    expect(read.backends[0]).toMatchObject({ launch: { kind: 'command', command: 'kiro-cli', args: ['acp'] } });
    expect(read.backends[0]).not.toHaveProperty('command');
    expect(read.backends[0]).not.toHaveProperty('args');
    expect(AcpBackendDefinitionV1Schema.safeParse(predecessorDefinition).success).toBe(false);
    expect(openAcpCatalogContentV1({ mode: 'plain', material: null,
      content: { t: 'plain', v: { v: 1, definitions: [predecessorDefinition] } },
    })).toMatchObject({ status: 'opened', record: { definitions: [{ launch: read.backends[0]!.launch }] } });
  });

  it('writes pinned typed npm, binary and uv launches', () => {
    const { command: _command, args: _args, ...fields } = predecessorDefinition;
    for (const launch of [
      { kind: 'npm', package: '@vendor/agent', version: '1.2.3', args: ['--acp'] },
      { kind: 'archive', version: '1.2.3', args: [], assetsByPlatform: {
        'linux-x64': { archiveUrl: 'https://example.com/agent.tar.gz', executableSubpath: 'agent' },
      } },
      { kind: 'uv', package: 'agent', version: '1.2.3', args: ['--acp'] },
    ]) {
      const result = AcpBackendDefinitionV1Schema.safeParse({ ...fields, launch });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toMatchObject({ launch });
    }
  });
  it('accepts and strips released provider-auth and transport carriers at persisted ingress', () => {
    const result = AcpCatalogSettingsV1StoredSchema.safeParse({
      v: 2,
      backends: [
        {
          id: 'custom-vendor',
          name: 'custom-vendor',
          title: 'Custom Vendor',
          command: 'vendor-cli',
          args: ['acp'],
          env: {
            VENDOR_REGION: { t: 'literal', v: 'eu' },
          },
          auth: {
            support: 'login_terminal',
            machineLoginKey: 'vendor-cli',
            loginCommand: { command: 'vendor-cli', args: ['login'] },
            statusCommand: ['whoami', '--format', 'json'],
            parser: 'vendorWhoamiJson',
          },
          transportProfile: 'vendor-profile',
          defaultMode: 'default',
          defaultModel: 'vendor-pro',
          capabilities: {
            supportsLoadSession: true,
            supportsModes: 'yes',
            supportsModels: 'yes',
            promptImageSupport: 'yes',
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.backends[0]).not.toHaveProperty('transportProfile');
    expect(result.data.backends[0]?.auth).not.toHaveProperty('statusCommand');
    expect(result.data.backends[0]?.auth).not.toHaveProperty('parser');
  });

  it('defaults empty input to an empty v2 catalog', () => {
    const parsed = AcpCatalogSettingsV1Schema.parse({});
    expect(parsed).toEqual({
      v: 2,
      backends: [],
    });
  });

  it('rejects duplicate backend ids', () => {
    const result = AcpCatalogSettingsV1Schema.safeParse({
      v: 2,
      backends: [
        {
          id: 'dup',
          name: 'dup',
          title: 'One',
          launch: { kind: 'command', command: 'agent-a', args: [] },
          env: {},
          capabilities: {
            supportsLoadSession: false,
            supportsModes: 'no',
            supportsModels: 'no',
            promptImageSupport: 'no',
          },
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 'dup',
          name: 'dup-two',
          title: 'Two',
          launch: { kind: 'command', command: 'agent-b', args: [] },
          env: {},
          capabilities: {
            supportsLoadSession: false,
            supportsModes: 'no',
            supportsModels: 'no',
            promptImageSupport: 'no',
          },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate backend names', () => {
    const result = AcpCatalogSettingsV1Schema.safeParse({
      v: 2,
      backends: [
        {
          id: 'backend',
          name: 'backend',
          title: 'Backend',
          launch: { kind: 'command', command: 'agent', args: [] },
          env: {},
          capabilities: {
            supportsLoadSession: false,
            supportsModes: 'no',
            supportsModels: 'no',
            promptImageSupport: 'no',
          },
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 'backend-two',
          name: 'backend',
          title: 'Backend Two',
          launch: { kind: 'command', command: 'agent-two', args: [] },
          env: {},
          capabilities: {
            supportsLoadSession: false,
            supportsModes: 'no',
            supportsModels: 'no',
            promptImageSupport: 'no',
          },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects legacy preset-based catalogs', () => {
    const result = AcpCatalogSettingsV1Schema.safeParse({
      v: 1,
      backends: [],
      presets: [],
    });

    expect(result.success).toBe(false);
  });
});
