import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preflightCatalogEntryFixture } from './preflightSessionControlsProbeAdapter.testkit';

const {
  probeModelsRawMock,
} = vi.hoisted(() => ({
  probeModelsRawMock: vi.fn(),
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

import { probeAgentModelsBestEffort as probeModels, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

function probeAgentModelsBestEffort(params: Parameters<typeof probeModels>[0]) {
  return probeModels({ ...params, catalogEntry: preflightCatalogEntryFixture('codex', {
    failureCacheStrategy: 'retry', probeModelsRaw: probeModelsRawMock,
  }) });
}

afterEach(() => vi.unstubAllEnvs());

describe('probeAgentModelsBestEffort (codex app-server)', () => {
  beforeEach(() => {
    probeModelsRawMock.mockReset();
    vi.stubEnv('HAPPIER_CODEX_PATH', process.execPath);
    resetAgentModelsProbeCacheForTests();
  });

  it('retries a transient Codex app-server preflight failure within the same probe so the first result is rich', async () => {
    probeModelsRawMock
      .mockRejectedValueOnce(new Error('temporary codex app-server failure'))
      .mockResolvedValueOnce([
        { id: 'gpt-5.4', name: 'GPT-5.4' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
      ]);

    const first = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(first).toMatchObject({
      agentId: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'gpt-5.4', name: 'GPT-5.4' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
    expect(probeModelsRawMock).toHaveBeenCalledTimes(2);
    expect(probeModelsRawMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cwd: '/repo',
      probeKind: 'models',
      accountSettings: { codexBackendMode: 'appServer' },
    }));
  });

  it('uses Codex app-server session controls when account settings select appServer', async () => {
    probeModelsRawMock.mockResolvedValueOnce([
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        description: 'Latest default',
        modelOptions: [
          {
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
    ]);

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-auth-settings',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toMatchObject({
      agentId: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          description: 'Latest default',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: 'medium',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
        { id: 'gpt-4.1', name: 'GPT-4.1' },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
    expect(probeModelsRawMock).toHaveBeenCalledTimes(1);
    expect(probeModelsRawMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo-auth-settings',
      probeKind: 'models',
      accountSettings: { codexBackendMode: 'appServer' },
    }));
  });

  it('uses Codex app-server session controls when the shared runtime defaults to appServer', async () => {
    probeModelsRawMock.mockResolvedValueOnce([
      { id: 'gpt-5.4', name: 'GPT-5.4' },
    ]);

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-default',
    });

    expect(result).toMatchObject({
      agentId: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'gpt-5.4', name: 'GPT-5.4' },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
    expect(probeModelsRawMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo-default',
      probeKind: 'models',
      accountSettings: null,
    }));
  });

  it('preserves an observed empty Codex app-server model list without static fallback models', async () => {
    probeModelsRawMock.mockResolvedValueOnce([]);

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-empty',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toMatchObject({
      agentId: 'codex',
      availableModels: [],
      supportsFreeform: false,
      source: 'dynamic',
    });
    expect(probeModelsRawMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces repeated Codex app-server preflight failures as unavailable instead of static fallback models', async () => {
    probeModelsRawMock
      .mockRejectedValueOnce(new Error('codex app-server unavailable'))
      .mockRejectedValueOnce(new Error('codex app-server still unavailable'));

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-retryable-failure',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toMatchObject({
      agentId: 'codex',
      availableModels: [],
      supportsFreeform: false,
      source: 'unavailable',
    });
    expect(probeModelsRawMock).toHaveBeenCalledTimes(2);
  });

  it('filters malformed dynamic model payload entries and normalizes invalid option values to null', async () => {
    probeModelsRawMock.mockResolvedValueOnce([
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        modelOptions: [
          {
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: { invalid: true },
            options: [
              { value: { invalid: true }, name: 'Auto' },
              { value: 'medium', name: 'Medium' },
              { value: 'skip-me' },
            ],
          },
          {
            id: 'missing-type',
            name: 'Broken option',
            currentValue: 'ignored',
          },
        ],
      },
      {
        id: 'missing-name',
        modelOptions: [],
      },
    ]);

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-parse',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toMatchObject({
      agentId: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: null,
              options: [
                { value: null, name: 'Auto' },
                { value: 'medium', name: 'Medium' },
              ],
            },
          ],
        },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
  });
});
