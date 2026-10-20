import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preflightCatalogEntryFixture } from './preflightSessionControlsProbeAdapter.testkit';

const {
  probeConfigOptionsRawMock,
} = vi.hoisted(() => ({
  probeConfigOptionsRawMock: vi.fn(),
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

import { probeAgentConfigOptionsBestEffort as probeConfigOptions } from './agentConfigOptionsProbe';

let failureCacheStrategy: 'retry' | 'cooldown' = 'retry';
function probeAgentConfigOptionsBestEffort(params: Parameters<typeof probeConfigOptions>[0]) {
  return probeConfigOptions({ ...params, catalogEntry: preflightCatalogEntryFixture('codex', {
    failureCacheStrategy, probeConfigOptionsRaw: probeConfigOptionsRawMock,
  }) });
}

describe('probeAgentConfigOptionsBestEffort (codex app-server)', () => {
  beforeEach(() => {
    probeConfigOptionsRawMock.mockReset();
    failureCacheStrategy = 'retry';
  });

  it('retries a transient Codex app-server preflight failure within the same probe so the first result is rich', async () => {
    probeConfigOptionsRawMock
      .mockRejectedValueOnce(new Error('temporary codex app-server failure'))
      .mockResolvedValueOnce([
        {
          id: 'speed',
          name: 'Speed',
          type: 'select',
          currentValue: 'fast',
          options: [
            { value: 'standard', name: 'Standard' },
            { value: 'fast', name: 'Fast' },
          ],
        },
      ]);

    const result = await probeAgentConfigOptionsBestEffort({
      agentId: 'codex',
      cwd: '/repo-transient',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toEqual({
      agentId: 'codex',
      configOptions: [
        {
          id: 'speed',
          name: 'Speed',
          type: 'select',
          currentValue: 'fast',
          options: [
            { value: 'standard', name: 'Standard' },
            { value: 'fast', name: 'Fast' },
          ],
        },
      ],
      source: 'dynamic',
    });
    expect(probeConfigOptionsRawMock).toHaveBeenCalledTimes(2);
    expect(probeConfigOptionsRawMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cwd: '/repo-transient',
      probeKind: 'configOptions',
      accountSettings: { codexBackendMode: 'appServer' },
    }));
  });

  it('surfaces repeated Codex app-server preflight failures as unavailable instead of static fallback config options', async () => {
    probeConfigOptionsRawMock
      .mockRejectedValueOnce(new Error('codex app-server unavailable'))
      .mockRejectedValueOnce(new Error('codex app-server still unavailable'));

    const result = await probeAgentConfigOptionsBestEffort({
      agentId: 'codex',
      cwd: '/repo-retryable-failure',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toEqual({
      agentId: 'codex',
      configOptions: [],
      source: 'unavailable',
    });
    expect(probeConfigOptionsRawMock).toHaveBeenCalledTimes(2);
  });

  it('returns only session-level config options when model-scoped controls are present', async () => {
    probeConfigOptionsRawMock.mockResolvedValueOnce([]);

    const result = await probeAgentConfigOptionsBestEffort({
      agentId: 'codex',
      cwd: '/repo',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toEqual({
      agentId: 'codex',
      configOptions: [],
      source: 'dynamic',
    });
    expect(probeConfigOptionsRawMock).toHaveBeenCalledTimes(1);
  });

  it('uses Codex app-server session controls config options when the shared runtime defaults to appServer', async () => {
    probeConfigOptionsRawMock.mockResolvedValueOnce([
      {
        id: 'speed',
        name: 'Speed',
        type: 'select',
        currentValue: 'fast',
        options: [
          { value: 'standard', name: 'Standard' },
          { value: 'fast', name: 'Fast' },
        ],
      },
    ]);

    const result = await probeAgentConfigOptionsBestEffort({
      agentId: 'codex',
      cwd: '/repo-default',
    });

    expect(result).toEqual({
      agentId: 'codex',
      configOptions: [
        {
          id: 'speed',
          name: 'Speed',
          type: 'select',
          currentValue: 'fast',
          options: [
            { value: 'standard', name: 'Standard' },
            { value: 'fast', name: 'Fast' },
          ],
        },
      ],
      source: 'dynamic',
    });
    expect(probeConfigOptionsRawMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo-default',
      probeKind: 'configOptions',
      accountSettings: null,
    }));
  });

  it('surfaces provider-owned config-option probe unavailability instead of a static fallback', async () => {
    failureCacheStrategy = 'cooldown';
    probeConfigOptionsRawMock.mockResolvedValueOnce(null);

    const result = await probeAgentConfigOptionsBestEffort({
      agentId: 'codex',
      cwd: '/repo-unavailable',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toEqual({
      agentId: 'codex',
      configOptions: [],
      source: 'unavailable',
    });
  });

  it('surfaces invalid dynamic config-options results as unavailable without caching a 24h success fallback', async () => {
    probeConfigOptionsRawMock
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    const first = await probeAgentConfigOptionsBestEffort({
      agentId: 'codex',
      cwd: '/repo-invalid',
      accountSettings: { codexBackendMode: 'appServer' },
    });
    expect(first).toEqual({
      agentId: 'codex',
      configOptions: [],
      source: 'unavailable',
    });

    probeConfigOptionsRawMock.mockResolvedValueOnce([
      {
        id: 'speed',
        name: 'Speed',
        type: 'select',
        currentValue: 'fast',
        options: [
          { value: 'standard', name: 'Standard' },
          { value: 'fast', name: 'Fast' },
        ],
      },
    ]);

    const second = await probeAgentConfigOptionsBestEffort({
      agentId: 'codex',
      cwd: '/repo-invalid',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(second).toEqual({
      agentId: 'codex',
      configOptions: [
        {
          id: 'speed',
          name: 'Speed',
          type: 'select',
          currentValue: 'fast',
          options: [
            { value: 'standard', name: 'Standard' },
            { value: 'fast', name: 'Fast' },
          ],
        },
      ],
      source: 'dynamic',
    });
    expect(probeConfigOptionsRawMock).toHaveBeenCalledTimes(3);
  });
});
