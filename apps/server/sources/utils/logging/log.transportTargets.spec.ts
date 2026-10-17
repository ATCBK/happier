import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const targets = mod.createLoggingTransportTargets({});
    expect(targets.some(t => t?.target === 'pino-pretty')).toBe(true);
  });

  it('does not include pino-pretty transport when running under Bun', async () => {
    setBunRuntime(true);
    const mod = await import('./log');
    const targets = mod.createLoggingTransportTargets({});
    expect(targets.some(t => t?.target === 'pino-pretty')).toBe(false);
  });

  it('omits the pino-pretty transport when the json log format is selected', async () => {
    setBunRuntime(false);
    const mod = await import('./log');
    const targets = mod.createLoggingTransportTargets({ HAPPIER_SERVER_LOG_FORMAT: ' JSON ' } as NodeJS.ProcessEnv);
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


describe('JSON stdout', () => {
  it.each([false, true])('keeps structured stdout and optional debug file output (debug=%s)', (debug) => {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-json-log-'));
    try {
      const result = spawnSync(process.execPath, [
        '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, '--eval',
        `(async () => { const { logger, fileConsolidatedLogger } = await import(${JSON.stringify(new URL('./log.ts', import.meta.url).href)});
         logger.debug({ route: '/v1/ping' }, 'hello json');
         logger.info({ route: '/v1/ping' }, 'file and stdout');
         fileConsolidatedLogger?.info({ source: 'remote-client' }, 'file only'); })();`,
      ], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          HAPPIER_SERVER_LOG_FORMAT: 'json',
          HAPPIER_SERVER_LOG_LEVEL: 'debug',
          DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: debug ? '1' : '',
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ level: 20, route: '/v1/ping', msg: 'hello json' });
      if (debug) {
        const files = readdirSync(join(cwd, '.logs'));
        expect(files).toHaveLength(1);
        const fileRecords = readFileSync(join(cwd, '.logs', files[0]), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        expect(fileRecords).toContainEqual(expect.objectContaining({ level: 20, msg: 'hello json' }));
        expect(fileRecords).toContainEqual(expect.objectContaining({ msg: 'file and stdout' }));
        expect(fileRecords).toContainEqual(expect.objectContaining({ source: 'remote-client', msg: 'file only' }));
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
