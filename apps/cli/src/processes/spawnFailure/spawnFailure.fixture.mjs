import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { classifySpawnFailure, spawnFailureMessage } from './classifySpawnFailure.ts';

// This is a disposable test process. Its parent lowers only this child's limit.
const descriptors = [];
try {
    while (true) descriptors.push(openSync('/dev/null', 'r'));
} catch (error) {
    if (error.code !== 'EMFILE') throw error;
}
const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'pipe' });
child.once('error', (error) => {
    const spawnFailure = classifySpawnFailure(error, { syscall: 'spawn' });
    for (const fd of descriptors) closeSync(fd);
    process.stdout.write(JSON.stringify({ spawnFailure, message: spawnFailureMessage(spawnFailure, 'Process could not be started') }));
});
