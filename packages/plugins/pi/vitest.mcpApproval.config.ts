import { defineConfig } from 'vitest/config';
import inMemoryConfig from '../../../apps/cli/vitest.inMemory.config';

// Real Pi process + native Session interactions and the host permission owner.
export default defineConfig({
  ...inMemoryConfig,
  test: {
    ...inMemoryConfig.test,
    include: ['src/agent/tools/mcpToolPolicy.contract.test.ts'],
  },
});
