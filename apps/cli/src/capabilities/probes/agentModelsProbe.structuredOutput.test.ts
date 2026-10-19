import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { readAgentStructuredOutputCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { probeAgentModelsBestEffort, probeModelsFromAcpBackend, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';
import { readNativeExecutionRunOfferedModel } from '@/agent/runtime/bridges/executionRun/structuredOutputAdmission';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

describe('model probe structured output evidence', () => {
  beforeEach(() => {
    resetAgentModelsProbeCacheForTests();
    // The real executable resolver sees an existing executable; native observations below are the process boundary.
    vi.stubEnv('HAPPIER_CODEX_PATH', process.execPath);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('preserves explicit model support and stamps the native JSON contract only on offered models', async () => {
    const entry = readAgentCatalogSnapshot().catalogEntriesById.codex;
    if (!entry) throw new Error('Bundled Codex catalog fixture is unavailable');
    expect(readAgentStructuredOutputCapabilities(readAgentCatalogSnapshot().agentDefinitionsById.get('codex')?.richDefinition?.definition))
      .toMatchObject({ formats: ['json'] });
    // The raw native model observation is the process boundary; catalog projection and normalization stay real.
    const catalogEntry: AgentCatalogEntry = {
      ...entry,
      getPreflightSessionControlsProbeAdapter: async () => ({
        probeModelsRaw: async () => [
          { id: 'offered', name: 'Offered' },
          { id: 'unsupported', name: 'Unsupported', capabilities: { structuredOutput: 'unsupported', toolRoundTrips: 'supported' } },
          { id: 'unknown', name: 'Unknown', capabilities: { structuredOutput: 'unknown' } },
        ],
      }),
    };
    const result = await probeAgentModelsBestEffort({ agentId: 'codex', catalogEntry, cwd: '/structured-output-catalog' });

    expect(result.source).toBe('dynamic');
    expect(result.availableModels.find((model) => model.id === 'offered')).toMatchObject({
      capabilities: { structuredOutput: 'supported' },
    });
    expect(result.availableModels.find((model) => model.id === 'default')).toMatchObject({
      capabilities: { structuredOutput: 'supported' },
    });
    expect(result.availableModels.find((model) => model.id === 'unsupported')).toMatchObject({
      capabilities: { structuredOutput: 'unsupported', toolRoundTrips: 'supported' },
    });
    expect(result.availableModels.find((model) => model.id === 'unknown')).toMatchObject({
      capabilities: { structuredOutput: 'unknown' },
    });
  });

  it('preserves explicit ACP evidence without borrowing a native Agent contract', async () => {
    const models = await probeModelsFromAcpBackend({
      backend: {
        startSession: async () => ({ sessionId: 'configured-session' }),
        dispose: async () => {},
        getSessionModelState: () => ({ availableModels: [
          { id: 'default', name: 'Default', capabilities: { structuredOutput: 'unsupported' } },
          { id: 'configured', name: 'Configured' },
          { id: 'explicit', name: 'Explicit', capabilities: { structuredOutput: 'supported' } },
        ] }),
      },
      timeoutMs: 1000,
    });
    expect(models?.find((model) => model.id === 'configured')).not.toHaveProperty('capabilities');
    expect(models?.find((model) => model.id === 'explicit')).toMatchObject({ capabilities: { structuredOutput: 'supported' } });
    expect(models?.find((model) => model.id === 'default')).toMatchObject({ capabilities: { structuredOutput: 'unsupported' } });
  });

  it.each(['unknown', 'unsupported'] as const)('preserves explicit native default %s evidence', async structuredOutput => {
    const entry = readAgentCatalogSnapshot().catalogEntriesById.codex;
    if (!entry) throw new Error('Bundled Codex catalog fixture is unavailable');
    const catalogEntry: AgentCatalogEntry = { ...entry, getPreflightSessionControlsProbeAdapter: async () => ({
      probeModelsRaw: async () => [{ id: 'default', name: 'Native default', capabilities: { structuredOutput } }],
    }) };
    const observed = await readNativeExecutionRunOfferedModel({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      modelId: 'default', cwd: '/explicit-native-default', catalogEntry });
    expect(observed?.capabilities?.structuredOutput).toBe(structuredOutput);
  });

  it('isolates two Accounts reading the same native occurrence and working directory', async () => {
    const entry = readAgentCatalogSnapshot().catalogEntriesById.codex;
    if (!entry) throw new Error('Bundled Codex catalog fixture is unavailable');
    // Only the raw native observation is substituted; the real offered-model
    // reader, probe variant, cache and normalization compose below it.
    const catalogEntry: AgentCatalogEntry = { ...entry, getPreflightSessionControlsProbeAdapter: async () => ({
      probeModelsRaw: async input => [{ id: 'offered', name: String(input.accountSettings?.fixtureAccount),
        capabilities: { structuredOutput: input.accountSettings?.fixtureAccount === 'first' ? 'supported' : 'unsupported' } }],
    }) };
    const native = { backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' }, modelId: 'offered',
      cwd: '/same-native-cwd', runtimeCacheKey: 'same-native-occurrence', catalogEntry };
    await expect(readNativeExecutionRunOfferedModel({ ...native, accountSettings: { fixtureAccount: 'first' },
      promptCredentials: { token: 'native-first-account', encryption: null } }))
      .resolves.toMatchObject({ name: 'first', capabilities: { structuredOutput: 'supported' } });
    await expect(readNativeExecutionRunOfferedModel({ ...native, accountSettings: { fixtureAccount: 'second' },
      promptCredentials: { token: 'native-second-account', encryption: null } }))
      .resolves.toMatchObject({ name: 'second', capabilities: { structuredOutput: 'unsupported' } });
  });

  it('marks a normalization-created default placeholder as unknown, not an offered model', async () => {
    const models = await probeModelsFromAcpBackend({
      backend: {
        startSession: async () => ({ sessionId: 'placeholder-session' }), dispose: async () => {},
        getSessionModelState: () => ({ availableModels: [{ id: 'configured', name: 'Configured' }] }),
      },
      timeoutMs: 1000,
    });
    expect(models?.find(model => model.id === 'default')).toMatchObject({ capabilities: { structuredOutput: 'unknown' } });
  });
});
