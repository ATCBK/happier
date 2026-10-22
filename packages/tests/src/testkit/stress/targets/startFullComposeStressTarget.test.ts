import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearRegisteredRuntimeSecretValues, REDACTED_SECRET_PLACEHOLDER } from '../../artifactSecretSafety';
import type { StressConfig } from '../config/stressScenarioSchema';
import { startFullComposeStressTarget } from './startFullComposeStressTarget';

const config: StressConfig = {
  targetMode: 'full-compose',
  baseUrl: undefined,
  repeat: 1,
  seed: 42,
  flakeRetry: false,
  socketTransport: 'websocket',
  duration: {
    warmupMs: 1000,
    durationMs: 10000,
    cooldownMs: 1000,
    soakMs: 0,
  },
  load: {
    users: 25,
    machinesPerUser: 1,
    sessionsPerUser: 1,
    rpcListenersPerUser: 1,
    rpcCallsPerSecond: 2,
    messagesPerSecond: 5,
    reconnectRate: 0,
    mixedSessionMode: 'representative',
  },
  orchestration: {
    rollingRestartEnabled: true,
    killTarget: 'api',
    expectedApiReplicas: 3,
    expectedWorkerReplicas: 2,
  },
  compose: {
    apiReplicas: 3,
    workerReplicas: 2,
    imageBuildStrategy: 'if-missing',
    reuseRunningTopology: false,
    frontDoorMode: 'gateway',
    gatewayPort: undefined,
    apiDirectPort: undefined,
    postgresPort: undefined,
    redisPort: undefined,
    minioPort: undefined,
    minioConsolePort: undefined,
    metricsEnabled: true,
    filesBackend: 's3',
  },
  artifacts: {
    saveArtifactsOnSuccess: false,
    metricsScrapeEnabled: true,
    keepTopologyOnFailure: false,
    summaryOutputPath: undefined,
  },
};

describe('startFullComposeStressTarget', () => {
  it('renders the canonical topology files, launches compose, and returns resolved metadata', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const waitForComposeRpcGatewayReadiness = vi.fn(async () => {});
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      attestServicesUseImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      stopContainer: vi.fn(async () => {}),
      killContainer: vi.fn(async () => {}),
      disconnectContainerFromNetwork: vi.fn(async () => {}),
      connectContainerToNetwork: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
        repoRoot: '/repo/comparison-side',
        captureSqlStatements: true,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness,
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(runtime.buildServerImage).toHaveBeenCalledWith(
      'happier-stress-compose-server-repo-fingerprint-current-fingerprint',
      expect.objectContaining({
        labels: expect.objectContaining({
          'happier.stress.owner': 'stress-harness',
          'happier.stress.image-fingerprint': expect.any(String),
          'happier.stress.repo-root': expect.any(String),
        }),
      }),
    );
    expect(runtime.buildServerImage.mock.invocationCallOrder[0]).toBeLessThan(runtime.up.mock.invocationCallOrder[0]);
    expect(runtime.up).toHaveBeenCalledWith({ apiReplicas: 3, workerReplicas: 2 });
    expect(runtime.attestServicesUseImage).toHaveBeenCalledWith({
      services: ['api', 'worker'],
      imageName: 'happier-stress-compose-server-repo-fingerprint-current-fingerprint',
      expectedLabels: {
        'happier.stress.owner': 'stress-harness',
        'happier.stress.repo-root': 'repo-fingerprint',
        'happier.stress.image-fingerprint': 'current-fingerprint',
      },
    });
    expect(waitForComposeRpcGatewayReadiness).toHaveBeenCalledWith({
      attempts: 1,
      baseUrl: 'http://127.0.0.1:43080',
    });
    expect(result.mode).toBe('full-compose');
    expect(result.baseUrl).toBe('http://127.0.0.1:43080');
    expect(result.topology.composeProjectName).toContain('happier-stress-');
    expect(result.topology.resolvedApiReplicas).toBe(3);
    expect(result.topology.resolvedWorkerReplicas).toBe(2);
    expect(result.testRuntime?.peerMediation.allowedPorts).toEqual([3000]);
    expect(result.testRuntime?.peerMediation.routeGrantSigning.keyId).toBe('stress-route-grant');
    expect(result.testRuntime?.peerMediation.routeGrantSigning.privateKeySeedBase64Url).toEqual(
      expect.any(String),
    );
    expect(result.testRuntime?.peerMediation.routeGrantSigning.publicKeyBase64Url).toEqual(
      expect.any(String),
    );
    expect(Object.keys(result)).not.toContain('testRuntime');
    expect(JSON.stringify(result)).not.toContain(
      result.testRuntime?.peerMediation.routeGrantSigning.privateKeySeedBase64Url
        ?? 'missing-relay-key',
    );

    const composePath = join(testDir, 'topology', 'docker-compose.yml');
    const nginxPath = join(testDir, 'topology', 'nginx.conf');
    const generatedEnvPath = join(testDir, 'topology', 'env.generated.json');
    const generatedDockerfilePath = join(testDir, 'topology', 'Dockerfile.server-stress.generated');

    const composeYaml = readFileSync(composePath, 'utf8');
    expect(composeYaml).toContain('context: /repo/comparison-side');
    expect(composeYaml).toContain('shared_preload_libraries=pg_stat_statements');
    expect(runtime.execCapture).toHaveBeenCalledWith('postgres', expect.arrayContaining(['CREATE EXTENSION IF NOT EXISTS pg_stat_statements']));
    expect(runtime.buildServerImage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ contextDir: '/repo/comparison-side' }));
    expect(composeYaml).toContain('gateway:');
    expect(composeYaml).toContain('HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1"');
    expect(composeYaml).not.toContain(
      result.testRuntime?.peerMediation.routeGrantSigning.privateKeySeedBase64Url ?? 'missing-relay-key',
    );
    expect(composeYaml).toContain('HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY:');
    expect(readFileSync(generatedEnvPath, 'utf8')).not.toContain(
      result.testRuntime?.peerMediation.routeGrantSigning.privateKeySeedBase64Url ?? 'missing-relay-key',
    );
    expect(readFileSync(nginxPath, 'utf8')).toContain('location /v1/updates');
    const generatedDockerfile = readFileSync(generatedDockerfilePath, 'utf8');
    expect(generatedDockerfile).toContain('COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./');
    expect(generatedDockerfile).toContain('COPY patches ./patches');
    expect(generatedDockerfile).toContain(
      'COPY --parents apps/*/package.json packages/*/package.json packages/plugins/*/package.json ./',
    );
    expect(generatedDockerfile).toContain(
      'COPY apps/stack/scripts/utils ./apps/stack/scripts/utils',
    );
    expect(generatedDockerfile).toContain(
      'COPY .github/feature-policy ./.github/feature-policy',
    );
    expect(generatedDockerfile).toContain('COPY scripts/workspaces ./scripts/workspaces');
    expect(generatedDockerfile).toContain('COPY apps/server ./apps/server');
    expect(generatedDockerfile).toContain('COPY packages/agents ./packages/agents');
    expect(generatedDockerfile).toContain('COPY packages/plugin-sdk ./packages/plugin-sdk');
    expect(generatedDockerfile).toContain(
      'COPY packages/plugins/review-coderabbit ./packages/plugins/review-coderabbit',
    );
    expect(generatedDockerfile).toContain(
      'COPY packages/plugins/review-deepsec ./packages/plugins/review-deepsec',
    );
    expect(generatedDockerfile).toContain('resolveWorkspaceDependencyBuildOrder');
    expect(generatedDockerfile).not.toContain('ensureWorkspacePackagesBuiltForComponent');
    expect(generatedDockerfile).not.toContain(
      'RUN pnpm --filter @happier-dev/server run build:shared',
    );
    expect(generatedDockerfile).not.toContain('postinstall:real');
    expect(generatedDockerfile).not.toContain('COPY . .');
    expect(generatedDockerfile).not.toContain('RUN pnpm --filter @happier-dev/server run build:runtime');
    expect(generatedDockerfile).not.toContain(
      'RUN pnpm --filter @happier-dev/server run postinstall:real',
    );
    expect(generatedDockerfile).toContain(
      'RUN pnpm --filter @happier-dev/server run generate:providers',
    );
    expect(generatedDockerfile).toContain(
      'ENV HAPPIER_INSTALL_SCOPE=server,protocol,agents,cli-common,release-runtime',
    );
    expect(generatedDockerfile).toContain('CMD ["/bin/sh", "/repo/apps/server/scripts/run-server.sh"]');
    expect(JSON.parse(readFileSync(generatedEnvPath, 'utf8'))).toMatchObject({
      publicBaseUrl: 'http://127.0.0.1:43080',
      composeProjectName: result.topology.composeProjectName,
      image: {
        name: 'happier-stress-compose-server-repo-fingerprint-current-fingerprint',
        freshnessFingerprint: expect.any(String),
      },
    });

    await result.collectDiagnostics();
    expect(runtime.logs).toHaveBeenCalledTimes(1);
    expect(typeof result.preserveForInspection).toBe('function');

    await result.restartService?.('api');
    expect(runtime.restart).toHaveBeenCalledWith('api');
    expect(waitForComposeRpcGatewayReadiness).toHaveBeenCalledTimes(2);

    expect(await result.admin?.listServiceContainers('api')).toEqual([]);
    const stickyConfigPath = await result.admin?.writeGatewayConfig(
      'sticky.good.nginx.conf',
      'server { listen 8080; }\n',
    );
    expect(stickyConfigPath).toContain('sticky.good.nginx.conf');
    await result.admin?.activateGatewayConfig(stickyConfigPath ?? '');
    expect(runtime.restart).toHaveBeenCalledWith('gateway');

    await result.stop();
    expect(runtime.down).toHaveBeenCalledTimes(1);
  });

  it('can expose a direct api front door for comparison runs when the topology uses a single api replica', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-direct-'));
    const directConfig: StressConfig = {
      ...config,
      orchestration: {
        ...config.orchestration,
        expectedApiReplicas: 1,
      },
      compose: {
        ...config.compose,
        apiReplicas: 1,
        frontDoorMode: 'api-direct',
      },
    };
    const waitForComposeRpcGatewayReadiness = vi.fn(async () => {});
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      attestServicesUseImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      stopContainer: vi.fn(async () => {}),
      killContainer: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config: directConfig,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(43081)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness,
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'api-direct', 'worker', 'gateway'],
          resolvedApiReplicas: 1,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            apiDirect: 43081,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(result.baseUrl).toBe('http://127.0.0.1:43081');
    expect(result.topology.baseUrl).toBe('http://127.0.0.1:43081');
    expect(result.topology.ports.apiDirect).toBe(43081);
    expect(waitForComposeRpcGatewayReadiness).toHaveBeenCalledWith({
      attempts: 1,
      baseUrl: 'http://127.0.0.1:43081',
    });
    expect(runtime.attestServicesUseImage).toHaveBeenCalledWith(expect.objectContaining({
      services: ['api', 'api-direct', 'worker'],
    }));
    expect(JSON.parse(readFileSync(join(testDir, 'topology', 'env.generated.json'), 'utf8'))).toMatchObject({
      publicBaseUrl: 'http://127.0.0.1:43081',
      compose: {
        frontDoorMode: 'api-direct',
      },
      ports: {
        gateway: 43080,
        apiDirect: 43081,
      },
    });
    expect(readFileSync(join(testDir, 'topology', 'docker-compose.yml'), 'utf8')).toContain('api-direct:');
  });

  it('rejects multi-replica api-direct runs because the direct front door publishes only one api container', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-direct-invalid-'));

    await expect(
      startFullComposeStressTarget(
        {
          config: {
            ...config,
            compose: {
              ...config.compose,
              apiReplicas: 4,
              frontDoorMode: 'api-direct',
            },
          },
          testDir,
        },
        {
          repoRootDir: () => '/repo/root',
          createRepoRootFingerprint: () => 'repo-fingerprint',
          computeComposeServerImageFingerprint: () => 'current-fingerprint',
          randomSecret: () => 'secret-token',
          pickAvailablePort: vi.fn(),
          createComposeRuntime: vi.fn(),
          waitForComposeTopology: vi.fn(),
          waitForComposeRpcGatewayReadiness: vi.fn(),
          inspectComposeTopology: vi.fn(),
        } as never,
      ),
    ).rejects.toThrow(/api-direct.*apiReplicas=1/i);
  });

  it('exposes replica metadata and service/container control hooks for failure-mode scenarios', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      stopContainer: vi.fn(async () => {}),
      killContainer: vi.fn(async () => {}),
      startContainer: vi.fn(async () => {}),
      disconnectContainerFromNetwork: vi.fn(async () => {}),
      connectContainerToNetwork: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => ([
        {
          Name: '/happier-stress-run-api-1',
          Config: { Labels: { 'com.docker.compose.service': 'api' } },
          State: { Status: 'running', Health: { Status: 'healthy' } },
          NetworkSettings: {
            Networks: {
              happier: { Aliases: ['api', 'container-1'], IPAddress: '10.10.0.11' },
            },
          },
        },
        {
          Name: '/happier-stress-run-api-2',
          Config: { Labels: { 'com.docker.compose.service': 'api' } },
          State: { Status: 'running', Health: { Status: 'healthy' } },
          NetworkSettings: {
            Networks: {
              happier: { Aliases: ['api', 'container-2'], IPAddress: '10.10.0.12' },
            },
          },
        },
      ])),
      serviceContainerIds: vi.fn(async () => ['container-1', 'container-2']),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    await expect(result.admin?.listServiceContainers('api')).resolves.toEqual([
      {
        id: 'container-1',
        name: 'happier-stress-run-api-1',
        service: 'api',
        state: 'running',
        health: 'healthy',
        ipv4Addresses: ['10.10.0.11'],
        networkAttachments: {
          happier: {
            aliases: ['api', 'container-1'],
            ipv4Address: '10.10.0.11',
          },
        },
      },
      {
        id: 'container-2',
        name: 'happier-stress-run-api-2',
        service: 'api',
        state: 'running',
        health: 'healthy',
        ipv4Addresses: ['10.10.0.12'],
        networkAttachments: {
          happier: {
            aliases: ['api', 'container-2'],
            ipv4Address: '10.10.0.12',
          },
        },
      },
    ]);

    await result.admin?.stopService('worker');
    await result.admin?.startService('worker');
    await result.admin?.stopContainer('container-1');
    await result.admin?.killContainer('container-2');
    await result.admin?.startContainer?.('container-2');
    await result.admin?.disconnectContainerFromNetwork?.('container-1', 'happier');
    await result.admin?.connectContainerToNetwork?.('container-1', 'happier', {
      aliases: ['api'],
      ipv4Address: '10.10.0.11',
    });
    await result.admin?.execInService('redis', ['redis-cli', 'ping']);

    expect(runtime.stop).toHaveBeenCalledWith('worker');
    expect(runtime.start).toHaveBeenCalledWith('worker');
    expect(runtime.stopContainer).toHaveBeenCalledWith('container-1');
    expect(runtime.killContainer).toHaveBeenCalledWith('container-2');
    expect(runtime.startContainer).toHaveBeenCalledWith('container-2');
    expect(runtime.disconnectContainerFromNetwork).toHaveBeenCalledWith('container-1', 'happier');
    expect(runtime.connectContainerToNetwork).toHaveBeenCalledWith('container-1', 'happier', {
      aliases: ['api'],
      ipv4Address: '10.10.0.11',
    });
    expect(runtime.execCapture).toHaveBeenCalledWith('redis', ['redis-cli', 'ping']);
  });

  it('preserves the compose topology on stop after failure preservation is requested', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    result.preserveForInspection();
    await result.stop();

    expect(runtime.down).not.toHaveBeenCalled();
  });

  it('reuses the existing canonical image when the build strategy is if-missing and the image already exists', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => true),
      inspectImage: vi.fn(async () => ({
        labels: {
          'happier.stress.owner': 'stress-harness',
          'happier.stress.image-fingerprint': 'current-fingerprint',
          'happier.stress.repo-root': 'repo-fingerprint',
        },
      })),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(runtime.imageExists).toHaveBeenCalledWith(
      'happier-stress-compose-server-repo-fingerprint-current-fingerprint',
    );
    expect(runtime.inspectImage).toHaveBeenCalledWith(
      'happier-stress-compose-server-repo-fingerprint-current-fingerprint',
    );
    expect(runtime.buildServerImage).not.toHaveBeenCalled();
    expect(runtime.up).toHaveBeenCalledTimes(1);
  });

  it('derives distinct compose project names for different run directories that share the same leaf name', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-project-'));
    const firstTestDir = join(baseDir, 'run-a', 'compose-topology');
    const secondTestDir = join(baseDir, 'run-b', 'compose-topology');

    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const deps = {
      repoRootDir: () => '/repo/root',
      createRepoRootFingerprint: () => 'repo-fingerprint',
      computeComposeServerImageFingerprint: () => 'current-fingerprint',
      randomSecret: () => 'secret-token',
      pickAvailablePort: vi
        .fn()
        .mockResolvedValueOnce(43080)
        .mockResolvedValueOnce(45432)
        .mockResolvedValueOnce(46379)
        .mockResolvedValueOnce(49000)
        .mockResolvedValueOnce(49001)
        .mockResolvedValueOnce(43081)
        .mockResolvedValueOnce(45433)
        .mockResolvedValueOnce(46380)
        .mockResolvedValueOnce(49002)
        .mockResolvedValueOnce(49003),
      createComposeRuntime: vi.fn(() => runtime),
      waitForComposeTopology: vi.fn(async () => {}),
      waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
      inspectComposeTopology: vi.fn(async () => ({
        services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
        resolvedApiReplicas: 3,
        resolvedWorkerReplicas: 2,
        ports: {
          gateway: 43080,
          postgres: 45432,
          redis: 46379,
          minio: 49000,
          minioConsole: 49001,
        },
      })),
    };

    const first = await startFullComposeStressTarget(
      {
        config,
        testDir: firstTestDir,
      },
      deps,
    );

    const second = await startFullComposeStressTarget(
      {
        config,
        testDir: secondTestDir,
      },
      deps,
    );

    expect(first.topology.composeProjectName).not.toBe(second.topology.composeProjectName);
  });

  it('cleans up previous task-owned compose projects before launching a fresh topology', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi
        .fn()
        .mockResolvedValueOnce(['happier-stress-old-a', 'happier-stress-old-b'])
        .mockResolvedValueOnce([]),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(runtime.removeProjectResources).toHaveBeenCalledTimes(3);
    expect(runtime.removeProjectResources).toHaveBeenNthCalledWith(1, result.topology.composeProjectName);
    expect(runtime.removeProjectResources).toHaveBeenNthCalledWith(2, 'happier-stress-old-a');
    expect(runtime.removeProjectResources).toHaveBeenNthCalledWith(3, 'happier-stress-old-b');
    expect(runtime.removeProjectResources.mock.invocationCallOrder[2]).toBeLessThan(runtime.up.mock.invocationCallOrder[0]);
  });

  it('cleans the current project leftovers but does not delete other active stress topologies', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi
        .fn()
        .mockResolvedValueOnce(['happier-stress-old-running', 'happier-stress-old-stopped'])
        .mockResolvedValueOnce([]),
      projectHasRunningContainers: vi
        .fn()
        .mockImplementation(async (projectName: string) => projectName === 'happier-stress-old-running'),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(runtime.removeProjectResources).toHaveBeenCalledWith(result.topology.composeProjectName);
    expect(runtime.removeProjectResources).toHaveBeenCalledWith('happier-stress-old-stopped');
    expect(runtime.removeProjectResources).not.toHaveBeenCalledWith('happier-stress-old-running');
  });

  it('rebuilds the canonical image when an existing image is stale for the current freshness fingerprint', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => true),
      inspectImage: vi
        .fn()
        .mockResolvedValueOnce({
          labels: {
            'happier.stress.owner': 'stress-harness',
            'happier.stress.image-fingerprint': 'stale-fingerprint',
            'happier.stress.repo-root': 'repo-fingerprint',
          },
        })
        .mockResolvedValueOnce({
          labels: {
            'happier.stress.owner': 'stress-harness',
            'happier.stress.image-fingerprint': 'current-fingerprint',
            'happier.stress.repo-root': 'repo-fingerprint',
          },
        }),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(runtime.buildServerImage).toHaveBeenCalledTimes(1);
    expect(runtime.up).toHaveBeenCalledTimes(1);
    await result.stop();
  });

  it('uses the explicitly pinned frozen image when the current build-input fingerprint has drifted', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const pinnedImageFingerprint = '1111111111111111111111111111111111111111';
    const currentImageFingerprint = '2222222222222222222222222222222222222222';
    const runtime = {
      imageExists: vi.fn(async () => true),
      inspectImage: vi.fn(async () => ({
        createdAt: '2026-04-19T07:00:00.000Z',
        labels: {
          'happier.stress.owner': 'stress-harness',
          'happier.stress.repo-root': 'repo-fingerprint',
          'happier.stress.image-fingerprint': pinnedImageFingerprint,
        },
      })),
      buildServerImage: vi.fn(async () => {}),
      attestServicesUseImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      stopContainer: vi.fn(async () => {}),
      killContainer: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const result = await startFullComposeStressTarget(
      {
        config: {
          ...config,
          compose: {
            ...config.compose,
            imageBuildStrategy: 'never',
            imageFingerprint: pinnedImageFingerprint,
          },
        },
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => currentImageFingerprint,
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
          },
        })),
      },
    );

    const pinnedImageName = `happier-stress-compose-server-repo-fingerprint-${pinnedImageFingerprint}`;
    expect(runtime.imageExists).toHaveBeenCalledWith(pinnedImageName);
    expect(runtime.inspectImage).toHaveBeenCalledWith(pinnedImageName);
    expect(runtime.buildServerImage).not.toHaveBeenCalled();
    expect(runtime.up).toHaveBeenCalledTimes(1);
    expect(runtime.attestServicesUseImage).toHaveBeenCalledWith({
      services: ['api', 'worker'],
      imageName: pinnedImageName,
      expectedLabels: {
        'happier.stress.owner': 'stress-harness',
        'happier.stress.repo-root': 'repo-fingerprint',
        'happier.stress.image-fingerprint': pinnedImageFingerprint,
      },
    });
    expect(JSON.parse(readFileSync(join(testDir, 'topology', 'env.generated.json'), 'utf8'))).toMatchObject({
      image: {
        name: pinnedImageName,
        freshnessFingerprint: pinnedImageFingerprint,
        repoRootFingerprint: 'repo-fingerprint',
      },
    });
    await result.stop();
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-sha1-fingerprint'],
  ])('fails closed when frozen-image mode receives a %s image fingerprint', async (_case, imageFingerprint) => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const createComposeRuntime = vi.fn();

    await expect(startFullComposeStressTarget(
      {
        config: {
          ...config,
          compose: {
            ...config.compose,
            imageBuildStrategy: 'never',
            imageFingerprint,
          },
        },
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => '2222222222222222222222222222222222222222',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi.fn(async () => 43080),
        createComposeRuntime,
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(),
      },
    )).rejects.toThrow('HAPPIER_STRESS_COMPOSE_IMAGE_FINGERPRINT');

    expect(createComposeRuntime).not.toHaveBeenCalled();
  });

  it('fails closed when the pinned frozen image labels do not match its owner and repo root', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const pinnedImageFingerprint = '1111111111111111111111111111111111111111';
    const runtime = {
      imageExists: vi.fn(async () => true),
      inspectImage: vi.fn(async () => ({
        labels: {
          'happier.stress.owner': 'another-owner',
          'happier.stress.repo-root': 'another-repo',
          'happier.stress.image-fingerprint': pinnedImageFingerprint,
        },
      })),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    await expect(startFullComposeStressTarget(
      {
        config: {
          ...config,
          compose: {
            ...config.compose,
            imageBuildStrategy: 'never',
            imageFingerprint: pinnedImageFingerprint,
          },
        },
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => '2222222222222222222222222222222222222222',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi.fn(async () => 43080),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(),
      },
    )).rejects.toThrow('does not match the pinned frozen-image identity');

    expect(runtime.buildServerImage).not.toHaveBeenCalled();
    expect(runtime.up).not.toHaveBeenCalled();
    expect(runtime.removeProjectResources).not.toHaveBeenCalled();
    expect(runtime.listOwnedProjects).not.toHaveBeenCalled();
    expect(runtime.down).not.toHaveBeenCalled();
  });

  it('fails closed without cleaning compose projects when the pinned frozen image is unavailable', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const pinnedImageFingerprint = '1111111111111111111111111111111111111111';
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    await expect(startFullComposeStressTarget(
      {
        config: {
          ...config,
          compose: {
            ...config.compose,
            imageBuildStrategy: 'never',
            imageFingerprint: pinnedImageFingerprint,
          },
        },
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => '2222222222222222222222222222222222222222',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi.fn(async () => 43080),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(),
      },
    )).rejects.toThrow('is missing');

    expect(runtime.inspectImage).not.toHaveBeenCalled();
    expect(runtime.removeProjectResources).not.toHaveBeenCalled();
    expect(runtime.listOwnedProjects).not.toHaveBeenCalled();
    expect(runtime.up).not.toHaveBeenCalled();
    expect(runtime.down).not.toHaveBeenCalled();
  });

  it('tears down a partially started topology when readiness fails', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    await expect(
      startFullComposeStressTarget(
        {
          config,
          testDir,
        },
        {
          repoRootDir: () => '/repo/root',
          createRepoRootFingerprint: () => 'repo-fingerprint',
          computeComposeServerImageFingerprint: () => 'current-fingerprint',
          randomSecret: () => 'secret-token',
          pickAvailablePort: vi
            .fn()
            .mockResolvedValueOnce(43080)
            .mockResolvedValueOnce(45432)
            .mockResolvedValueOnce(46379)
            .mockResolvedValueOnce(49000)
            .mockResolvedValueOnce(49001),
          createComposeRuntime: vi.fn(() => runtime),
          waitForComposeTopology: vi.fn(async () => {
            throw new Error('topology did not become ready');
          }),
          waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
          inspectComposeTopology: vi.fn(async () => ({
            services: [],
            resolvedApiReplicas: 0,
            resolvedWorkerReplicas: 0,
            ports: {},
          })),
        },
      ),
    ).rejects.toThrow('topology did not become ready');

    expect(runtime.down).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(testDir, 'topology', 'docker-compose.startup-failure.logs.txt'), 'utf8')).toContain('compose logs');
    expect(readFileSync(join(testDir, 'topology', 'docker-compose.startup-failure.ps.txt'), 'utf8')).toContain('ps output');
  });

  it('retries startup readiness once when flakeRetry is enabled and the first topology wait times out', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };
    const waitForComposeTopology = vi
      .fn<typeof import('../docker/waitForComposeTopology').waitForComposeTopology>()
      .mockRejectedValueOnce(new Error('Timed out waiting for full-compose stress topology at http://127.0.0.1:43080'))
      .mockResolvedValueOnce(undefined);

    const result = await startFullComposeStressTarget(
      {
        config: {
          ...config,
          flakeRetry: true,
        },
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => 'secret-token',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn(() => runtime),
        waitForComposeTopology,
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    expect(waitForComposeTopology).toHaveBeenCalledTimes(2);
    expect(runtime.up).toHaveBeenCalledTimes(2);
    expect(runtime.down).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(testDir, 'topology', 'docker-compose.startup-failure.logs.txt'), 'utf8')).toContain('compose logs');

    await result.stop();
    expect(runtime.down).toHaveBeenCalledTimes(2);
  });

  it('tears down the topology when image prebuild fails during startup', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {
        throw new Error('build server image failed');
      }),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    await expect(
      startFullComposeStressTarget(
        {
          config,
          testDir,
        },
        {
          repoRootDir: () => '/repo/root',
          createRepoRootFingerprint: () => 'repo-fingerprint',
          computeComposeServerImageFingerprint: () => 'current-fingerprint',
          randomSecret: () => 'secret-token',
          pickAvailablePort: vi
            .fn()
            .mockResolvedValueOnce(43080)
            .mockResolvedValueOnce(45432)
            .mockResolvedValueOnce(46379)
            .mockResolvedValueOnce(49000)
            .mockResolvedValueOnce(49001),
          createComposeRuntime: vi.fn(() => runtime),
          waitForComposeTopology: vi.fn(async () => {}),
          waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
          inspectComposeTopology: vi.fn(async () => ({
            services: [],
            resolvedApiReplicas: 0,
            resolvedWorkerReplicas: 0,
            ports: {},
          })),
        },
      ),
    ).rejects.toThrow('build server image failed');

    expect(runtime.down).toHaveBeenCalledTimes(1);
  });

  it('tears down the topology when docker compose up fails during startup', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-'));
    const runtime = {
      imageExists: vi.fn(async () => false),
      inspectImage: vi.fn(async () => null),
      buildServerImage: vi.fn(async () => {}),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {
        throw new Error('compose up failed');
      }),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };
    await expect(
      startFullComposeStressTarget(
        {
          config,
          testDir,
        },
        {
          repoRootDir: () => '/repo/root',
          createRepoRootFingerprint: () => 'repo-fingerprint',
          computeComposeServerImageFingerprint: () => 'current-fingerprint',
          randomSecret: () => 'secret-token',
          pickAvailablePort: vi
            .fn()
            .mockResolvedValueOnce(43080)
            .mockResolvedValueOnce(45432)
            .mockResolvedValueOnce(46379)
            .mockResolvedValueOnce(49000)
            .mockResolvedValueOnce(49001),
          createComposeRuntime: vi.fn(() => runtime),
          waitForComposeTopology: vi.fn(async () => {}),
          waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
          inspectComposeTopology: vi.fn(async () => ({
            services: [],
            resolvedApiReplicas: 0,
            resolvedWorkerReplicas: 0,
            ports: {},
          })),
        },
      ),
    ).rejects.toThrow('compose up failed');

    expect(runtime.down).toHaveBeenCalledTimes(1);
  });

  const sentinelQueue = [
    'sentinel-pg-password-0123456789abcdef',
    'sentinel-master-secret-0123456789abcdef',
    'sentinel-access-key-0123456789abcdef',
    'sentinel-minio-secret-0123456789abcdef',
    'sentinel-bucket-name-0123456789abcdef',
  ];

  function collectFilesRecursive(root: string): string[] {
    const files: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(entryPath);
        } else {
          files.push(entryPath);
        }
      }
    };
    visit(root);
    return files;
  }

  function findFilesContainingSentinels(root: string, sentinels: readonly string[]): string[] {
    return collectFilesRecursive(root).filter((file) => {
      const bytes = readFileSync(file);
      return sentinels.some((sentinel) => bytes.includes(Buffer.from(sentinel, 'utf8')));
    });
  }

  afterEach(() => {
    clearRegisteredRuntimeSecretValues();
  });

  it('keeps generated secrets out of the retained run directory and inside restrictive runtime-only material', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-secrets-'));
    let secretCall = 0;
    const runtime = {
      imageExists: vi.fn(async () => true),
      inspectImage: vi.fn(async () => ({
        createdAt: 'now',
        labels: {
          'happier.stress.owner': 'stress-harness',
          'happier.stress.repo-root': 'repo-fingerprint',
          'happier.stress.image-fingerprint': 'current-fingerprint',
        },
      })),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };
    let runtimeComposeFilePath = '';

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => sentinelQueue[secretCall++] ?? 'sentinel-extra-secret-0123456789',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn((params: { composeFilePath: string }) => {
          runtimeComposeFilePath = params.composeFilePath;
          return runtime as never;
        }),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    const pgPassword = sentinelQueue[0];
    const masterSecret = sentinelQueue[1];
    const minioAccessKey = `minio-${sentinelQueue[2].slice(0, 8)}`;
    const minioSecretKey = sentinelQueue[3];
    const routeGrantSeed = result.testRuntime?.peerMediation.routeGrantSigning.privateKeySeedBase64Url ?? '';
    const liveSecrets = [pgPassword, masterSecret, minioAccessKey, minioSecretKey, routeGrantSeed];

    // Runtime material exists outside the retained run directory with restrictive permissions.
    expect(result.artifacts?.runtimeComposeFile).toBe(runtimeComposeFilePath);
    expect(runtimeComposeFilePath).toBeTruthy();
    expect(runtimeComposeFilePath.startsWith(testDir)).toBe(false);
    const runtimeComposeBytes = readFileSync(runtimeComposeFilePath);
    for (const secret of liveSecrets) {
      expect(runtimeComposeBytes.includes(Buffer.from(secret, 'utf8'))).toBe(true);
    }
    if (process.platform !== 'win32') {
      expect(statSync(runtimeComposeFilePath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(runtimeComposeFilePath)).mode & 0o777).toBe(0o700);
    }

    // No live secret value may occur anywhere under the retained/publishable run directory.
    expect(findFilesContainingSentinels(testDir, liveSecrets)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(masterSecret);

    // The retained compose projection stays useful but only contains redacted values.
    const retainedCompose = readFileSync(join(testDir, 'topology', 'docker-compose.yml'), 'utf8');
    expect(retainedCompose).toContain('gateway:');
    expect(retainedCompose).toContain('DATABASE_URL: postgres://stress:__redacted_secret__@postgres:5432/stressdb');
    expect(retainedCompose).toContain(`HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: ${REDACTED_SECRET_PLACEHOLDER}`);
    expect(result.artifacts?.composeFile).toBe(join(testDir, 'topology', 'docker-compose.yml'));

    // The retained env projection stays useful for attach while carrying no secrets.
    const generatedEnv = JSON.parse(readFileSync(join(testDir, 'topology', 'env.generated.json'), 'utf8')) as Record<string, unknown>;
    expect(generatedEnv).toMatchObject({
      publicBaseUrl: 'http://127.0.0.1:43080',
      composeProjectName: result.topology.composeProjectName,
      ports: { gateway: 43080 },
    });
    expect(Object.keys(generatedEnv)).not.toContain('secrets');

    // Diagnostics captured from the running topology must be scrubbed before retention.
    runtime.logs.mockResolvedValueOnce(
      `api-1 | HANDY_MASTER_SECRET=${masterSecret} DATABASE_URL=postgres://stress:${pgPassword}@postgres:5432/stressdb`,
    );
    await result.collectDiagnostics();
    const dockerLogs = readFileSync(join(testDir, 'topology', 'docker-compose.logs.txt'), 'utf8');
    expect(dockerLogs).not.toContain(masterSecret);
    expect(dockerLogs).not.toContain(pgPassword);
    expect(findFilesContainingSentinels(testDir, liveSecrets)).toEqual([]);

    // Failed teardown retains the only runtime material capable of stopping the live topology.
    runtime.down.mockRejectedValueOnce(new Error('compose down failed'));
    await expect(result.stop()).rejects.toThrow('compose down failed');
    expect(existsSync(runtimeComposeFilePath)).toBe(true);
    expect(existsSync(dirname(runtimeComposeFilePath))).toBe(true);

    // A successful retry deletes the runtime-only secret material.
    runtime.down.mockResolvedValueOnce(undefined);
    await result.stop();
    expect(runtime.down).toHaveBeenCalledTimes(2);
    expect(existsSync(runtimeComposeFilePath)).toBe(false);
    expect(existsSync(dirname(runtimeComposeFilePath))).toBe(false);
  });

  it('deletes runtime-only secret material and scrubs startup-failure diagnostics when startup fails', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-startup-failure-'));
    let secretCall = 0;
    const runtime = {
      imageExists: vi.fn(async () => true),
      inspectImage: vi.fn(async () => ({
        createdAt: 'now',
        labels: {
          'happier.stress.owner': 'stress-harness',
          'happier.stress.repo-root': 'repo-fingerprint',
          'happier.stress.image-fingerprint': 'current-fingerprint',
        },
      })),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => `api-1 | fatal HANDY_MASTER_SECRET=${sentinelQueue[1]}`),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };
    const runtimeComposeFilePaths: string[] = [];

    await expect(
      startFullComposeStressTarget(
        {
          config,
          testDir,
        },
        {
          repoRootDir: () => '/repo/root',
          createRepoRootFingerprint: () => 'repo-fingerprint',
          computeComposeServerImageFingerprint: () => 'current-fingerprint',
          randomSecret: () => sentinelQueue[secretCall++] ?? 'sentinel-extra-secret-0123456789',
          pickAvailablePort: vi
            .fn()
            .mockResolvedValueOnce(43080)
            .mockResolvedValueOnce(45432)
            .mockResolvedValueOnce(46379)
            .mockResolvedValueOnce(49000)
            .mockResolvedValueOnce(49001),
          createComposeRuntime: vi.fn((params: { composeFilePath: string }) => {
            runtimeComposeFilePaths.push(params.composeFilePath);
            return runtime as never;
          }),
          waitForComposeTopology: vi.fn(async () => {
            throw new Error('topology did not become ready');
          }),
          waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
          inspectComposeTopology: vi.fn(async () => ({
            services: [],
            resolvedApiReplicas: 0,
            resolvedWorkerReplicas: 0,
            ports: {},
          })),
        },
      ),
    ).rejects.toThrow('topology did not become ready');

    expect(runtime.down).toHaveBeenCalledTimes(1);
    const startupFailureLogs = readFileSync(
      join(testDir, 'topology', 'docker-compose.startup-failure.logs.txt'),
      'utf8',
    );
    expect(startupFailureLogs).not.toContain(sentinelQueue[1]);
    expect(startupFailureLogs).toContain(`HANDY_MASTER_SECRET=${REDACTED_SECRET_PLACEHOLDER}`);
    expect(findFilesContainingSentinels(testDir, [
      sentinelQueue[0],
      sentinelQueue[1],
      `minio-${sentinelQueue[2].slice(0, 8)}`,
      sentinelQueue[3],
    ])).toEqual([]);
    for (const runtimeComposeFilePath of runtimeComposeFilePaths) {
      expect(existsSync(runtimeComposeFilePath)).toBe(false);
      expect(existsSync(dirname(runtimeComposeFilePath))).toBe(false);
    }
  });

  it('keeps runtime-only secret material available while the topology is preserved for inspection', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-compose-preserved-'));
    let secretCall = 0;
    const runtime = {
      imageExists: vi.fn(async () => true),
      inspectImage: vi.fn(async () => ({
        createdAt: 'now',
        labels: {
          'happier.stress.owner': 'stress-harness',
          'happier.stress.repo-root': 'repo-fingerprint',
          'happier.stress.image-fingerprint': 'current-fingerprint',
        },
      })),
      listOwnedProjects: vi.fn(async () => []),
      projectHasRunningContainers: vi.fn(async () => false),
      removeProjectResources: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      ps: vi.fn(async () => 'ps output'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };
    let runtimeComposeFilePath = '';

    const result = await startFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        repoRootDir: () => '/repo/root',
        createRepoRootFingerprint: () => 'repo-fingerprint',
        computeComposeServerImageFingerprint: () => 'current-fingerprint',
        randomSecret: () => sentinelQueue[secretCall++] ?? 'sentinel-extra-secret-0123456789',
        pickAvailablePort: vi
          .fn()
          .mockResolvedValueOnce(43080)
          .mockResolvedValueOnce(45432)
          .mockResolvedValueOnce(46379)
          .mockResolvedValueOnce(49000)
          .mockResolvedValueOnce(49001),
        createComposeRuntime: vi.fn((params: { composeFilePath: string }) => {
          runtimeComposeFilePath = params.composeFilePath;
          return runtime as never;
        }),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 3,
          resolvedWorkerReplicas: 2,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
      },
    );

    result.preserveForInspection();
    await result.stop();

    expect(runtime.down).not.toHaveBeenCalled();
    expect(existsSync(runtimeComposeFilePath)).toBe(true);
  });
});
