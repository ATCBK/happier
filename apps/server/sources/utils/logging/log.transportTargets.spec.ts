import pino from 'pino';
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


describe('structured errors', () => {
  it('preserves non-enumerable error details under the existing error field', async () => {
    setBunRuntime(true);
    const { logger } = await import('./log');
    const output: string[] = [];
    // Replace only Pino's output stream; its real formatter and serializers still run.
    const stream = Reflect.get(logger, pino.symbols.streamSym);
    Reflect.set(logger, pino.symbols.streamSym, { write: (chunk: string) => output.push(chunk) });
    try {
      const error = Object.assign(new Error('unsupported Unicode escape sequence'), {
        name: 'PrismaClientUnknownRequestError', clientVersion: '6.19.2',
      });
      logger.error({ module: 'session-write', error }, 'Message write failed');
      const record = JSON.parse(output.join(''));
      expect(record.error).toMatchObject({
        message: error.message, stack: error.stack, clientVersion: '6.19.2',
      });
    } finally {
      Reflect.set(logger, pino.symbols.streamSym, stream);
    }
  });
});
