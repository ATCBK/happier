import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function resolveVitestNodeCommand(packageRoot) {
  return {
    command: process.execPath,
    argsPrefix: [
      require.resolve('vitest/vitest.mjs', {
        paths: [packageRoot],
      }),
    ],
  };
}
