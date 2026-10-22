import test from 'node:test';
import assert from 'node:assert/strict';

test('resolvePnpmCommandInvocation wraps Windows pnpm through cmd.exe and ignores npm-cli npm_execpath', async () => {
  const mod = await import('./execPnpmCommand.mjs');

  assert.equal(typeof mod.resolvePnpmCommandInvocation, 'function');

  const invocation = mod.resolvePnpmCommandInvocation(['-s', '--filter', '@happier-dev/cli', 'run', 'build'], {
    platform: 'win32',
    npmExecPath: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  });

  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.match(invocation.args.join(' '), /pnpm\.cmd/);
  assert.match(invocation.args.join(' '), /@happier-dev\/cli/);
  assert.doesNotMatch(invocation.args.join(' '), /npm-cli\.js/);
});

test('resolvePnpmCommandInvocation uses pnpm on PATH when no parent package manager is available', async () => {
  const mod = await import('./execPnpmCommand.mjs');
  assert.deepEqual(mod.resolvePnpmCommandInvocation(['run', '--silent', 'build'], {
    platform: 'darwin',
    npmExecPath: '',
  }), {
    command: 'pnpm',
    args: ['run', '--silent', 'build'],
  });
});

test('resolvePnpmCommandInvocation executes a Windows Pnpm npm_execpath with spaces through node', async () => {
  const mod = await import('./execPnpmCommand.mjs');

  assert.equal(typeof mod.resolvePnpmCommandInvocation, 'function');

  const invocation = mod.resolvePnpmCommandInvocation(['run', '--silent', 'build'], {
    platform: 'win32',
    npmExecPath: 'C:\\Program Files\\Corepack\\pnpm\\lib\\cli.js',
    processExecPath: 'C:\\Program Files\\nodejs\\node.exe',
  });

  assert.deepEqual(invocation, {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Program Files\\Corepack\\pnpm\\lib\\cli.js', 'run', '--silent', 'build'],
  });
});

test('resolvePnpmCommandInvocation can require pnpm on PATH instead of the parent entrypoint', async () => {
  const mod = await import('./execPnpmCommand.mjs');

  assert.deepEqual(
    mod.resolvePnpmCommandInvocation(['install', '--ignore-scripts'], {
      platform: 'darwin',
      preferPath: true,
    }),
    {
      command: 'pnpm',
      args: ['install', '--ignore-scripts'],
    },
  );
  const windows = mod.resolvePnpmCommandInvocation(['install'], {
    platform: 'win32',
    preferPath: true,
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  });
  assert.equal(windows.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.match(windows.args.join(' '), /pnpm\.cmd.*install/);
});

test('native pnpm npm_execpath is executed directly rather than parsed as JavaScript', async () => {
  const mod = await import('./execPnpmCommand.mjs');
  assert.deepEqual(mod.resolvePnpmCommandInvocation(['run', 'build'], {
    npmExecPath: '/opt/pnpm/pnpm', platform: 'linux', processExecPath: '/opt/node/bin/node',
  }), { command: '/opt/pnpm/pnpm', args: ['run', 'build'] });
  assert.deepEqual(mod.resolvePnpmCommandInvocation(['exec', 'tool'], {
    npmExecPath: 'C:\\Program Files\\pnpm\\pnpm.exe', platform: 'win32',
  }), { command: 'C:\\Program Files\\pnpm\\pnpm.exe', args: ['exec', 'tool'] });
});
