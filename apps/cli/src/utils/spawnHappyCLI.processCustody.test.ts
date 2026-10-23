import { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpawnHappyCliEnvScope, withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';
import { buildHappyCliSubprocessLaunchSpec, spawnHappyCLI } from './spawnHappyCLI';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
// The OS spawn is the only replaced boundary; invocation and custody planning stay real.
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(), spawn,
}));

describe('spawnHappyCLI process custody', () => {
  const envScope = createSpawnHappyCliEnvScope();
  afterEach(() => { envScope.restore(); spawn.mockReset(); });

  it('contains the resolved binary-safe CLI invocation in the service Job carrier', async () => {
    spawn.mockReturnValue(new ChildProcess());
    await withTempHappyCliEntrypoint(async (entrypoint) => {
      envScope.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint });
      const custody = {
        executablePath: 'C:\\Happier\\happier-process-custody.exe',
        jobName: 'Local\\happier-background-worker', handshakePath: 'C:\\Temp\\worker-handshake.json',
      };
      const args = ['daemon', 'background-service-worker'];
      const resolved = buildHappyCliSubprocessLaunchSpec(args);
      spawnHappyCLI(args, { stdio: 'pipe' }, { processCustody: custody });
      expect(spawn.mock.calls[0]?.[0]).toBe(custody.executablePath);
      expect(spawn.mock.calls[0]?.[1]).toEqual([
        'run', `--job=${custody.jobName}`, `--handshake=${custody.handshakePath}`,
        '--', resolved.filePath, ...resolved.args,
      ]);
    });
  });
});
