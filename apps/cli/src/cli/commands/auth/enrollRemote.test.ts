import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';

describe('prepareRemoteEnrollmentHomeTarget', () => {
  let envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
  ] as const);

  afterEach(() => {
    envScope.restore();
    reloadConfiguration();
    envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL',
      'HAPPIER_PUBLIC_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_ACTIVE_SERVER_ID',
    ] as const);
    vi.resetModules();
  });

  it('persists released remote public, local, and webapp route facts on one remote Home profile', async () => {
    await withTempDir('happier-cli-remote-enrollment-profile-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });
      reloadConfiguration();
      const { prepareRemoteEnrollmentHomeTarget } = await import('./enrollRemote');
      const prepared = await prepareRemoteEnrollmentHomeTarget({
        kind: 'https_url',
        url: 'https://public-home.example.test',
        localUrl: 'http://127.0.0.1:3010',
        webappUrl: 'https://app.example.test',
      });

      expect(prepared.target).toMatchObject({
        profileId: prepared.profileId,
        canonicalAuthUrl: 'https://public-home.example.test',
        applicationUrl: 'http://127.0.0.1:3010',
        webappUrl: 'https://app.example.test',
      });
      const settings = JSON.parse(await readFile(join(homeDir, 'settings.json'), 'utf8')) as {
        activeServerId?: string;
        servers?: Record<string, { serverUrl?: string; localServerUrl?: string; webappUrl?: string }>;
      };
      expect(settings.activeServerId).not.toBe(prepared.profileId);
      expect(settings.servers?.[prepared.profileId]).toMatchObject({
        serverUrl: 'https://public-home.example.test',
        localServerUrl: 'http://127.0.0.1:3010',
        webappUrl: 'https://app.example.test',
      });
    });
  }, 60_000);
});
