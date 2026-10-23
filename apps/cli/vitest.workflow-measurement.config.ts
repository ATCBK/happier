import { mergeConfig } from 'vitest/config';
import config from './vitest.config';

// Explicit report-only 500-cycle measurement, separate from the default suite.
export default mergeConfig(config, {
  test: {
    include: ['src/daemon/workflows/workflowFrontier.test.ts'],
    testNamePattern: 'bounds reads across admission and one-at-a-time parked item hold restarts',
    env: { HAPPIER_WORKFLOW_SCALE_MEASUREMENT: '1' },
    testTimeout: 0,
    maxWorkers: 1,
  },
});
