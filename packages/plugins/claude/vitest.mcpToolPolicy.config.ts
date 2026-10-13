import { defineConfig } from 'vitest/config';
import inMemoryConfig from '../../../apps/cli/vitest.inMemory.config';
export default defineConfig({ ...inMemoryConfig,
  test: { ...inMemoryConfig.test, include: ['src/agent/mcpToolPolicy.contract.test.ts'] } });
