import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { BinaryTarget } from './targets.js';
import { execOrThrow, resolveBunCompilerCommand, type RunCommand } from './commands.js';

export async function compilePrismaMigrateBinary({
  repoRoot,
  target,
  outfile,
  bunCommand,
  env = process.env,
  commandProbe,
  runCommand = execOrThrow,
}: {
  repoRoot: string;
  target: BinaryTarget;
  outfile: string;
  bunCommand?: string;
  env?: NodeJS.ProcessEnv;
  commandProbe?: (cmd: string) => boolean;
  runCommand?: RunCommand;
}): Promise<void> {
  const compiler = resolveBunCompilerCommand({ repoRoot, bunCommand, processEnv: env, commandProbe });
  await mkdir(dirname(outfile), { recursive: true });
  await runCommand(
    compiler,
    [
      join(repoRoot, 'packages', 'cli-common', 'scripts', 'buildPrismaMigrateBinary.mjs'),
      '--repo-root', repoRoot,
      '--target', target.bunTarget,
      '--outfile', outfile,
    ],
    { cwd: repoRoot, env },
  );
}
