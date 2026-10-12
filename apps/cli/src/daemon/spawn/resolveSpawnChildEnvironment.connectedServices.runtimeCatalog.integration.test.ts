import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY } from '@/agent/runtime/sessionConnectedServicesBindingsEnv';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import '@/agent/runtime/registry/engineRegistry/runtimeCore';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({
    runtimeOptions: { pluginIds: ['happier.agent.claude'] },
  });
});
afterAll(async () => { await runtime?.dispose(); });

describe('resolveSpawnChildEnvironment (connected services)', () => {
  it('removes selected-purpose inherited keys from the actual child while native launches retain them', async () => {
    const inherited = {
      AGY_ACP_CCPA_BASE_URL: 'https://native.example',
      agy_acp_ccpa_project: 'native-project',
      GOOGLE_APPLICATION_CREDENTIALS: 'native-google',
      XDG_CACHE_HOME: 'user-cache',
    };
    const readChild = async (connected: boolean) => {
      const result = await resolveSpawnChildEnvironment({
        options: { directory: '.', environmentVariables: {} },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        processEnv: inherited, logDebug() {}, logInfo() {}, logWarn() {},
        connectedServiceAuth: connected ? {
          env: {}, cleanupOnFailure: null, cleanupOnExit: null,
          unsetEnvKeys: ['AGY_ACP_CCPA_BASE_URL', 'AGY_ACP_CCPA_PROJECT'],
        } : null,
      });
      if (!result.ok) throw new Error(result.errorCode);
      const output = execFileSync(process.execPath, ['-e',
        'process.stdout.write(JSON.stringify(process.env))',
      ], { env: buildScopedProcessEnv({
        baseEnv: inherited, explicitEnv: result.extraEnvForChild,
        unsetEnvKeys: result.unsetEnvKeys,
      }), encoding: 'utf8' });
      return JSON.parse(output) as Record<string, string>;
    };
    const connected = await readChild(true);
    expect(connected).not.toHaveProperty('AGY_ACP_CCPA_BASE_URL');
    expect(connected).not.toHaveProperty('agy_acp_ccpa_project');
    expect(connected).toMatchObject({ GOOGLE_APPLICATION_CREDENTIALS: 'native-google', XDG_CACHE_HOME: 'user-cache' });
    expect(await readChild(false)).toMatchObject(inherited);
  });

  it('injects connected service materialization env when provided', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { XDG_DATA_HOME: '/tmp/xdg' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expandedEnvironmentVariables.XDG_DATA_HOME).toBe('/tmp/xdg');
    }
  });

  it('exports validated connected service bindings for session metadata seeding', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'happier',
          },
        },
      },
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { CODEX_HOME: '/tmp/codex-connected-home' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.extraEnvForChild[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY]!)).toEqual(
        options.connectedServices,
      );
    }
  });

  it('keeps connected service cleanup hooks when connected auth is used', async () => {
    const connectedCleanups: string[] = [];
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { XDG_DATA_HOME: '/tmp/xdg' },
        cleanupOnFailure: () => {
          connectedCleanups.push('failure');
        },
        cleanupOnExit: () => {
          connectedCleanups.push('exit');
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.cleanupOnExit).not.toBeNull();
    result.cleanupOnExit?.();
    expect(connectedCleanups).toEqual(['exit']);
  });

  it('propagates connected-service materialization diagnostics for downstream tracked-session visibility', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
    };
    const diagnostics = [{
      code: 'state_sharing_degraded',
      providerId: 'claude',
      serviceId: 'anthropic',
      requestedStateMode: 'shared',
      effectiveStateMode: 'isolated',
      reason: 'provider_state_unavailable',
    }] as const;

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { XDG_DATA_HOME: '/tmp/xdg' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
        diagnostics,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.materializationDiagnostics).toEqual(diagnostics);
    }
  });

  it('fails closed when profile env references connected service env injected for the child', async () => {
    const agent = runtime.registry.contributes.agents.find((entry) => entry.pluginId === 'happier.agent.claude');
    if (!agent) throw new Error('The real Claude Agent must be admitted for its declared credential inventory');
    expect(runtime.registry.contributes.agentDefinitionsById.get(agent.id)?.cliMetadata?.auth.environmentVariables)
      .toContain('ANTHROPIC_API_KEY');
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
    };

    const result = await resolveSpawnChildEnvironment({
      resolvedAgentId: agent.id, pluginRuntimeRegistry: runtime.registry,
      options,
      profileEnvironmentVariables: {
        ANTHROPIC_API_KEY: '${INJECTED_CONNECTED_AUTH}',
      },
      daemonSpawnHooks: null,
      // Resolve an owned executable at the genuine OS boundary. No Agent is
      // started: the unresolved credential must reject before child launch.
      processEnv: { HAPPIER_CLAUDE_PATH: process.execPath },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { INJECTED_CONNECTED_AUTH: 'fixture-connected-secret' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED);
    expect(result.errorMessage).toContain('ANTHROPIC_API_KEY references ${INJECTED_CONNECTED_AUTH}');
  });
});
