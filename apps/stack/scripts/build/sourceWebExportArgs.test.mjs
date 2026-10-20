import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceWebExportArgs } from './sourceWebExportArgs.mjs';

test('diagnostic source maps participate in both export construction and reuse options', () => {
  const env = { HAPPIER_UI_EXPORT_SOURCE_MAPS: '1' };
  assert.ok(sourceWebExportArgs(env).includes('--source-maps'));
  assert.ok(sourceWebExportArgs(env, '/owned/web').includes('--source-maps'));
  assert.ok(!sourceWebExportArgs({ HAPPIER_UI_EXPORT_SOURCE_MAPS: '0' }).includes('--source-maps'));
  assert.ok(sourceWebExportArgs(env, '/owned/web').includes('/owned/web'));
});
