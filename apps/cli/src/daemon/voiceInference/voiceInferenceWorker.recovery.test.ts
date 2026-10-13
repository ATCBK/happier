import { describe, expect, it, vi } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import { createDaemonPublicVoiceModelPackRuntime } from './publicModelPacks/runtime';
import { startVoiceInferenceWorker } from './voiceInferenceWorker';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';

// Native ESM exports are immutable; expose only this OS leaf as a call-through
// spy while preserving every filesystem operation and all recovery owners.
vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>();
  return { ...native, readdir: vi.fn(native.readdir) };
});

describe('voice inference worker recovery ordering', () => {
  it('awaits public pack convergence before constructing an observable worker', async () => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    const home = await fsPromises.mkdtemp(join(tmpdir(), 'happier-worker-recovery-'));
    envScope.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const paths = resolveVoiceInferencePaths();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const { readdir: realReadDirectory } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    // Only the exact model root's filesystem read is held. Public promotion
    // convergence and the worker's startup gate both remain canonical.
    vi.mocked(fsPromises.readdir).mockImplementation((async (...args: Parameters<typeof fsPromises.readdir>) => {
      if (String(args[0]) === paths.packsRootDir) {
        markEntered();
        await gate;
      }
      return await realReadDirectory(...args);
    }) as typeof fsPromises.readdir); // Preserve the native SDK's overloaded signatures.
    const publicModelPacks = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'recovery-account', machineId: 'recovery-machine', happyHomeDir: configuration.happyHomeDir, paths,
    });
    let started = false;
    const workerPromise = startVoiceInferenceWorker({
      publicModelPacks,
      runtimeLoader: async () => null,
    }).then((worker) => {
      started = true;
      return worker;
    });
    try {
      // A wrong owner/path must fail on actual premature observability, not
      // hang waiting for a mocked method call that a frozen runtime cannot expose.
      await Promise.race([
        entered,
        workerPromise.then(() => { throw new Error('worker became observable before canonical pack convergence'); }),
      ]);
      expect(fsPromises.readdir).toHaveBeenCalledWith(paths.packsRootDir);
      expect(started).toBe(false);

      release();
      const worker = await workerPromise;
      expect(started).toBe(true);
      await worker.stop();
    } finally {
      release();
      await workerPromise.then((worker) => worker.stop());
      vi.mocked(fsPromises.readdir).mockImplementation(realReadDirectory);
      vi.restoreAllMocks();
      envScope.restore();
      reloadConfiguration();
      await fsPromises.rm(home, { recursive: true, force: true });
    }
  });
});
