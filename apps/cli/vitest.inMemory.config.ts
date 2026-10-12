import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

import cliConfig from './vitest.config';

// Source compositions that open no native process need no distribution/custody.
export default defineConfig({
  ...cliConfig,
  test: {
    ...cliConfig.test,
    setupFiles: [resolve(__dirname, 'src/vitestSetup.ts')],
    globalSetup: [],
  },
});
