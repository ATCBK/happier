import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import { initialize, resolve } from './sourceRuntimeEntries.mjs';

// Source-tool controllers are long-lived and numerous. tsx indexes the entire
// shared disk cache in each process (and loader thread), retaining every entry.
// Keep transforms cached within the process without importing that global index.
process.env.TSX_DISABLE_CACHE = '1';
await import('tsx');

// Synchronous hooks run before asynchronous loaders. Register after tsx so
// workspace exports also win over its tsconfig paths and require(esm) graphs.
const repoDir = fileURLToPath(new URL('../../', import.meta.url));
if (typeof nodeModule.registerHooks === 'function') {
  await initialize(repoDir);
  nodeModule.registerHooks({ resolve });
} else {
  nodeModule.register('./sourceRuntimeEntries.mjs', import.meta.url, { data: repoDir });
}
