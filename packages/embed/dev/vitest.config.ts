import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import pluginSdkConfig from '../../plugin-sdk/vitest.config';

// Exercise the fixture against current SDK/Protocol source, not packaged builds.
export default defineConfig({
  ...pluginSdkConfig,
  test: {
    ...pluginSdkConfig.test,
    // The SDK's setup path is relative to its own package root.
    setupFiles: [fileURLToPath(new URL('../../plugin-sdk/src/ui/configureZodLocale.ts', import.meta.url))],
    environment: 'node',
    include: ['fixture.test.mjs'],
  },
});
