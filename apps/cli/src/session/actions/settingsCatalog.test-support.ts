import { delimiter, join } from 'node:path';
import { vi } from 'vitest';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

/** Native process/auth is the boundary; model facts and catalog admission stay real. */
export async function createSignedInSummaryCatalogFixture() {
  const home = createTempDirSync('settings-summary-native-');
  const fileName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  writeExecutableShimSync({ dir: home, fileName, contents: process.platform === 'win32'
    ? '@echo off\r\nif "%1"=="--version" (echo 2.1.0 & exit /b 0)\r\necho {"loggedIn":true}\r\n'
    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.1.0; else echo \'{"loggedIn":true}\'; fi\n' });
  for (const key of ['HOME', 'USERPROFILE', 'HAPPIER_HOME_DIR']) vi.stubEnv(key, home);
  vi.stubEnv('HAPPIER_CLAUDE_PATH', join(home, fileName));
  vi.stubEnv('PATH', `${home}${delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('ANTHROPIC_API_KEY', undefined);
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
  vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
  try {
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
    return { ...runtime, async dispose() {
      try { await runtime.dispose(); } finally { vi.unstubAllEnvs(); removeTempDirSync(home); }
    } };
  } catch (error) {
    vi.unstubAllEnvs();
    removeTempDirSync(home);
    throw error;
  }
}
