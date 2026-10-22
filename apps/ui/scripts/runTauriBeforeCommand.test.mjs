import test from 'node:test';
import assert from 'node:assert/strict';

import { runTauriBeforeCommand } from './runTauriBeforeCommand.mjs';

test('runTauriBeforeCommand runs pnpm prepare:build through the canonical Windows shim', () => {
  /** @type {any} */
  let call = null;
  runTauriBeforeCommand({
    mode: 'build',
    platform: 'win32',
    cwd: 'C:\\repo\\apps\\ui',
    env: { PATH: 'x' },
    execFileSync: (cmd, args, opts) => {
      call = { cmd, args, opts };
      return Buffer.from('');
    },
  });

  assert.equal(call.cmd, 'cmd.exe');
  assert.deepEqual(call.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(call.args[3], /pnpm\.cmd/);
  assert.match(call.args[3], /tauri:prepare:build/);
  assert.equal(call.opts.windowsVerbatimArguments, true);
  assert.equal(call.opts.cwd, 'C:\\repo\\apps\\ui');
});

test('runTauriBeforeCommand executes native pnpm directly on macOS/Linux', () => {
  /** @type {any} */
  let call = null;
  runTauriBeforeCommand({
    mode: 'dev',
    platform: 'darwin',
    cwd: '/repo/apps/ui',
    env: { PATH: 'x', npm_execpath: '/native/pnpm' },
    execFileSync: (cmd, args, opts) => {
      call = { cmd, args, opts };
      return Buffer.from('');
    },
  });

  assert.equal(call.cmd, '/native/pnpm');
  assert.deepEqual(call.args, ['--silent', 'run', 'tauri:prepare:dev']);
  assert.equal(call.opts.cwd, '/repo/apps/ui');
});

test('runTauriBeforeCommand rejects unknown mode', () => {
  assert.throws(() => {
    runTauriBeforeCommand({
      // @ts-expect-error - intentional invalid input for test
      mode: 'nope',
      platform: 'darwin',
      cwd: '/repo/apps/ui',
      env: { PATH: 'x' },
      execFileSync: () => Buffer.from(''),
    });
  }, /mode must be 'dev' or 'build'/);
});

