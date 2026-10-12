import { reloadConfiguration } from '@/configuration';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { RetainedExecutionRunRecordSchema } from '../retainedState';

// Real separate process and filesystem custody. The provider launch is the
// test input; no lifecycle, parsing, process-liveness or storage logic is mocked.
reloadConfiguration();
process.on('message', (input: unknown) => {
  void (async () => {
    await retainExecutionRunState(RetainedExecutionRunRecordSchema.shape.state.parse(input));
    process.send?.('retained');
  })().catch((error: unknown) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
    process.disconnect?.();
  });
});
process.send?.('ready');
