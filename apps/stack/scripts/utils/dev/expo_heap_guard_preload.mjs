import { isMainThread } from 'node:worker_threads';
import { resolveExpoRestartPolicy, startExpoHeapGuard, EXPO_HEAP_RECYCLE_PREFIX } from './expo_dev_supervision.mjs';
import { resolveExpoConfiguredHeapLimitBytes } from '../expo/expoNodeHeapEnv.mjs';

// NODE_OPTIONS also reaches Metro transform workers. Only the process serving
// HTTP requests can decide that bundle delivery is quiet.
if (isMainThread && process.env.HAPPIER_STACK_EXPO_HEAP_GUARD === '1') {
  startExpoHeapGuard({
    heapLimitBytes: resolveExpoConfiguredHeapLimitBytes(),
    intervalMs: resolveExpoRestartPolicy({ env: process.env }).baseDelayMs,
    onRecycle: state => process.stdout.write(`${EXPO_HEAP_RECYCLE_PREFIX}${JSON.stringify(state)}\n`),
  });
}
