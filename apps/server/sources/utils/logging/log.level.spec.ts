import { afterEach, describe, expect, it, vi } from 'vitest';
import { symbols, type DestinationStream } from 'pino';

import { log, logger } from './log';

describe('log', () => {
  const originalLevel = logger.level;

  afterEach(() => {
    vi.restoreAllMocks();
    logger.level = originalLevel;
  });

  function captureOutput() {
    const records: unknown[] = [];
    // Replace only the output destination; pino's real level filtering and serialization run.
    const stream = (logger as unknown as { [symbols.streamSym]: DestinationStream })[symbols.streamSym];
    vi.spyOn(stream, 'write').mockImplementation((message) => {
      records.push(JSON.parse(message));
    });
    return records;
  }

  it('emits errors and warnings only when their thresholds admit them', () => {
    logger.level = 'error';
    const records = captureOutput();

    log(
      { module: 'fastify-error', level: 'error', statusCode: 500 },
      'Unhandled error',
    );
    log({ module: 'socket', level: 'warn' }, 'Filtered warning');
    logger.level = 'warn';
    log({ module: 'socket', level: 'warn' }, 'Slow handler');
    log({ module: 'api' }, 'Filtered info');

    expect(records).toMatchObject([
      { module: 'fastify-error', statusCode: 500, msg: 'Unhandled error' },
      { module: 'socket', msg: 'Slow handler' },
    ]);
  });

  it('keeps info for entries without a recognised level', () => {
    logger.level = 'info';
    const records = captureOutput();

    log({ module: 'api' }, 'Request served');
    log({ module: 'api', level: 'loud' }, 'Unknown level');
    log('plain message');

    expect(records).toMatchObject([
      { module: 'api', msg: 'Request served' },
      { module: 'api', msg: 'Unknown level' },
      { msg: 'plain message' },
    ]);
  });
});
