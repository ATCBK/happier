import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyLightDefaultEnv: vi.fn(),
  applyPackagedLightRuntimeSqliteDefaults: vi.fn(),
  resolveLightDataDir: vi.fn(() => '/tmp/happier-light-main-test'),
  applySqliteMigrationsFromEnvironment: vi.fn(async () => ({ applied: [] })),
  sentryPreload: vi.fn(),
  sentryInit: vi.fn(),
  registerProcessHandlers: vi.fn(),
  startServer: vi.fn(async () => {}),
  initDbSqlite: vi.fn(async () => {}),
  shutdownDbClient: vi.fn(async () => {}),
  materializeHomeIrohEndpointDescriptor: vi.fn(async () => ({
    status: 'ready' as const,
    endpoint: { endpointId: 'a'.repeat(64) },
  })),
  continuityStore: { read: vi.fn(), write: vi.fn() },
  createHomeConnectionDescriptorContinuityStoreForServer: vi.fn(),
  reserveRelocatedHomeConnectionDescriptor: vi.fn(async () => ({
    v: 1 as const,
    homeServerIdentityId: 'srv_home_1',
    canonicalServerUrl: 'http://127.0.0.1:3005',
    revision: 8,
    endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
  })),
  authInit: vi.fn(async () => {}),
  createPersonalHomeAuthenticatedReadiness: vi.fn(async () => ({
    authenticated: true as const,
    homeServerIdentityId: 'srv_home_1',
    accountCount: 1,
    sessionCount: 2,
  })),
  loadExistingHandyMasterSecret: vi.fn(async () => {}),
}));

vi.mock('@/flavors/light/env', () => ({
  applyLightDefaultEnv: mocks.applyLightDefaultEnv,
  applyPackagedLightRuntimeSqliteDefaults: mocks.applyPackagedLightRuntimeSqliteDefaults,
  loadExistingHandyMasterSecret: mocks.loadExistingHandyMasterSecret,
  resolveLightDataDir: mocks.resolveLightDataDir,
}));
vi.mock('@/flavors/light/sqliteMigrations', () => ({
  applySqliteMigrationsFromEnvironment: mocks.applySqliteMigrationsFromEnvironment,
}));
// Keep the real instrumentation/configuration owner; isolate the telemetry SDK boundary.
vi.mock('@sentry/node', () => ({
  preloadOpenTelemetry: mocks.sentryPreload,
  init: mocks.sentryInit,
  getClient: () => undefined,
}));
vi.mock('@/utils/process/processHandlers', () => ({
  registerProcessHandlers: mocks.registerProcessHandlers,
}));
vi.mock('@/startServer', () => ({
  startServer: mocks.startServer,
}));
vi.mock('@/app/iroh/homeIrohEndpoint', () => ({
  materializeHomeIrohEndpointDescriptor: mocks.materializeHomeIrohEndpointDescriptor,
}));
vi.mock('@/app/features/homeConnectionDescriptorContinuity', () => ({
  createHomeConnectionDescriptorContinuityStoreForServer: mocks.createHomeConnectionDescriptorContinuityStoreForServer,
}));
vi.mock('@/app/features/homeConnectionDescriptorPublication', () => ({
  reserveRelocatedHomeConnectionDescriptor: mocks.reserveRelocatedHomeConnectionDescriptor,
}));
vi.mock('@/app/auth/auth', () => ({
  auth: { init: mocks.authInit },
}));
vi.mock('@/app/runtime/personalHomeReadiness', () => ({
  createPersonalHomeAuthenticatedReadiness: mocks.createPersonalHomeAuthenticatedReadiness,
}));
vi.mock('@/storage/db', () => ({
  initDbSqlite: mocks.initDbSqlite,
  shutdownDbClient: mocks.shutdownDbClient,
}));

import { runLightServerMain } from './flavors/light/main';

describe('runLightServerMain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createHomeConnectionDescriptorContinuityStoreForServer.mockReturnValue(mocks.continuityStore);
    delete process.env.HAPPY_SERVER_FLAVOR;
    delete process.env.HAPPIER_SERVER_FLAVOR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.HAPPY_SERVER_FLAVOR;
    delete process.env.HAPPIER_SERVER_FLAVOR;
  });

  it('reports the bounded managed Personal Home capability without initializing the light runtime', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.env.HAPPY_SERVER_FLAVOR = 'unchanged-before-capability-probe';
    process.env.HAPPIER_SERVER_FLAVOR = 'unchanged-before-capability-probe';

    await runLightServerMain(['--probe-runtime-capabilities']);

    expect(output).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(`${JSON.stringify({
      schemaVersion: 1,
      component: 'happier-server-light',
      capabilities: ['managed-personal-home-create.v1'],
    })}\n`);
    expect(process.env.HAPPY_SERVER_FLAVOR).toBe('unchanged-before-capability-probe');
    expect(process.env.HAPPIER_SERVER_FLAVOR).toBe('unchanged-before-capability-probe');
    expect(mocks.applyLightDefaultEnv).not.toHaveBeenCalled();
    expect(mocks.applyPackagedLightRuntimeSqliteDefaults).not.toHaveBeenCalled();
    expect(mocks.resolveLightDataDir).not.toHaveBeenCalled();
    expect(mocks.applySqliteMigrationsFromEnvironment).not.toHaveBeenCalled();
    expect(mocks.loadExistingHandyMasterSecret).not.toHaveBeenCalled();
    expect(mocks.initDbSqlite).not.toHaveBeenCalled();
    expect(mocks.authInit).not.toHaveBeenCalled();
    expect(mocks.materializeHomeIrohEndpointDescriptor).not.toHaveBeenCalled();
    expect(mocks.reserveRelocatedHomeConnectionDescriptor).not.toHaveBeenCalled();
    expect(mocks.sentryPreload).not.toHaveBeenCalled();
    expect(mocks.sentryInit).not.toHaveBeenCalled();
    expect(mocks.registerProcessHandlers).not.toHaveBeenCalled();
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  it('runs canonical SQLite migration only and returns for --migrate-only', async () => {
    await runLightServerMain(['--migrate-only']);

    expect(mocks.applyLightDefaultEnv).toHaveBeenCalledWith(process.env);
    expect(mocks.applyPackagedLightRuntimeSqliteDefaults).toHaveBeenCalledWith(process.env);
    expect(mocks.applySqliteMigrationsFromEnvironment).toHaveBeenCalledWith({
      env: process.env,
      dataDir: '/tmp/happier-light-main-test',
    });
    expect(mocks.sentryPreload).not.toHaveBeenCalled();
    expect(mocks.sentryInit).not.toHaveBeenCalled();
    expect(mocks.registerProcessHandlers).not.toHaveBeenCalled();
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  it('materializes a stopped relocation endpoint through the packaged light runtime entrypoint', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runLightServerMain([
      '--materialize-iroh-endpoint-descriptor',
      '--source-descriptor-revision=7',
    ]);

    expect(mocks.applyLightDefaultEnv).toHaveBeenCalledWith(process.env);
    expect(mocks.applyPackagedLightRuntimeSqliteDefaults).toHaveBeenCalledWith(process.env);
    expect(mocks.materializeHomeIrohEndpointDescriptor).toHaveBeenCalledWith({
      env: process.env,
      continuityStore: mocks.continuityStore,
    });
    expect(mocks.reserveRelocatedHomeConnectionDescriptor).toHaveBeenCalledWith({
      env: process.env,
      continuityStore: mocks.continuityStore,
      minimumOuterRevisionExclusive: 7,
      irohEndpoint: { endpointId: 'a'.repeat(64) },
    });
    expect(mocks.initDbSqlite).toHaveBeenCalledOnce();
    expect(mocks.shutdownDbClient).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(`${JSON.stringify({
      status: 'ready',
      connectionDescriptor: await mocks.reserveRelocatedHomeConnectionDescriptor.mock.results[0].value,
    })}\n`);
    expect(mocks.sentryPreload).not.toHaveBeenCalled();
    expect(mocks.sentryInit).not.toHaveBeenCalled();
    expect(mocks.registerProcessHandlers).not.toHaveBeenCalled();
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  it('attests restored Personal Home authentication without starting a listener', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runLightServerMain(['--attest-personal-home-readiness']);

    expect(mocks.applyLightDefaultEnv).toHaveBeenCalledWith(process.env);
    expect(mocks.applyPackagedLightRuntimeSqliteDefaults).toHaveBeenCalledWith(process.env);
    expect(mocks.loadExistingHandyMasterSecret).toHaveBeenCalledWith(process.env);
    expect(mocks.initDbSqlite).toHaveBeenCalledOnce();
    expect(mocks.authInit).toHaveBeenCalledOnce();
    expect(mocks.createPersonalHomeAuthenticatedReadiness).toHaveBeenCalledWith(process.env);
    expect(mocks.shutdownDbClient).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(`${JSON.stringify({
      authenticated: true,
      homeServerIdentityId: 'srv_home_1',
      accountCount: 1,
      sessionCount: 2,
    })}\n`);
    expect(mocks.sentryPreload).not.toHaveBeenCalled();
    expect(mocks.sentryInit).not.toHaveBeenCalled();
    expect(mocks.registerProcessHandlers).not.toHaveBeenCalled();
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  it('preserves ordinary light-server startup when migrate-only is absent', async () => {
    await runLightServerMain([]);

    expect(mocks.applySqliteMigrationsFromEnvironment).not.toHaveBeenCalled();
    expect(mocks.sentryPreload).toHaveBeenCalledOnce();
    expect(mocks.sentryInit).not.toHaveBeenCalled();
    expect(mocks.registerProcessHandlers).toHaveBeenCalledOnce();
    expect(mocks.startServer).toHaveBeenCalledWith('light');
  });
});
