import { defineConfig } from 'vitest/config';

import integrationConfig from './vitest.integration.config';
import sourceConfig from './vitest.config';

// Source integration exercises current workspace providers through the same
// resolver as unit tests. Native custody remains a prerequisite; packaged CLI
// subprocess tests use vitest.integration.config.ts and its full setup.
export default defineConfig({
  ...integrationConfig,
  // Cross-package compositions share the unit source resolver and UI platform
  // boundaries; the packaged integration resolver only owns CLI aliases.
  esbuild: sourceConfig.esbuild,
  resolve: sourceConfig.resolve,
  server: sourceConfig.server,
  test: {
    ...integrationConfig.test,
    server: sourceConfig.test?.server,
    globalSetup: ['./src/test-setup.unit.ts'],
  },
});
