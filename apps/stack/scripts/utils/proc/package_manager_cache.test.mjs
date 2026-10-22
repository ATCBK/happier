import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { resolvePackageManagerCachePaths } from './package_manager_cache.mjs';

test('source install caches use the configured pnpm store and cache without Corepack', () => {
  const base = resolve('fixture-cache');
  assert.deepEqual(resolvePackageManagerCachePaths(base), {
    XDG_CACHE_HOME: join(base, 'xdg'),
    pnpm_config_store_dir: join(base, 'pnpm', 'store'),
    pnpm_config_cache_dir: join(base, 'pnpm', 'cache'),
    npm_config_cache: join(base, 'npm'),
    npm_config_prefix: join(base, 'pnpm-toolchain'),
  });
});
