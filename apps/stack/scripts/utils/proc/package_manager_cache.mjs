import { join, resolve } from 'node:path';
import { expandHome } from '../paths/canonical_home.mjs';

export function resolvePackageManagerCachePaths(cacheBaseDir) {
  const base = resolve(expandHome(cacheBaseDir));
  return {
    XDG_CACHE_HOME: join(base, 'xdg'),
    pnpm_config_store_dir: join(base, 'pnpm', 'store'),
    pnpm_config_cache_dir: join(base, 'pnpm', 'cache'),
    npm_config_cache: join(base, 'npm'),
    npm_config_prefix: join(base, 'pnpm-toolchain'),
  };
}
