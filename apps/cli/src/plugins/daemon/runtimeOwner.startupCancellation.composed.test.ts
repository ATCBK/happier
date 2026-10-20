import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { waitForCondition } from '@/testkit/async/waitFor';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';

import { createPackedTestConnectedAccountsRuntime } from './packedTestConnectedAccounts';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

const processBoundary = vi.hoisted(() => ({ spawn: vi.fn<typeof import('node:child_process').spawn>() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  processBoundary.spawn.mockImplementation(actual.spawn);
  return { ...actual, spawn: processBoundary.spawn };
});

it('cancels real source preparation before publishing the initial daemon registry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-daemon-registry-cancel-'));
  const pendingHelper = join(home, 'pending-preparation.mjs');
  await writeFile(pendingHelper, "process.stdout.write('preparation-pending\\n'); setInterval(() => {}, 1000);\n");
  const env = createEnvKeyScope(['VITEST', 'VITEST_WORKER_ID', 'NODE_ENV']);
  const controller = createPluginReloadController({ happyHomeDir: home });
  const cancellation = new AbortController();
  const helpers: ChildProcess[] = [];
  const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  let releasing = false;
  let preparationPending = false;
  let published = false;
  let settled = false;
  // Substitute the repository preparation OS process only. Registry discovery,
  // activation, readiness, publication and disposal all use their real owners.
  processBoundary.spawn.mockImplementation((command, args, options) => {
    if (Array.isArray(args) && String(args[0]).endsWith('/scripts/syncSharedDepsForDev.mjs')) {
      const child = spawn(command, releasing ? ['-e', 'process.exit(0)'] : [pendingHelper], options);
      helpers.push(child);
      child.stdout?.once('data', () => { preparationPending = true; });
      return child;
    }
    return spawn(command, args, options);
  });
  const owner = createDaemonPluginRuntimeOwner({
    happyHomeDir: home,
    staleCandidateCleanup: 'disabled',
    reloadController: controller,
    connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir: home, pluginId: 'test.startup' }).owner,
    onInitialRegistryPublished: () => { published = true; },
    signal: cancellation.signal,
  });
  env.patch({ VITEST: undefined, VITEST_WORKER_ID: undefined, NODE_ENV: 'development' });
  const initialization = owner.initialize();
  const outcome = initialization.then(
    () => { settled = true; return 'ready'; },
    (error: unknown) => { settled = true; return error; },
  );
  try {
    await waitForCondition(() => preparationPending, { timeoutMs: 15_000, label: 'initial registry source preparation pending' });
    cancellation.abort();
    await waitForCondition(() => settled, { timeoutMs: 5_000, label: 'initial registry cancellation settled' });
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(published).toBe(false);
    expect(controller.getState().activeRegistry).toBeNull();
    for (const child of helpers) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally {
    releasing = true;
    cancellation.abort();
    for (const child of helpers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await outcome;
    env.restore();
    processBoundary.spawn.mockImplementation(spawn);
    await owner.changeService.shutdown();
    await controller.shutdown();
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);
