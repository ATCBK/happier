import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceWebExportArgs, sourceWebExportDiagnosticEnv } from './sourceWebExportArgs.mjs';

test('explicit export worker counts survive the remote source export boundary', () => {
  const env = sourceWebExportDiagnosticEnv({ HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS: '2' });
  const args = sourceWebExportArgs(env, '/owned/web');
  assert.equal(args[args.indexOf('--max-workers') + 1], '2');
  const disabled = sourceWebExportArgs(sourceWebExportDiagnosticEnv({ HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS: '0' }));
  assert.equal(disabled.includes('--max-workers'), false);
  const admittedEnv = { GOMAXPROCS: '3' };
  assert.deepEqual(sourceWebExportArgs({ ...admittedEnv, ...env, ...sourceWebExportDiagnosticEnv({}) }), sourceWebExportArgs(admittedEnv),
    'withdrawing a caller override clears the previously projected remote value');
});

test('diagnostic source maps participate in both export construction and reuse options', () => {
  const env = { GOMAXPROCS: '3', HAPPIER_UI_EXPORT_SOURCE_MAPS: '1' };
  assert.ok(sourceWebExportArgs(env).includes('--source-maps'));
  assert.ok(sourceWebExportArgs(env, '/owned/web').includes('--source-maps'));
  assert.ok(!sourceWebExportArgs({ ...env, HAPPIER_UI_EXPORT_SOURCE_MAPS: '0' }).includes('--source-maps'));
  assert.ok(sourceWebExportArgs(env, '/owned/web').includes('/owned/web'));
});
