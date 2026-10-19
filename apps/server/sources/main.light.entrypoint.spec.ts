import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sentryPreload: vi.fn(),
  sentryInit: vi.fn(),
  registerProcessHandlers: vi.fn(),
  startServer: vi.fn(async () => {}),
}));

// Exercise real instrumentation while isolating the third-party telemetry SDK.
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

it('starts the light server when the executable entrypoint is evaluated', async () => {
  await import('./main.light?entrypoint-test');
  await vi.dynamicImportSettled();

  await vi.waitFor(() => {
    expect(mocks.startServer).toHaveBeenCalledWith('light');
  });
});
