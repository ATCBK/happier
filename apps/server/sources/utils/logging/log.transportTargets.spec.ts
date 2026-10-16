import { afterEach, describe, expect, it, vi } from 'vitest';

function setBunRuntime(enabled: boolean) {
  const g = globalThis as any;
  if (enabled) {
    g.Bun = {};
  } else {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete g.Bun;
  }
}

afterEach(() => {
  setBunRuntime(false);
  vi.resetModules();
});

describe('createLoggingTransportTargets', () => {
  it('includes pino-pretty transport when not running under Bun', async () => {
    setBunRuntime(false);
    const mod = await import('./log');
    const targets = mod.createLoggingTransportTargets();
    expect(targets.some(t => t?.target === 'pino-pretty')).toBe(true);
  });

  it('does not include pino-pretty transport when running under Bun', async () => {
    setBunRuntime(true);
    const mod = await import('./log');
    const targets = mod.createLoggingTransportTargets();
    expect(targets.some(t => t?.target === 'pino-pretty')).toBe(false);
  });

  it('omits the pino-pretty transport when the json log format is selected', async () => {
    setBunRuntime(false);
    const mod = await import('./log');
    const targets = mod.createLoggingTransportTargets({ HAPPIER_SERVER_LOG_FORMAT: 'json' } as NodeJS.ProcessEnv);
    expect(targets.some(t => t?.target === 'pino-pretty')).toBe(false);
  });

  it('keeps the pino-pretty transport for unrecognized log formats', async () => {
    setBunRuntime(false);
    const mod = await import('./log');
    const targets = mod.createLoggingTransportTargets({ HAPPIER_SERVER_LOG_FORMAT: 'yaml' } as NodeJS.ProcessEnv);
    expect(targets.some(t => t?.target === 'pino-pretty')).toBe(true);
  });

  it('defaults the server log level to info', async () => {
    const mod = await import('./log');

    expect(mod.resolveServerLogLevelFromEnv({} as NodeJS.ProcessEnv)).toBe('info');
  });

  it('honors explicit server log level env overrides', async () => {
    const mod = await import('./log');

    expect(mod.resolveServerLogLevelFromEnv({ HAPPIER_SERVER_LOG_LEVEL: 'debug' } as NodeJS.ProcessEnv)).toBe('debug');
    expect(mod.resolveServerLogLevelFromEnv({ LOG_LEVEL: 'warn' } as NodeJS.ProcessEnv)).toBe('warn');
  });

  it('falls back to info for invalid server log levels', async () => {
    const mod = await import('./log');

    expect(mod.resolveServerLogLevelFromEnv({ HAPPIER_SERVER_LOG_LEVEL: 'verbose' } as NodeJS.ProcessEnv)).toBe('info');
  });
});
