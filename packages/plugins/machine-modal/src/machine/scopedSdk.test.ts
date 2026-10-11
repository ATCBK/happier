import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { invokeScopedModalRole } from './scopedSdk.js';
import { MODAL_ACCOUNT_PURPOSE, MODAL_ENV_KEYS } from './connectedAccount.js';

const workerBoundary = vi.hoisted(() => ({ env: {} as Record<string, string>, terminated: false, entry: '',
  holdCompletion: false, latest: undefined as undefined | { emit(event: string, value: unknown): boolean } }));
// Thread creation is the OS boundary; the real credential-scoping owner stays live.
vi.mock('node:worker_threads', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return { Worker: class extends Emitter {
    constructor(entry: string, options: { env: Record<string, string> }) {
      super(); workerBoundary.entry = entry; workerBoundary.env = options.env; workerBoundary.latest = this;
      if (!workerBoundary.holdCompletion) queueMicrotask(() => this.emit('message', { ok: true, value: { available: true } }));
    }
    postMessage() {}
    async terminate() { workerBoundary.terminated = true; return 0; }
  } };
});

const account = { service: { pluginId: 'happier.machine.modal', localId: 'modal-account' }, accountId: 'selected-account' };
function context(env: Record<string, string>, signal = new AbortController().signal) {
  const getBinding = vi.fn(async () => ({ purpose: MODAL_ACCOUNT_PURPOSE, service: account.service, account,
    target: { kind: 'account', displayName: 'Selected Modal' } }));
  const materialize = vi.fn(async () => ({ kind: 'environment', env }));
  // Invocation and credential services are host system-boundary fixtures.
  const value = { invokedAtMs: 123, signal,
    services: { connectedAccounts: { getBinding, materialize } } } as unknown as PluginInvocationContext;
  return { value, getBinding, materialize };
}

describe('Modal scoped SDK construction', () => {
  const credentials = { MODAL_TOKEN_ID: 'dummy-id', MODAL_TOKEN_SECRET: 'dummy-secret', MODAL_SERVER_URL: 'http://127.0.0.1:1' };
  it('pins the selected account and gives the vendor a fresh explicit profile environment before import', async () => {
    const selected = { MODAL_TOKEN_ID: 'dummy-token-id', MODAL_TOKEN_SECRET: 'dummy-token-secret',
      MODAL_SERVER_URL: 'http://127.0.0.1:1', MODAL_ENVIRONMENT: 'selected-environment',
      MODAL_PROFILE: 'ambient-profile-must-not-propagate', NODE_OPTIONS: 'ambient-options-must-not-propagate' };
    const fixture = context(selected);
    expect(await invokeScopedModalRole('check', {}, fixture.value)).toEqual({ available: true });
    expect(fixture.materialize).toHaveBeenCalledWith(MODAL_ACCOUNT_PURPOSE,
      { kind: 'environment', keys: MODAL_ENV_KEYS }, { signal: fixture.value.signal, expectedAccount: account });
    expect(workerBoundary.env).toMatchObject({ MODAL_TOKEN_ID: selected.MODAL_TOKEN_ID, MODAL_TOKEN_SECRET: selected.MODAL_TOKEN_SECRET,
      MODAL_SERVER_URL: selected.MODAL_SERVER_URL, MODAL_ENVIRONMENT: selected.MODAL_ENVIRONMENT });
    expect(workerBoundary.env.MODAL_CONFIG_PATH).toMatch(/happier-modal-config-.*absent\.toml$/);
    expect(workerBoundary.env.MODAL_PROFILE).toBeUndefined();
    expect(workerBoundary.env.NODE_OPTIONS).toBeUndefined();
    expect(workerBoundary.entry).toMatch(/sdkWorker\.(?:ts|js)$/);
    expect(workerBoundary.terminated).toBe(true);
  });

  it('refuses incomplete selected credentials before vendor thread construction', async () => {
    workerBoundary.terminated = false;
    await expect(invokeScopedModalRole('acquire', {}, context({ MODAL_TOKEN_ID: 'dummy-token' }).value))
      .rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(workerBoundary.terminated).toBe(false);
  });

  it('settles aborted private exec without claiming guest termination and disposes the native worker', async () => {
    workerBoundary.holdCompletion = true;
    workerBoundary.terminated = false;
    const cancellation = new AbortController();
    let outcome: unknown;
    const pending = invokeScopedModalRole('exec', {}, context(credentials, cancellation.signal).value)
      .then(value => { outcome = value; }, error => { outcome = error; });
    await new Promise<void>(resolve => setImmediate(resolve));
    cancellation.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      expect(outcome).toMatchObject({ code: 'modal_operation_cancelled' });
      expect(workerBoundary.terminated).toBe(true);
    } finally {
      // Complete a pre-fix pending boundary call so RED does not leak work.
      workerBoundary.latest?.emit('message', { ok: true, value: { native: 'late-result' } });
      await pending;
      workerBoundary.holdCompletion = false;
    }
  });

  it('preserves late allocation custody rather than killing the acquire worker on abort', async () => {
    workerBoundary.holdCompletion = true;
    workerBoundary.terminated = false;
    const cancellation = new AbortController();
    let settled = false;
    const custody = { kind: 'bound', resource: { value: { appId: 'ap-dummy', sandboxId: 'sb-dummy' } } };
    const pending = invokeScopedModalRole('acquire', {}, context(credentials, cancellation.signal).value)
      .then(value => { settled = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    cancellation.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      expect(settled).toBe(false);
      expect(workerBoundary.terminated).toBe(false);
    } finally {
      workerBoundary.latest?.emit('message', { ok: true, value: custody });
      expect(await pending).toEqual(custody);
      expect(workerBoundary.terminated).toBe(true);
      workerBoundary.holdCompletion = false;
    }
  });
});

it('prepares the native worker once and reuses unchanged shared preparation', () => {
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'happier-modal-unit-prepare-'));
  const packageRoot = join(fixtureRoot, 'packages/plugins/machine-modal');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  try {
    write(join(fixtureRoot, 'package.json'), JSON.stringify({ private: true,
      workspaces: ['apps/*', 'packages/plugins/*'] }));
    for (const app of ['cli', 'ui', 'server']) {
      write(join(fixtureRoot, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
    }
    // Replace only the package compiler process. The real package hook, graph,
    // input/output admission, locks and currentness owner all execute unchanged.
    write(join(packageRoot, 'package.json'), JSON.stringify({ name: manifest.name, type: 'module',
      main: manifest.main, types: manifest.types, imports: manifest.imports,
      scripts: { build: 'node ../../../fixture-build.mjs',
        'test:unit:prepare': manifest.scripts['test:unit:prepare'] } }));
    const sourcePath = join(packageRoot, 'src/machine/sdkWorker.ts');
    write(sourcePath, 'export const workerVersion = 1;');
    const eventsPath = join(fixtureRoot, 'compiler-events');
    write(join(fixtureRoot, 'fixture-build.mjs'), `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(process.env.FIXTURE_COMPILER_EVENTS, 'build\\n');
const output = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || join(process.cwd(), 'dist');
mkdirSync(join(output, 'machine'), { recursive: true });
writeFileSync(join(output, 'index.js'), 'export const ready = true;');
writeFileSync(join(output, 'index.d.ts'), 'export declare const ready: true;');
writeFileSync(join(output, 'machine/sdkWorker.js'), readFileSync('src/machine/sdkWorker.ts'));`);
    for (const directory of ['scripts', 'node_modules']) {
      symlinkSync(join(repoRoot, directory), join(fixtureRoot, directory), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const prepare = () => {
      const result = spawnSync(manifest.scripts['test:unit:prepare'], { shell: true, cwd: packageRoot,
        encoding: 'utf8', env: { ...process.env, FIXTURE_COMPILER_EVENTS: eventsPath,
          HAPPIER_STACK_REPO_DIR: fixtureRoot, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: fixtureRoot } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    prepare();
    expect(readFileSync(join(packageRoot, 'dist/machine/sdkWorker.js'), 'utf8')).toContain('workerVersion = 1');
    prepare();
    expect(readFileSync(eventsPath, 'utf8')).toBe('build\n');
    write(sourcePath, 'export const workerVersion = 2;');
    prepare();
    expect(readFileSync(eventsPath, 'utf8')).toBe('build\nbuild\n');
    expect(readFileSync(join(packageRoot, 'dist/machine/sdkWorker.js'), 'utf8')).toContain('workerVersion = 2');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
