import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { createProbeTempDir } from './agentModelsProbe.testkit';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { withAgentPreflightCatalog } from './withAgentPreflightCatalog';

describe('probeAgentModelsBestEffort (pi preflight)', () => {
  it('consumes structured models on stderr through the admitted Pi preflight contribution', async () => {
    const fixture = await createProbeTempDir('happier-pi-cli-list-models');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const scriptPath = join(binDir, 'pi.cjs');
    await writeFile(scriptPath, `
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('1.0.0\\n'); process.exit(0); }
if (args[0] === '--mode' && args[1] === 'json' && args.includes('--no-session') && args.includes('--extension')) {
  process.stderr.write('Pi diagnostic before catalog\\n');
  process.stderr.write(JSON.stringify({ type: 'happier-pi-model-catalog', models: [
    { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4', reasoning: true },
    { provider: 'anthropic', id: 'claude-3-7-sonnet-latest', name: 'Claude 3.7 Sonnet', reasoning: true },
  ] }) + '\\n');
  process.exit(0);
}
process.exit(1);
`);
    const piPath = await writeExecutableShim({ dir: binDir,
      fileName: process.platform === 'win32' ? 'pi.cmd' : 'pi',
      contents: process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    });

    const prevPath = process.env.PATH;
    const prevOverride = process.env.HAPPIER_PI_PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_PI_PATH = piPath;
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    try {
      runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { pluginIds: ['happier.agent.pi'] },
      });
      const { probeAgentModelsBestEffort } = await import('./agentModelsProbe');

      const result = await withAgentPreflightCatalog({ agentId: 'pi' }, async context =>
        await probeAgentModelsBestEffort({ agentId: 'pi', cwd: fixture.dir, timeoutMs: 2_000,
          catalogEntry: context.catalogEntry, runtimeCacheKey: context.runtimeCacheKey }));
      expect(result.source).toBe('dynamic');
      const ids = result.availableModels.map((m) => m.id);
      expect(ids).toContain('openai-codex/gpt-5.4');
      expect(ids).toContain('anthropic/claude-3-7-sonnet-latest');
    } finally {
      await runtime?.dispose();
      process.env.PATH = prevPath;
      if (typeof prevOverride === 'string') {
        process.env.HAPPIER_PI_PATH = prevOverride;
      } else {
        delete process.env.HAPPIER_PI_PATH;
      }
      await fixture.cleanup();
    }
  }, 60_000);
});
