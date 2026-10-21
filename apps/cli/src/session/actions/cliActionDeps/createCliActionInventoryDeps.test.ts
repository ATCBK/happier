import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { DetectProviderMcpServersResult } from '@/mcp/providerDetection/detectProviderMcpServers';
import axios from 'axios';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

const {
  fetchSessionById,
  probeAgentConfigOptionsBestEffort,
  probeAgentModesBestEffort,
  probeAgentModelsBestEffort,
  resolveAvailableAccountSettings,
} = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  probeAgentConfigOptionsBestEffort: vi.fn(),
  probeAgentModesBestEffort: vi.fn(),
  probeAgentModelsBestEffort: vi.fn(),
  resolveAvailableAccountSettings: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
}));

vi.mock('@/settings/accountSettings/resolveAvailableAccountSettings', () => ({
  resolveAvailableAccountSettings,
}));

import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';
import { resolveSessionMcpPreview } from '@/mcp/preview/resolveSessionMcpPreview';

describe('createCliActionInventoryDeps', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    fetchSessionById.mockReset();
    probeAgentConfigOptionsBestEffort.mockReset();
    probeAgentModesBestEffort.mockReset();
    probeAgentModelsBestEffort.mockReset();
    resolveAvailableAccountSettings.mockReset();
    resolveAvailableAccountSettings.mockResolvedValue(null);
  });

  const createProbeDeps = () => ({
    probeAgentModelsBestEffort,
    probeAgentModesBestEffort,
    probeAgentConfigOptionsBestEffort,
  });

  it('preserves a machine preflight refusal in the public models Action', async () => {
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
      callMachineAction: async () => ({ ok: false,
        error: { code: 'connected-service-preflight-failed', message: 'Selected credential could not be prepared.' } }),
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    expect(await executor.execute('agents.models.list', { agentId: 'codex', machineId: 'worker', probe: { cwd: '/repo' } },
      { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'connected-service-preflight-failed' });
  });

  it('offers distinguishable canonical machine names through daemon input discovery without changing target identities', async () => {
    const codec = createMachineContentCodec({ encryptionMode: 'plain' });
    const machines = [
      { id: 'mac-machine', displayName: 'Studio', host: 'mac.local' },
      { id: 'linux-machine', displayName: 'Studio', host: 'linux.local' },
      { id: 'f98b0-machine', displayName: 'Build', host: 'worker.local' },
      { id: 'f98b1-machine', displayName: 'Build', host: 'worker.local' },
      { id: 'laptop-machine', displayName: 'Laptop', host: 'portable.local' },
    ];
    vi.spyOn(axios, 'get').mockResolvedValue({ data: machines.map(machine => ({
      id: machine.id, active: true, revokedAt: null, replacedByMachineId: null,
      storageMode: 'plain', dataEncryptionKey: null,
      metadata: codec.encodeStored(MachinePublishedMetadataV1Schema.parse({
        host: machine.host, displayName: machine.displayName, platform: 'linux', happyCliVersion: 'test',
        homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier',
      })),
    })) });
    const inventory = createCliActionInventoryDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'https://machine-names.test', sessionId: 'session', mode: 'plain', ctx: null });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory,
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) });
    const result = await executor.execute('action.options.resolve', {
      consumer: { kind: 'widget', surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } },
        definition: { kind: 'builtin', id: 'machine_vitals' } }, fieldPath: 'machine',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home' });
    expect(result).toMatchObject({ ok: true, result: { options: machines.map((machine, index) => ({
      value: { serverId: 'home', machineId: machine.id },
      label: ['Studio · mac.local', 'Studio · linux.local', 'Build · f98b0', 'Build · f98b1', 'Laptop'][index],
    })) } });
  });

  it('lists built-in backend models through the canonical dynamic probe when scoped to the session machine', async () => {
    probeAgentModelsBestEffort.mockResolvedValue({
      provider: 'opencode',
      availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
      ],
      supportsFreeform: true,
      source: 'dynamic',
    });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        path: '/repo',
        metadata: {},
      },
    });

    await expect(deps.agentsModelsList({
      agentId: 'opencode',
      backendTargetKey: 'agent:happier.agent.opencode/opencode',
      machineId: 'local-machine',
      limit: 10,
    })).resolves.toEqual({
      agentId: 'opencode',
      items: [
        { id: 'default', label: 'Default' },
        { id: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free' },
      ],
      supportsFreeform: true,
      source: 'dynamic',
    });

    expect(probeAgentModelsBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'opencode',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      cwd: '/repo',
      accountSettings: null,
    }));
  });

  it('keeps session metadata models when a local probe is unavailable', async () => {
    probeAgentModelsBestEffort.mockResolvedValue({
      provider: 'opencode',
      availableModels: [],
      supportsFreeform: false,
      source: 'unavailable',
    });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        path: '/repo',
        metadata: {
          sessionModelsV1: {
            provider: 'opencode',
            availableModels: [{ id: 'metadata-model', name: 'Metadata Model' }],
          },
        },
      },
    });

    await expect(deps.agentsModelsList({
      agentId: 'opencode',
      backendTargetKey: 'agent:happier.agent.opencode/opencode',
      machineId: 'local-machine',
      limit: 10,
    })).resolves.toEqual({
      agentId: 'opencode',
      items: [
        { id: 'default', label: 'Default' },
        { id: 'metadata-model', label: 'Metadata Model' },
      ],
      supportsFreeform: false,
      source: 'session_metadata',
    });
  });

  it('lists agent session modes through the canonical runtime/plugin probe', async () => {
    probeAgentModesBestEffort.mockResolvedValue({
      provider: 'codex',
      availableModes: [
        { id: 'plan', name: 'Plan' },
        { id: 'build', name: 'Build', description: 'Can edit files' },
      ],
      source: 'dynamic',
    });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        path: '/repo',
        metadata: {},
      },
    }) as any;

    await expect(deps.agentsSessionModesList({
      agentId: 'codex',
      backendTargetKey: 'agent:happier.agent.codex/codex',
      machineId: 'local-machine',
      limit: 1,
    })).resolves.toEqual({
      agentId: 'codex',
      items: [{ id: 'plan', label: 'Plan' }],
      source: 'dynamic',
    });

    expect(probeAgentModesBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      cwd: '/repo',
      accountSettings: null,
    }));
  });

  it('lists config option definitions through the canonical probe without returning current or secret values', async () => {
    probeAgentConfigOptionsBestEffort.mockResolvedValue({
      provider: 'claude',
      source: 'dynamic',
      configOptions: [
        {
          id: 'reasoning_effort',
          name: 'Thinking',
          description: 'How much reasoning to use',
          type: 'select',
          currentValue: 'secret-current-value',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'xhigh', name: 'X High', description: 'Maximum reasoning' },
          ],
        },
        {
          id: 'ultracode',
          name: 'UltraCode',
          type: 'boolean',
          currentValue: true,
        },
      ],
    });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        path: '/repo',
        metadata: {},
      },
    }) as any;

    const result = await deps.agentsConfigOptionsList({
      agentId: 'claude',
      backendTargetKey: 'agent:happier.agent.claude/claude',
      machineId: 'local-machine',
      modelId: 'claude-opus-4-8',
      limit: 10,
    });

    expect(result).toEqual({
      agentId: 'claude',
      items: [
        {
          id: 'reasoning_effort',
          label: 'Thinking',
          description: 'How much reasoning to use',
          type: 'select',
          options: [
            { value: 'medium', label: 'Medium' },
            { value: 'xhigh', label: 'X High', description: 'Maximum reasoning' },
          ],
        },
        {
          id: 'ultracode',
          label: 'UltraCode',
          type: 'boolean',
        },
      ],
      source: 'dynamic',
    });
    expect(JSON.stringify(result)).not.toContain('secret-current-value');
    expect(probeAgentConfigOptionsBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      cwd: '/repo',
      accountSettings: null,
    }));
  });

  it('previews MCP spawn options through the existing MCP preview owner without returning secret env', async () => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-preview-account' })).toString('base64url')}.signature`, encryption: null };
    const catalog = McpServerCatalogV1Schema.parse({ v: 1,
      servers: [{ id: 'srv-1', name: 'repo-tools', title: 'Repo Tools', transport: 'stdio',
        stdio: { command: 'echo', args: [] }, env: { SECRET_TOKEN: { t: 'literal', v: 'must-not-return' } }, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'binding', serverId: 'srv-1', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }],
    });
    const detected: DetectProviderMcpServersResult = {
      servers: [{ provider: 'codex', name: 'detected-codex', transport: 'stdio', stdio: { command: 'codex', args: [] },
        envKeys: ['TOKEN'], source: { kind: 'user', path: '/config/codex' }, enabled: true }],
      warnings: [],
    };

    const deps = createCliActionInventoryDeps({
      token: credentials.token,
      credentials,
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        machineId: 'machine-1',
        path: '/repo',
        metadata: {},
      },
      // Machine transport is the boundary; its payload comes from the actual producer.
      callMachineAction: async request => {
        expect(request.machineId).toBe('machine-1');
        return resolveSessionMcpPreview({ settings: { ...catalog, strictMode: true }, machineId: request.machineId,
          directory: '/repo', agentId: 'codex', detectedServers: detected.servers });
      },
    });
    const spawnPreview = deps.spawnMcpServersPreview;
    if (!spawnPreview) throw new Error('MCP preview is not installed');

      const result = await spawnPreview({
        agentId: 'codex',
        machineId: 'machine-1',
        directory: '/repo',
      });

      expect(result).toMatchObject({
        ok: true,
        items: expect.arrayContaining([
          {
            value: 'managed:srv-1',
            label: 'Repo Tools',
            selected: true,
            selectable: true,
            sourceKind: 'managed',
            authMode: 'plainText',
            availability: 'active',
          },
        ]),
        preview: {
          ok: true,
          builtIn: [expect.objectContaining({ key: 'built-in:happier' })],
          managed: [
            expect.objectContaining({
              key: 'managed:srv-1',
              serverId: 'srv-1',
              name: 'repo-tools',
              title: 'Repo Tools',
              transport: 'stdio',
              authMode: 'plainText',
              selected: true,
              selectable: true,
              defaultSelected: true,
              availability: 'active',
              sourceKind: 'managed',
              scopeKind: 'allMachines',
            }),
          ],
          detected: [expect.objectContaining({ key: 'detected:codex:detected-codex', envKeyCount: 1 })],
        },
      });
      expect(JSON.stringify(result)).not.toContain('must-not-return');
  });

  it('reports opaque profile rows instead of calling the visible prefix complete', async () => {
    resolveAvailableAccountSettings.mockResolvedValue({
      profiles: [
        {
          v: 2, id: 'readable', name: 'Readable', extraEnvironmentVariables: [],
          defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
          compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1,
        },
        { v: 99, id: 'future', opaque: { untouched: true } },
      ],
    });
    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: { host: 'local-machine', path: '/repo', metadata: {} },
    });

    await expect(deps.spawnProfilesList?.({})).resolves.toMatchObject({
      coverage: 'unreadable',
      items: [expect.objectContaining({ id: 'readable' })],
    });
  });
});
