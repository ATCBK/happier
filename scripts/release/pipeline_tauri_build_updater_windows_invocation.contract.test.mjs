import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  resolveTauriPrepareBuildInvocation,
  resolveTauriCliInvocation,
} from '../pipeline/tauri/build-updater-artifacts.mjs';

test('Windows Tauri updater build invokes native pnpm directly for preparation and tauri.cmd for builds', () => {
  const absUiDir = path.join('D:\\', 'a', 'happier', 'happier', 'apps', 'ui');

  const prepare = resolveTauriPrepareBuildInvocation({
    platform: 'win32',
    nodeExecPath: 'C:\\node.exe',
    npmExecPath: 'C:\\Program Files\\pnpm\\pnpm.exe',
  });

  assert.deepEqual(prepare, {
    cmd: 'C:\\Program Files\\pnpm\\pnpm.exe',
    args: ['run', '--silent', 'tauri:prepare:build'],
  });

  const tauri = resolveTauriCliInvocation({ platform: 'win32', absUiDir });
  assert.equal(tauri.cmd, path.win32.join(absUiDir, 'node_modules', '.bin', 'tauri.cmd'));
  assert.deepEqual(tauri.args, []);
});

