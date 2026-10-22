import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, repoRoot), 'utf8');
}

test('the Iroh package owns one pinned Rust command and existing CI consumes it', async () => {
  const packageJson = JSON.parse(await read('packages/iroh-native/package.json'));
  const workflow = await read('.github/workflows/tests.yml');
  assert.match(packageJson.scripts['test:rust:local'], /cargo test --locked[\s\S]*--workspace --all-targets/u);
  assert.match(
    packageJson.scripts['test:rust:local'],
    /cargo test --locked[\s\S]*-p happier-iroh-core --all-targets --features test-relay-fixture/u,
  );
  assert.match(packageJson.scripts['test:rust:local'], /verify-browser-iroh-wasm\.mjs/u);
  assert.match(workflow, /cargo install wasm-bindgen-cli[\s\S]*Run the canonical pinned Rust suite[\s\S]*pnpm --filter @happier-dev\/iroh-native run test:rust/u);
});

test('CLI native release matrix builds and loads the Iroh addon from the packaged payload', async () => {
  const [workflow, builder, packageJsonSource] = await Promise.all([
    read('.github/workflows/publish-cli-binaries.yml'),
    read('scripts/pipeline/release/build-cli-binaries.mjs'),
    read('packages/iroh-native/package.json'),
  ]);
  const packageJson = JSON.parse(packageJsonSource);

  assert.match(workflow, /rustup toolchain install 1\.94\.1 --profile minimal/u);
  assert.match(workflow, /rustup default 1\.94\.1/u);
  assert.match(
    workflow,
    /pnpm --filter @happier-dev\/iroh-native run build:native[\s\S]*?pnpm --filter @happier-dev\/iroh-native run verify:native/u,
  );
  assert.match(workflow, /verify:native:bun/u);
  assert.match(workflow, /verify:native:lifecycle/u);
  assert.match(
    workflow,
    /if: matrix\.platform_key == 'windows-x64'[\s\S]*?verify:native:windows/u,
  );
  assert.match(packageJson.scripts['verify:native:lifecycle'], /nodeNativeLifecycle\.test\.ts/u);
  assert.match(packageJson.scripts['verify:native:windows'], /windows_key_[\s\S]*stopping_acceptor_joins_an_active/u);
  assert.match(workflow, /bun build --compile --target "\$BUN_TARGET"/u);
  assert.match(workflow, /platform_key: windows-x64[\s\S]*?iroh_addon_target: win32-x64/u);
  assert.match(workflow, /happier-iroh-native-lifecycle\.\$\{IROH_ADDON_TARGET\}\.node/u);
  assert.match(workflow, /--package-root "\$PACKAGED_IROH_ROOT"/u);
  assert.match(builder, /includeIrohNativeReleaseEvidence:\s*true/u);
  assert.match(
    workflow,
    /generate-native-release-evidence\.mjs[\s\S]*?--output-dir "\$\{PACKAGED_IROH_ROOT\}\/release-evidence"[\s\S]*?--check/u,
  );
  assert.match(workflow, /PACKAGED_IROH_SMOKE[\s\S]*?"\$PACKAGED_IROH_SMOKE"/u);
});

test('the addon smoke accepts an explicit package root for packaged hosts', async () => {
  const smoke = await read('packages/iroh-native/scripts/verify-node-addon-load.mjs');
  assert.match(smoke, /--package-root/u);
  assert.match(smoke, /loadIrohNodeNative/u);
  assert.match(smoke, /addonBytes/u);
  assert.match(smoke, /addonLoadMilliseconds/u);
  assert.match(smoke, /endpointStartupMilliseconds/u);
  assert.doesNotMatch(smoke, /MAX_(?:ADDON_BYTES|STARTUP_MILLISECONDS)/u);
});

test('server release builds and loads one native Iroh leaf on each supported target', async () => {
  const [workflow, builder, packageJsonSource] = await Promise.all([
    read('.github/workflows/publish-server-runtime.yml'),
    read('scripts/pipeline/release/build-server-binaries.mjs'),
    read('packages/iroh-native/package.json'),
  ]);
  const packageJson = JSON.parse(packageJsonSource);

  for (const [platformKey, runner, serverTarget, bunTarget, addonTarget] of [
    ['linux-x64', 'ubuntu-24.04', 'linux-x64', 'bun-linux-x64-baseline', 'linux-x64'],
    ['linux-arm64', 'ubuntu-24.04-arm', 'linux-arm64', 'bun-linux-arm64', 'linux-arm64'],
    ['darwin-x64', 'macos-15-intel', 'darwin-x64', 'bun-darwin-x64', 'darwin-x64'],
    ['darwin-arm64', 'macos-15', 'darwin-arm64', 'bun-darwin-arm64', 'darwin-arm64'],
    ['windows-x64', 'windows-2025', 'windows-x64', 'bun-windows-x64', 'win32-x64'],
  ]) {
    assert.match(
      workflow,
      new RegExp(
        `platform_key: ${platformKey}[\\s\\S]*?runner: ${runner}[\\s\\S]*?server_target: ${serverTarget}`
        + `[\\s\\S]*?bun_target: ${bunTarget}[\\s\\S]*?iroh_addon_target: ${addonTarget}`,
        'u',
      ),
    );
  }
  assert.match(workflow, /rustup toolchain install 1\.94\.1 --profile minimal/u);
  assert.match(workflow, /rustup default 1\.94\.1/u);
  assert.match(
    workflow,
    /pnpm --filter @happier-dev\/iroh-native run build[\s\S]*?pnpm --filter @happier-dev\/iroh-native run build:native[\s\S]*?pnpm --filter @happier-dev\/iroh-native run verify:native/u,
  );
  assert.match(workflow, /verify:native:lifecycle/u);
  assert.match(
    workflow,
    /if: matrix\.platform_key == 'windows-x64'[\s\S]*?verify:native:windows/u,
  );
  assert.match(packageJson.scripts['verify:native:lifecycle'], /nodeNativeLifecycle\.test\.ts/u);
  assert.match(packageJson.scripts['verify:native:windows'], /windows_key_[\s\S]*stopping_acceptor_joins_an_active/u);
  assert.match(workflow, /--targets "\$SERVER_TARGET"/u);
  assert.match(workflow, /PACKAGED_IROH_ROOT="\$\{PACKAGED_PAYLOAD_PATH\}\/node_modules\/@happier-dev\/iroh-native"/u);
  assert.match(workflow, /happier-iroh-native-lifecycle\.\$\{IROH_ADDON_TARGET\}\.node/u);
  assert.match(workflow, /bun "\$\{PACKAGED_IROH_ROOT\}\/scripts\/verify-node-addon-load\.mjs" --package-root "\$PACKAGED_IROH_ROOT"/u);
  assert.match(workflow, /bun build --compile --target "\$BUN_TARGET"/u);
  assert.match(workflow, /"\$PACKAGED_IROH_SMOKE"/u);
  assert.match(builder, /includeIrohNativeReleaseEvidence:\s*true/u);
  assert.match(
    workflow,
    /generate-native-release-evidence\.mjs[\s\S]*?--output-dir "\$\{PACKAGED_IROH_ROOT\}\/release-evidence"[\s\S]*?--check/u,
  );
  assert.doesNotMatch(workflow, /--targets[^\n]*musl/u);
});
