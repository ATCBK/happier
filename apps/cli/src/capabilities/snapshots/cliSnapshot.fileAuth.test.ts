import { afterEach, expect, it, vi } from 'vitest';
import * as cliProcess from '@happier-dev/cli-common/process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createDeferred } from '@/testkit/async/deferred';
import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { reloadConfiguration } from '@/configuration';
import { detectCliSnapshotOnDaemonPath, invalidateCliSnapshots } from './cliSnapshot';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateCliSnapshots();
  reloadConfiguration();
});

// The canonical Vitest per-file isolation keeps this manifest/file-auth path
// separate from cliSnapshot.test.ts's admitted native-command auth runtime.
it.skipIf(process.platform === 'win32')('preserves Claude file auth when version probing times out', async () => {
  const fixture = await createProbeTempDir('happier-cliSnapshot-file-auth');
  try {
    const binDir = join(fixture.dir, 'bin');
    const homeDir = join(fixture.dir, 'home');
    const credentialsDir = join(homeDir, '.claude');
    await mkdir(binDir, { recursive: true });
    await mkdir(credentialsDir, { recursive: true });
    const claudePath = join(binDir, 'claude');
    await writeExecutableScript(claudePath, '#!/bin/sh\necho "2.0.70 (Claude Code)"\n');
    await writeFile(join(credentialsDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'claude-access-token',
        refreshToken: 'claude-refresh-token',
        expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      },
      oauthAccount: { emailAddress: 'tester@example.com' },
    }), 'utf8');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);
    vi.stubEnv('HAPPIER_HOME_DIR', homeDir);
    vi.stubEnv('PATH', binDir);
    vi.stubEnv('HAPPIER_CLAUDE_PATH', undefined);
    vi.stubEnv('HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON', undefined);
    vi.stubEnv('HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS', undefined);
    vi.stubEnv('HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS', undefined);
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
    reloadConfiguration();
    invalidateCliSnapshots();

    // Only the OS process boundary is controlled; file parsing, catalog and auth
    // logic remain real. No 25-ms wall-clock race with their readiness.
    const versionStarted = createDeferred();
    const versionProbe = createDeferred<Awaited<ReturnType<typeof cliProcess.execFileWithDeadline>>>();
    const realExecFile = cliProcess.execFileWithDeadline;
    vi.spyOn(cliProcess, 'execFileWithDeadline').mockImplementation((command, args, options) => {
      if (command !== claudePath || args.length !== 1 || !['--version', 'version', '-v'].includes(args[0] ?? '')) {
        return realExecFile(command, args, options);
      }
      versionStarted.resolve();
      return versionProbe.promise;
    });
    const pendingSnapshot = detectCliSnapshotOnDaemonPath({
      includeLoginStatus: true, requestedCliNames: ['claude'], bypassCache: true,
    });
    await versionStarted.promise;
    versionProbe.reject(Object.assign(new Error('Version probe timed out'), {
      killed: true, signal: 'SIGTERM', stdout: '', stderr: '',
    }));
    const snapshot = await pendingSnapshot;
    expect(snapshot.clis.claude.available).toBe(true);
    expect(snapshot.clis.claude.resolvedPath).toBe(claudePath);
    expect(snapshot.clis.claude.version).toBeUndefined();
    expect(snapshot.clis.claude.isLoggedIn).toBe(true);
    expect(snapshot.clis.claude.authStatus).toMatchObject({
      state: 'logged_in', method: 'credentials_file', source: 'file',
    });
  } finally {
    await fixture.cleanup();
  }
});
