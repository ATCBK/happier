import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  McpServersSettingsV1Schema,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  resolveSessionCapabilitiesV1,
  projectMcpServerMaterializationV1,
  type McpServersSettingsV1,
  sealSavedSecretResourceStoredContentV1,
  type SavedSecretCatalogResourceV1,
} from '@happier-dev/protocol';

function resolveMcpMaterialization(settings: McpServersSettingsV1, context: { machineId: string; directory: string }) {
  return projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({ context: { ...context, machinePlatform: null, projectKey: null, agentId: null },
    mcp: settings, skills: null, selection: {}, agentAcceptsUserMcp: true }), context.directory);
}

import { projectPath } from '@/projectPath';
import { resolvePackagedRuntimeEntrypoint } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';
import {
  createSavedSecretMaterializerV1,
  type SavedSecretCatalogResourceInputV1,
} from '@/settings/secrets/savedSecretCatalog';

import { materializeMcpServerConfigRecord } from './materializeMcpServerConfigRecord';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

describe('materializeMcpServerConfigRecord', () => {
  it('refuses an OAuth server without a resource-bound request-auth capability', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'oauth', name: 'oauth', transport: 'http', remote: { url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' } },
      env: {}, createdAt: 0, updatedAt: 0,
    }], bindings: [{ id: 'on', serverId: 'oauth', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }] });
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-auth-refusal-'));
    try {
      await expect(materializeMcpServerConfigRecord({
        resolved: resolveMcpMaterialization(settings, { machineId: 'm', directory: '/repo' }), tmpDir: root,
      })).rejects.toThrow('mcp_sign_in_required');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps the OAuth capability only in the private bridge configuration and refuses a different resource', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'oauth', name: 'oauth', transport: 'http', remote: { url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' } },
      env: {}, createdAt: 0, updatedAt: 0,
    }], bindings: [{ id: 'on', serverId: 'oauth', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }] });
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-auth-config-'));
    const resolved = resolveMcpMaterialization(settings, { machineId: 'm', directory: '/repo' });
    try {
      const auth = { capabilityFile: join(root, 'capability.json'), resource: 'https://mcp.example.test/path' };
      const result = await materializeMcpServerConfigRecord({ resolved, tmpDir: root, requestAuthByServerId: { oauth: auth } });
      try {
        const bridge = result.mcpServers.oauth!;
        expect(JSON.stringify(bridge)).not.toContain(auth.capabilityFile);
        const config = JSON.parse(await readFile(bridge.env!.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE!, 'utf8'));
        expect(config.auth).toEqual(auth);
      } finally { result.cleanup(); }
      await expect(materializeMcpServerConfigRecord({ resolved, tmpDir: root,
        requestAuthByServerId: { oauth: { ...auth, resource: 'https://mcp.example.test/another' } },
      })).rejects.toThrow('mcp_resource_mismatch');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([true, false])('materializes attested headers and omits absent facts (attested=%s)', async (attested) => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'wilson', name: 'wilson', transport: 'http',
      remote: { url: 'https://wilson.example.test/mcp', headers: {
        'X-Wilson-On-Behalf-Of': { t: 'sessionAttested', field: 'externalPrincipalId' },
        'X-Wilson-Source-Message': { t: 'sessionAttested', field: 'sourceMessageId' },
        'X-Happier-Session': { t: 'sessionAttested', field: 'sessionId' },
      } }, env: {}, createdAt: 0, updatedAt: 0,
    }], bindings: [{ id: 'b', serverId: 'wilson', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }] });
    const dir = await mkdtemp(join(tmpdir(), 'happier-attested-mcp-'));
    try {
      const result = await materializeMcpServerConfigRecord({
        resolved: resolveMcpMaterialization(settings, { machineId: 'm', directory: '/repo' }),
        session: { sessionId: 'session-1', ...(attested ? { attestedContext: {
          externalPrincipalId: 'sales@batiplus.ch', sourceMessageId: '<lead@example.test>',
        } } : {}) }, processEnv: { externalPrincipalId: 'forged' }, tmpDir: dir,
      });
      try {
        expect(result.warnings).toEqual([]);
        const configPath = result.mcpServers.wilson.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE;
        expect(typeof configPath).toBe('string');
        const config = JSON.parse(await readFile(configPath!, 'utf8'));
        expect(config.headers).toEqual({ 'X-Happier-Session': 'session-1', ...(attested ? {
          'X-Wilson-On-Behalf-Of': 'sales@batiplus.ch', 'X-Wilson-Source-Message': '<lead@example.test>',
        } : {}) });
      } finally { result.cleanup(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each([
    ['missing', 'personal_missing', null],
    ['temporarily_unavailable', 'happier:shared-secret:v1:resource_1', 'temporarily_unavailable'],
    ['forbidden', 'happier:shared-secret:v1:resource_1', 'access_removed'],
    ['repair_required', 'happier:shared-secret:v1:resource_1', 'update_required'],
    ['deleted', 'happier:shared-secret:v1:resource_1', 'deleted'],
    ['mode_incompatible', 'happier:shared-secret:v1:resource_1', 'recipient_mode_unsupported'],
    ['corrupt', 'happier:shared-secret:v1:resource_1', 'ready'],
  ] as const)('fails an explicitly enabled Saved Secret ref with typed status %s even in non-strict mode', async (
    expectedStatus,
    secretId,
    materialStatus,
  ) => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [{
        id: 's1',
        name: 'alpha',
        transport: 'stdio',
        stdio: { command: 'node', args: [] },
        env: { API_KEY: { t: 'savedSecret', secretId } },
        createdAt: 0,
        updatedAt: 0,
      }],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });
    const resources: SavedSecretCatalogResourceInputV1[] = materialStatus === null ? [] : [{
      resourceId: 'resource_1',
      ownerAccountId: 'owner',
      displayName: 'shared',
      kind: 'token',
      encryptionMode: 'plain',
      revision: 1,
      materialStatus: materialStatus satisfies SavedSecretCatalogResourceV1['materialStatus'],
      storedContent: materialStatus === 'ready' ? null : sealSavedSecretResourceStoredContentV1({
        resourceId: 'resource_1',
        mode: 'plain',
        content: { v: 1, name: 'shared', kind: 'token', value: 'unused' },
      }),
    }];
    const savedSecretMaterializer = createSavedSecretMaterializerV1({
      accountSettings: {},
      settingsSecretsReadKeys: [],
      resources,
      resourceCatalogState: 'ready',
    });

    const promise = materializeMcpServerConfigRecord({
      resolved: resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' }),
      savedSecretMaterializer,
      processEnv: {},
      tmpDir: null,
      strictMode: false,
    });

    await expect(promise).rejects.toMatchObject({
      code: 'saved_secret_resolution_failed',
      status: expectedStatus,
      consumer: 'mcp',
      field: 'env:API_KEY',
    });
  });

  it('preserves typed Saved Secret failures for remote header refs', async () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [{
        id: 's1',
        name: 'remote',
        transport: 'http',
        remote: {
          url: 'https://mcp.example.com',
          headers: {
            Authorization: {
              t: 'savedSecret',
              secretId: 'happier:shared-secret:v1:resource_1',
            },
          },
        },
        env: {},
        createdAt: 0,
        updatedAt: 0,
      }],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });
    const savedSecretMaterializer = createSavedSecretMaterializerV1({
      accountSettings: {},
      settingsSecretsReadKeys: [],
      resources: [{
        resourceId: 'resource_1',
        ownerAccountId: 'owner',
        displayName: 'shared',
        kind: 'token',
        encryptionMode: 'plain',
        revision: 1,
        materialStatus: 'deleted',
        storedContent: sealSavedSecretResourceStoredContentV1({
          resourceId: 'resource_1',
          mode: 'plain',
          content: { v: 1, name: 'shared', kind: 'token', value: 'unused' },
        }),
      }],
      resourceCatalogState: 'ready',
    });

    await expect(materializeMcpServerConfigRecord({
      resolved: resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' }),
      savedSecretMaterializer,
      processEnv: {},
      tmpDir: null,
      strictMode: false,
    })).rejects.toMatchObject({
      code: 'saved_secret_resolution_failed',
      status: 'deleted',
      consumer: 'mcp',
      field: 'header:Authorization',
    });
  });

  it('materializes stdio servers and expands env templates', async () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'example-mcp', args: ['server.js'] },
          env: { API_KEY: { t: 'literal', v: '${TOKEN}' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
    const out = await materializeMcpServerConfigRecord({
      resolved,
      processEnv: { TOKEN: 'sk-test' },
      tmpDir: null,
    });

    expect(out.mcpServers.alpha.command).toBe('example-mcp');
    expect(out.mcpServers.alpha.args).toEqual(['server.js']);
    expect(out.mcpServers.alpha.env).toEqual({ API_KEY: 'sk-test' });
  });

  it('decrypts savedSecret env values using the settings secrets key', async () => {
    const masterSecret = new Uint8Array(32).fill(9);
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(masterSecret);
    const randomBytes = deterministicRandomBytesFactory();
    const enc = encryptSecretStringV1('sk-real', settingsSecretsKey, randomBytes);

    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'example-mcp', args: [] },
          env: { API_KEY: { t: 'savedSecret', secretId: 'sec1' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
    const out = await materializeMcpServerConfigRecord({
      resolved,
      savedSecretMaterializer: createSavedSecretMaterializerV1({
        accountSettings: { secrets: [{ id: 'sec1', encryptedValue: { _isSecretValue: true, encryptedValue: enc } }] },
        settingsSecretsReadKeys: [settingsSecretsKey],
      }),
      processEnv: {},
      tmpDir: null,
    });

    expect(out.mcpServers.alpha.env).toEqual({ API_KEY: 'sk-real' });
  });

  it('decrypts savedSecret env values using read-key fallbacks when legacy credentials read canonicalized settings', async () => {
    const recoverySecret = new Uint8Array(32).fill(6);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const canonicalSettingsKey = deriveSettingsSecretsKeyV1(machineKey);
    const legacySettingsKey = deriveSettingsSecretsKeyV1(recoverySecret);
    const randomBytes = deterministicRandomBytesFactory();
    const enc = encryptSecretStringV1('sk-legacy', legacySettingsKey, randomBytes);

    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'example-mcp', args: [] },
          env: { API_KEY: { t: 'savedSecret', secretId: 'sec1' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
    const out = await materializeMcpServerConfigRecord({
      resolved,
      savedSecretMaterializer: createSavedSecretMaterializerV1({
        accountSettings: { secrets: [{ id: 'sec1', encryptedValue: { _isSecretValue: true, encryptedValue: enc } }] },
        settingsSecretsReadKeys: [canonicalSettingsKey, legacySettingsKey],
      }),
      processEnv: {},
      tmpDir: null,
    });

    expect(out.mcpServers.alpha.env).toEqual({ API_KEY: 'sk-legacy' });
  });

  it('skips unresolved literal refs when strictMode=false and throws when strictMode=true', async () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'node', args: [] },
          env: { API_KEY: { t: 'literal', v: '${MISSING}' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });

    const nonStrict = await materializeMcpServerConfigRecord({
      resolved,
      processEnv: {},
      tmpDir: null,
      strictMode: false,
    });
    expect(nonStrict.mcpServers).toEqual({});
    expect(nonStrict.warnings.length).toBeGreaterThan(0);

    await expect(
      materializeMcpServerConfigRecord({
        resolved,
        processEnv: {},
        tmpDir: null,
        strictMode: true,
      }),
    ).rejects.toThrow(/missing/i);
  });

  it('materializes remote servers via a stdio bridge config file (no secrets in argv)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-remote-test-'));
    try {
      const masterSecret = new Uint8Array(32).fill(4);
      const settingsSecretsKey = deriveSettingsSecretsKeyV1(masterSecret);
      const randomBytes = deterministicRandomBytesFactory();
      const enc = encryptSecretStringV1('Bearer SECRET', settingsSecretsKey, randomBytes);

      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'http',
            remote: { url: 'https://mcp.example.com', headers: { Authorization: { t: 'savedSecret', secretId: 'sec1' } } },
            env: {},
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
      });

      const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
      const out = await materializeMcpServerConfigRecord({
        resolved,
        savedSecretMaterializer: createSavedSecretMaterializerV1({
          accountSettings: { secrets: [{ id: 'sec1', encryptedValue: { _isSecretValue: true, encryptedValue: enc } }] },
          settingsSecretsReadKeys: [settingsSecretsKey],
        }),
        processEnv: {},
        tmpDir: dir,
        deps: {
          resolveRemoteBridgeCommand: () => ({ command: 'node', args: ['bridge.js'] }),
        },
      });

      const cfg = out.mcpServers.alpha;
      expect(cfg.command).toBe('node');
      expect(cfg.args).toEqual(['bridge.js']);
      expect(cfg.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE).toBeTruthy();

      const argvJoined = (cfg.args ?? []).join(' ');
      expect(argvJoined).not.toContain('SECRET');

      const configPath = String(cfg.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE ?? '');
      const raw = await readFile(configPath, 'utf8');
      expect(raw).toContain('mcp.example.com');
      expect(raw).toContain('Bearer SECRET');

      const st = await stat(configPath);
      expect(st.mode & 0o777).toBe(0o600);
      out.cleanup();
      expect(existsSync(configPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('normalizes package-runner stdio servers through managed pnpm with a neutral launch cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-stdio-launcher-test-'));
    try {
      const fakePnpmPath = join(dir, 'pnpm');
      await writeFile(fakePnpmPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(fakePnpmPath, 0o755);
      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'stdio',
            stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
            env: { API_KEY: { t: 'literal', v: '${TOKEN}' } },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
      });

      const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
      const out = await materializeMcpServerConfigRecord({
        resolved,
        processEnv: { HOME: '/safe-home', TOKEN: 'sk-test', HAPPIER_PNPM_BIN: fakePnpmPath },
        tmpDir: dir,
      });

      const cfg = out.mcpServers.alpha;
      expect(cfg.command).toBe(process.execPath);
      expect(cfg.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE).toBeTruthy();
      expect(cfg.env?.API_KEY).toBeUndefined();

      const sourceEntrypoint = join(projectPath(), 'src', 'mcp', 'launchers', 'stdioMcpServerLauncher.ts');
      const tsxHookPath = resolveTsxImportHookPath();
      // `resolvePackagedRuntimeEntrypoint` owns the candidate order (package-dist,
      // then dist, across every packaged runtime root), so ask it rather than
      // re-deriving one directory here: a checkout that carries only one of them
      // must not read as "no packaged entrypoint".
      const packagedEntrypoint = resolvePackagedRuntimeEntrypoint('mcp/launchers/stdioMcpServerLauncher.mjs');
      const expectedArgs =
        !existsSync(packagedEntrypoint) && existsSync(sourceEntrypoint) && typeof tsxHookPath === 'string' && tsxHookPath.length > 0
          ? [
              '--no-warnings',
              '--no-deprecation',
              '--import',
              tsxHookPath,
              sourceEntrypoint,
            ]
          : ['--no-warnings', '--no-deprecation', packagedEntrypoint];
      expect(cfg.args).toEqual(expectedArgs);
      if (expectedArgs.includes('--import')) {
        expect(cfg.env?.TSX_TSCONFIG_PATH).toBe(resolveCliTsxTsconfigPath());
      } else {
        expect(cfg.env?.TSX_TSCONFIG_PATH).toBeUndefined();
      }

      const configPath = String(cfg.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE ?? '');
      const raw = await readFile(configPath, 'utf8');
      expect(raw).toContain(`"command":"${fakePnpmPath}"`);
      expect(raw).toContain('"args":["dlx","@modelcontextprotocol/server-sequential-thinking"]');
      expect(raw).toContain('"cwd":"/safe-home"');
      expect(raw).toContain('"API_KEY":"sk-test"');
      expect(raw).not.toContain('happier-mcp-stdio-launcher.mjs');
      out.cleanup();
      expect(existsSync(configPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves workspace cwd for package-manager run and exec stdio servers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-stdio-workspace-cwd-test-'));
    try {
      const fakePnpmPath = join(dir, 'pnpm');
      await writeFile(fakePnpmPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(fakePnpmPath, 0o755);
      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'stdio',
            stdio: { command: 'pnpm', args: ['exec', 'tsx', 'server.ts'] },
            env: {},
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
      });

      const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo/worktree' });
      const out = await materializeMcpServerConfigRecord({
        resolved,
        processEnv: { HOME: '/safe-home', HAPPIER_PNPM_BIN: fakePnpmPath },
        tmpDir: dir,
      });

      const configPath = String(out.mcpServers.alpha.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE ?? '');
      const raw = await readFile(configPath, 'utf8');
      expect(raw).toContain(`"command":"${fakePnpmPath}"`);
      expect(raw).toContain('"args":["exec","tsx","server.ts"]');
      expect(raw).toContain('"cwd":"/repo/worktree"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips package-runner stdio servers when managed pnpm is unavailable in non-strict mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-package-runner-unavailable-'));
    const originalFetch = globalThis.fetch;
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
    try {
      globalThis.fetch = async () => {
        throw new Error('offline');
      };

      const out = await materializeMcpServerConfigRecord({
        resolved,
        processEnv: { PATH: '', HAPPIER_HOME_DIR: join(dir, 'home'), HAPPIER_MANAGED_PNPM_BOOTSTRAP: '0' },
        tmpDir: null,
        strictMode: false,
      });

      expect(out.mcpServers).toEqual({});
      expect(out.warnings).toContainEqual(expect.objectContaining({
        serverName: 'alpha',
        code: 'invalid_server',
      }));
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for package-runner stdio servers when managed pnpm is unavailable in strict mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-package-runner-unavailable-strict-'));
    const originalFetch = globalThis.fetch;
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: true,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });

    try {
      globalThis.fetch = async () => {
        throw new Error('offline');
      };

      await expect(
        materializeMcpServerConfigRecord({
          resolved,
          processEnv: { PATH: '', HAPPIER_HOME_DIR: join(dir, 'home'), HAPPIER_MANAGED_PNPM_BOOTSTRAP: '0' },
          tmpDir: null,
          strictMode: true,
        }),
      ).rejects.toThrow(Error);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
