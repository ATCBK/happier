import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Source-tool controllers are long-lived and numerous. tsx indexes the entire
// shared disk cache in each process (and loader thread), retaining every entry.
// Keep transforms cached within the process without importing that global index.
process.env.TSX_DISABLE_CACHE = '1';
await import('tsx');

// Register after tsx so workspace aliases are mapped before its normal loading
// and transpilation. Preload this leaf before linking a source-tool entry.
register('./sourceRuntimeEntries.mjs', import.meta.url, {
  data: fileURLToPath(new URL('../../', import.meta.url)),
});
