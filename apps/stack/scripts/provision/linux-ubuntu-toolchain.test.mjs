import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../testkit/core/fake_bin_harness.mjs';

async function toolchainHost(t, { node = '', npm = '', buildTools = true, nativeTools = true } = {}) {
  const { root } = await createTempFixture(t, { prefix: 'hstack-toolchain-' });
  const log = join(root, 'writes.log');
  await writeFile(log, '');
  for (const [name, version] of Object.entries({ node, npm })) {
    await writeFile(join(root, `${name}.version`), version);
  }
  await writeFile(join(root, 'build-tools.ready'), buildTools ? 'ready' : '');
  await writeFile(join(root, 'native-tools.ready'), nativeTools ? 'ready' : '');
  // Commands are the real OS/package boundary. The narrow PATH prevents a
  // developer machine's existing toolchain from satisfying a fresh-host probe.
  const { binDir } = writeFakeBin({ root, name: 'id', content: '#!/bin/sh\necho 0\n' });
  for (const name of ['env', 'cat']) await symlink(`/usr/bin/${name}`, join(binDir, name));
  for (const name of ['go', 'rg']) {
    writeFakeBin({ root, name, content: `#!/bin/sh
[ -n "$(cat "$TEST_HOST/build-tools.ready")" ] || exit 127
printf '%s\\n' '${name} ready'
` });
  }
  for (const name of ['cc', 'c++', 'make', 'ar', 'pkg-config']) {
    writeFakeBin({ root, name, content: `#!/bin/sh
[ -n "$(cat "$TEST_HOST/native-tools.ready")" ] || exit 127
[ "\${TEST_BROKEN_NATIVE_TOOL:-}" != '${name}' ] || exit 126
printf '%s\\n' '${name} ready'
` });
  }
  for (const name of ['node', 'npm']) {
    writeFakeBin({ root, name, content: `#!/bin/sh
if [ "$1" = --version ]; then
  version=$(cat "$TEST_HOST/${name}.version")
  [ -n "$version" ] || exit 127
  printf '%s\n' "$version"
else
  exit 79
fi
` });
  }
  writeFakeBin({ root, name: 'bash', content: `#!/bin/sh
printf 'bash %s\n' "$*" >> "$TEST_WRITES"
[ "$1" = -lc ] || exit 79
case "$2" in *https://deb.nodesource.com/setup_24.x*) ;; *) exit 79 ;; esac
` });
  writeFakeBin({ root, name: 'apt-get', content: `#!/bin/sh
printf 'apt-get %s\n' "$*" >> "$TEST_WRITES"
case "$*" in
  'update -y'|'install -y --no-install-recommends ca-certificates curl gnupg') ;;
  'install -y nodejs') printf 'v24.0.0' > "$TEST_HOST/node.version"
     [ "\${TEST_INSTALL_NO_NPM:-0}" = 1 ] || printf '11.0.0' > "$TEST_HOST/npm.version" ;;
  'install -y --no-install-recommends ripgrep golang-go'*)
    [ "\${TEST_INSTALL_NO_BUILD_TOOLS:-0}" = 1 ] || printf ready > "$TEST_HOST/build-tools.ready"
    case "$*" in *' build-essential pkg-config')
      [ "\${TEST_INSTALL_NO_NATIVE_TOOLS:-0}" = 1 ] || printf ready > "$TEST_HOST/native-tools.ready" ;;
    esac ;;
  *) exit 79 ;;
esac
` });
  const script = await readFile(new URL('./linux-ubuntu-provision.sh', import.meta.url), 'utf8');
  return {
    root,
    run(extraEnv = {}) {
      // This is the same repository-free, streamed script surface used by
      // remote host preparation, so no companion Bun pin can be required.
      return spawnSync('/bin/bash', ['-c', script, '--', '--profile=toolchain'], {
        cwd: root,
        env: { ...process.env, PATH: binDir, HOME: root, BASH_ENV: '',
          HAPPIER_PROVISION_NODE_MAJOR: '24',
          TEST_HOST: root, TEST_WRITES: log, ...extraEnv },
        encoding: 'utf8',
      });
    },
    writes: () => readFile(log, 'utf8'),
  };
}

test('toolchain profile bootstraps a fresh host and is a no-op on the next run', async t => {
  const host = await toolchainHost(t);
  const first = host.run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const writes = await host.writes();
  assert.match(writes, /https:\/\/deb\.nodesource\.com\/setup_24\.x/);
  assert.match(writes, /apt-get install -y nodejs/);
  assert.doesNotMatch(writes, /corepack|yarn|pnpm/, 'repository package-manager setup belongs to the synced checkout');
  assert.equal((await readFile(join(host.root, 'node.version'), 'utf8')), 'v24.0.0');
  assert.equal((await readFile(join(host.root, 'npm.version'), 'utf8')), '11.0.0');
  await assert.rejects(readFile(join(host.root, '.config/systemd/user/happier.slice')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(host.root, '.codex/config.toml')), { code: 'ENOENT' });
  const second = host.run();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(await host.writes(), writes, 'ready toolchain must perform no writes or installs');
});

test('toolchain profile upgrades old Node without reinstalling ready Node', async t => {
  for (const node of ['v18.20.0', 'v24.2.0']) {
    const host = await toolchainHost(t, { node, npm: '11.0.0' });
    const result = host.run();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const writes = await host.writes();
    assert.equal(writes.includes('apt-get install -y nodejs'), node.startsWith('v18'));
    assert.doesNotMatch(writes, /corepack|yarn|pnpm/);
  }
});

test('toolchain profile preserves an already usable newer Node and npm', async t => {
  const host = await toolchainHost(t, { node: 'v25.1.0', npm: '11.0.0' });
  const result = host.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await host.writes(), '');
});

test('toolchain profile repairs missing CLI build tools and verifies the resulting executables', async t => {
  const host = await toolchainHost(t, { node: 'v24.2.0', npm: '11.0.0', buildTools: false });
  const first = host.run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(await readFile(join(host.root, 'build-tools.ready'), 'utf8'), 'ready');
  const writes = await host.writes();
  const second = host.run();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(await host.writes(), writes, 'ready build tools must not be reinstalled');
  const broken = await toolchainHost(t, { node: 'v24.2.0', npm: '11.0.0', buildTools: false });
  assert.notEqual(broken.run({ TEST_INSTALL_NO_BUILD_TOOLS: '1' }).status, 0, 'installation without working Go/ripgrep must fail');
});

test('toolchain profile fails when Node preparation does not leave a usable npm executable', async t => {
  const host = await toolchainHost(t);
  const result = host.run({ TEST_INSTALL_NO_NPM: '1' });
  assert.notEqual(result.status, 0, result.stdout);
});

test('toolchain profile repairs native compiler, linker and package discovery tools and verifies readiness', async t => {
  const readyJs = { node: 'v24.2.0', npm: '11.0.0' };
  const host = await toolchainHost(t, { ...readyJs, nativeTools: false });
  const first = host.run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(await readFile(join(host.root, 'native-tools.ready'), 'utf8'), 'ready', 'native prerequisites must be installed');
  const writes = await host.writes();
  assert.match(writes, /build-essential pkg-config/);
  assert.equal(host.run().status, 0);
  assert.equal(await host.writes(), writes, 'ready native tools must not be reinstalled');
  const absent = await toolchainHost(t, { ...readyJs, nativeTools: false });
  assert.notEqual(absent.run({ TEST_INSTALL_NO_NATIVE_TOOLS: '1' }).status, 0, 'an unsuccessful native tool installation must fail');
  for (const tool of ['cc', 'c++', 'make', 'ar', 'pkg-config']) {
    const broken = await toolchainHost(t, readyJs);
    assert.notEqual(broken.run({ TEST_BROKEN_NATIVE_TOOL: tool }).status, 0, `unusable ${tool} must fail readiness`);
  }
});

test('toolchain profile fails clearly for a ready Node with missing npm', async t => {
  const host = await toolchainHost(t, { node: 'v24.2.0' });
  const result = host.run();
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr + result.stdout, /npm/i);
  assert.equal(await host.writes(), '', 'missing npm must not provision a competing package manager');
});
