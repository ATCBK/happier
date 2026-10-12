import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import * as persistence from '@/persistence';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveProviderCliDependencies } from './deps';

describe('standalone Provider CLI bootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetServerFeaturesClientForTests();
    resetInMemoryAccountSettingsContextForTests();
  });

  it('loads admitted Provider declarations without a process-local daemon runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-provider-cli-'));
    const original = {
      happyHomeDir: configuration.happyHomeDir,
      settingsFile: configuration.settingsFile,
      activeServerDir: configuration.activeServerDir,
      serverUrl: configuration.serverUrl,
      apiServerUrl: configuration.apiServerUrl,
      clientEncryptionRequirement: configuration.clientEncryptionRequirement,
    };
    Object.assign(configuration, {
      happyHomeDir: directory,
      settingsFile: join(directory, 'settings.json'),
      activeServerDir: directory,
      serverUrl: 'https://standalone-provider.example.test',
      apiServerUrl: 'https://standalone-provider.example.test',
      clientEncryptionRequirement: 'follow_account',
    });
    // Credential storage and HTTP are system boundaries; contribution admission,
    // settings bootstrap and feature policy remain real.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token: 'standalone-test', encryption: null });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { version: 1, content: { t: 'plain', v: {} } } });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
      features: { providers: { enabled: true } }, capabilities: {},
    })));
    try {
      const deps = await resolveProviderCliDependencies();
      const snapshot = await deps.loadSnapshot();
      expect(snapshot.machineId).toBeTruthy();
      expect([...snapshot.registry.providersByContributionKey.values()])
        .toEqual(expect.arrayContaining([expect.objectContaining({ pluginId: 'happier.provider.deepseek' })]));
      // A declaration projection does not fabricate executable currentness.
      expect(snapshot.registry.runtimeRegistryGeneration).toBeUndefined();
    } finally {
      Object.assign(configuration, original);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
