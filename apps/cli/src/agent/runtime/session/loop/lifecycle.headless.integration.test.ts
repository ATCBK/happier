import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('constructs a real native Agent plan without initializing the terminal UI in a fresh process', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', fileURLToPath(new URL('../../../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url)),
    fileURLToPath(new URL('./fixtures/headlessNativePlan.mjs', import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
    env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../../tsconfig.json', import.meta.url)) },
    encoding: 'utf8',
  });
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as {
    headlessLoaded: string[]; renderedLoaded: string[];
  };
  expect(result.renderedLoaded).toEqual(expect.arrayContaining(['ink', 'react', 'yoga-layout']));
  expect(result.headlessLoaded).toEqual([]);
});
