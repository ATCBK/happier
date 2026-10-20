import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { isExecutionRunHostRuntime } from '../bridges/executionRun/executionRunHostRuntime';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const QWEN_BACKEND_ID = 'qwen';
const QWEN_PLUGIN_ID = 'happier.agent.qwen';

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

describe('engineRegistry (qwen runtimeCore)', () => {
  it('resolves the bundled Qwen ACP plugin runtimeCore through production dispatch', async () => {
    const qwenShimDir = await mkdtemp(join(os.tmpdir(), 'happier-qwen-runtime-core-'));
    const qwenShimPath = join(qwenShimDir, 'qwen');
    const previousQwenPath = process.env.HAPPIER_QWEN_PATH;
    let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;

    try {
      await writeFile(qwenShimPath, '#!/bin/sh\nexit 0\n');
      await chmod(qwenShimPath, 0o755);
      process.env.HAPPIER_QWEN_PATH = qwenShimPath;
      fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
        contributes: createResolvedContributionRegistry(resolveBuiltInContributions()), pluginIds: [QWEN_PLUGIN_ID],
      } });

      const resolution = await resolveBackendEngineAdapterResolution('qwen', {
        runtimeRegistry: fixture.registry,
      });

      expect(resolution).toMatchObject({
        backendId: 'qwen',
        agentId: 'qwen',
        selectedSource: 'plugin',
        backend: {
          pluginId: 'happier.agent.qwen',
          daemonEntryPath: '@happier-dev/plugins-qwen',
        },
      });

      const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
        credentials: createTestCredentials(),
        directory: '/tmp/qwen',
        permissionMode: 'safe-yolo',
      });

      expect(plan).toMatchObject({
        kind: 'hostSessionRuntimePlan',
        agentId: 'qwen',
        config: {
          backendDisplayName: 'Qwen Code',
          providerName: 'Qwen Code',
          agentMessageType: 'qwen',
        },
      });
      expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));

      const executionRunRuntime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
        runId: 'qwen-runtime-core',
        start: { intent: 'delegate' },
        scope: 'detached',
        backendId: QWEN_BACKEND_ID,
        cwd: '/tmp/qwen',
        permissionMode: 'read_only',
        accountSettings: null,
      });

      expect(isExecutionRunHostRuntime(executionRunRuntime)).toBe(true);
      await expect(executionRunRuntime.readResumeSupport()).resolves.toBe(true);
    } finally {
      await fixture?.dispose();
      if (previousQwenPath === undefined) {
        delete process.env.HAPPIER_QWEN_PATH;
      } else {
        process.env.HAPPIER_QWEN_PATH = previousQwenPath;
      }
      await rm(qwenShimDir, { recursive: true, force: true });
    }
  });
});
