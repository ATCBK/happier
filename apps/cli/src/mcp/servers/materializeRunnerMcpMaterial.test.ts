import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEphemeralRunnerLocalState } from '@/ephemeralRunner/localState';
import { materializeRunnerMcpMaterial } from './materializeRunnerMcpMaterial';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('materializeRunnerMcpMaterial', () => {
  it('keeps remote credentials in an activation-local sealed sidecar and removes them with Runner custody', async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), 'happier-runner-mcp-test-'));
    roots.push(parentDirectory);
    const state = await createEphemeralRunnerLocalState({
      activationId: 'activation-mcp',
      parentDirectory,
      baseEnvironment: {},
    });

    const materialized = await materializeRunnerMcpMaterial({
      material: {
        v: 1,
        strictMode: true,
        capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
        servers: [{
          serverId: 'remote', serverRevision: 2, bindingId: 'all', bindingRevision: 4,
          savedSecretRevisions: [],
          config: {
            id: 'remote', name: 'remote', transport: 'http',
            remote: {
              url: 'https://mcp.example.test',
              headers: { Authorization: { t: 'literal', v: 'Bearer activation-secret' } },
            },
            env: {}, createdAt: 1, updatedAt: 2,
          },
        }],
      },
      directory: '/workspace',
      processEnv: state.environment,
      tmpDir: join(state.homeDirectory, 'tmp'),
    });

    const runtimeConfig = materialized.remote;
    expect(runtimeConfig).toBeDefined();
    expect(JSON.stringify(runtimeConfig)).not.toContain('activation-secret');
    const sidecarPath = runtimeConfig?.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE;
    expect(sidecarPath).toEqual(expect.stringContaining(state.homeDirectory));
    expect(await readFile(sidecarPath!, 'utf8')).toContain('activation-secret');
    if (process.platform !== 'win32') {
      expect((await stat(sidecarPath!)).mode & 0o777).toBe(0o600);
    }

    await state.dispose();
    await expect(access(sidecarPath!)).rejects.toBeDefined();
  });
});
