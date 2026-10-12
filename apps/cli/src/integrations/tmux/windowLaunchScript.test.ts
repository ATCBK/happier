import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareTmuxWindowLaunch } from './windowLaunchScript';
import { logger } from '@/ui/logger';
import { createHerdrLaunchSpec } from '../herdr/launchSpec';
import { getHappierTempDirOwnerPath } from '@happier-dev/cli-common/tempDirs';

const writeBoundary = vi.hoisted((): { failure: Error | null; directory: string } => ({ failure: null, directory: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (writeBoundary.failure && /[/\\](?:tmux-window|terminal-launch)-/.test(String(args[0]))) {
        writeBoundary.directory = dirname(String(args[0]));
        await fs.writeFile(join(writeBoundary.directory, 'unexpected'), 'retained');
        throw writeBoundary.failure;
      }
      return fs.writeFile(...args);
    },
  };
});

const execFileAsync = promisify(execFile);

describe('prepareTmuxWindowLaunch', () => {
  it.each(['tmux', 'herdr'])('retains write failure and marks incomplete cleanup before native creation (%s)', async (host) => {
    const writeFailure = Object.assign(new Error('fixture write failed'), { code: 'EACCES' });
    // Only the OS file-write boundary fails; the real private artifact owner runs.
    writeBoundary.failure = writeFailure;
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => undefined);
    try {
      const preparation = host === 'tmux'
        ? prepareTmuxWindowLaunch({ args: ['native'], env: {}, unsetEnvKeys: [], readySignal: 'write-failed' })
        : createHerdrLaunchSpec({ workingDirectory: '/tmp', spawnArgv: ['native'], spawnEnv: {} });
      await expect(preparation).rejects.toMatchObject({
        creationDisposition: 'not_created', cleanupIncomplete: true, cause: writeFailure,
        errors: [writeFailure, expect.objectContaining({ code: 'ENOTEMPTY' })],
      });
      await expect(readFile(join(writeBoundary.directory, 'unexpected'), 'utf8')).resolves.toBe('retained');
    } finally {
      writeBoundary.failure = null;
      diagnostic.mockRestore();
      if (writeBoundary.directory) {
        await unlink(join(writeBoundary.directory, 'unexpected'));
        await rmdir(writeBoundary.directory);
        await unlink(getHappierTempDirOwnerPath(writeBoundary.directory));
        writeBoundary.directory = '';
      }
    }
  });
  it.skipIf(process.platform === 'win32')('reports exact cleanup failure without recursively removing unexpected content', async () => {
    const prepared = await prepareTmuxWindowLaunch({ args: ['native'], env: {}, unsetEnvKeys: [], readySignal: 'cleanup-test' });
    // Let the genuine shell decode the OS launch argv, not a second shell parser.
    const { stdout } = await execFileAsync('/bin/sh', ['-c', `printf '%s\\n' ${prepared.command}`]);
    const scriptPath = stdout.trim().split('\n')[1]!;
    const directory = dirname(scriptPath);
    const unexpected = join(directory, 'unexpected');
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => undefined);
    try {
      await writeFile(unexpected, 'retained');
      await expect(prepared.cleanup()).rejects.toMatchObject({ code: 'ENOTEMPTY' });
      await expect(readFile(unexpected, 'utf8')).resolves.toBe('retained');
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('tmux_launch_cleanup_incomplete'));
    } finally {
      diagnostic.mockRestore();
      await unlink(unexpected).catch(() => undefined);
      await unlink(scriptPath).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
      await unlink(getHappierTempDirOwnerPath(directory)).catch(() => undefined);
    }
  });

  const testDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  async function createTmuxHelper(body: string): Promise<Readonly<{ directory: string; path: string }>> {
    const directory = await mkdtemp(join(tmpdir(), 'happier-tmux-helper-test-'));
    testDirectories.push(directory);
    const path = join(directory, 'tmux');
    await writeFile(path, `#!/bin/sh\n${body}\n`, { encoding: 'utf8', mode: 0o700 });
    await chmod(path, 0o700);
    return { directory, path };
  }

  it('does not execute the target when the readiness signal fails', async () => {
    const helper = await createTmuxHelper('exit 23');
    const targetMarker = join(helper.directory, 'target-executed');
    const prepared = await prepareTmuxWindowLaunch({
      args: ['/bin/sh', '-c', `printf executed > ${JSON.stringify(targetMarker)}`],
      env: { PROVIDER_SECRET: 'provider-secret' },
      unsetEnvKeys: [],
      readySignal: 'ready-failure-test',
    });

    await expect(execFileAsync('/bin/sh', ['-c', prepared.command], {
      env: { ...process.env, PATH: `${helper.directory}:${process.env.PATH ?? ''}` },
    })).rejects.toMatchObject({ code: 23 });
    await expect(access(targetMarker)).rejects.toBeDefined();
    await prepared.cleanup();
  });

  it('unsets owned inherited keys before readiness and exports provider values only after readiness succeeds', async () => {
    const helper = await createTmuxHelper(`
if [ "\${OWNED_NATIVE_KEY+x}" = x ]; then
  printf inherited > "$READINESS_OBSERVATION"
else
  printf unset > "$READINESS_OBSERVATION"
fi
exit 0
`.trim());
    const readinessObservation = join(helper.directory, 'readiness-observation');
    const targetObservation = join(helper.directory, 'target-observation');
    const prepared = await prepareTmuxWindowLaunch({
      args: [
        '/bin/sh',
        '-c',
        'printf "%s|%s" "$PROVIDER_SECRET" "${OWNED_NATIVE_KEY-unset}" > "$TARGET_OBSERVATION"',
      ],
      env: {
        PROVIDER_SECRET: 'provider-secret',
        TARGET_OBSERVATION: targetObservation,
      },
      unsetEnvKeys: ['OWNED_NATIVE_KEY'],
      readySignal: 'ready-isolation-test',
    });

    await execFileAsync('/bin/sh', ['-c', prepared.command], {
      env: {
        ...process.env,
        PATH: `${helper.directory}:${process.env.PATH ?? ''}`,
        OWNED_NATIVE_KEY: 'ambient-native-secret',
        READINESS_OBSERVATION: readinessObservation,
      },
    });

    await expect(readFile(readinessObservation, 'utf8')).resolves.toBe('unset');
    await expect(readFile(targetObservation, 'utf8')).resolves.toBe('provider-secret|unset');
    await prepared.cleanup();
  });
});
