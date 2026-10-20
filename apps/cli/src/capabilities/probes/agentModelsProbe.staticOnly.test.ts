import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnProcess } = vi.hoisted(() => ({
  spawnProcess: vi.fn(() => { throw new Error('Static probing must not launch a process'); }),
}));

vi.mock('cross-spawn', async importOriginal => ({
  ...await importOriginal<typeof import('cross-spawn')>(), default: spawnProcess,
}));

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: spawnProcess,
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

afterEach(() => vi.unstubAllEnvs());

describe('probeAgentModelsBestEffort (static Agent models)', () => {
  beforeEach(() => {
    resetAgentModelsProbeCacheForTests();
    spawnProcess.mockClear();
  });

  it('does not start a hidden ACP backend when no canonical preflight model probe exists', async () => {
    const res = await probeAgentModelsBestEffort({
      agentId: 'qwen',
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(res).toMatchObject({
      agentId: 'qwen',
      source: 'static',
      availableModels: [{ id: 'default', name: 'Default', capabilities: { structuredOutput: 'unknown' } }],
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('uses curated static Claude model labels when its CLI is installed but no preflight hook is admitted', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
    const res = await probeAgentModelsBestEffort({
      agentId: 'claude',
      catalogEntry: null,
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(res.agentId).toBe('claude');
    expect(res.availableModels.length).toBeGreaterThan(0);
    expect(res.source).toBe('static');
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
