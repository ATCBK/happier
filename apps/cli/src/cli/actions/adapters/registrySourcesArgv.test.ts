import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { listCompiledActionCliCommands, findCompiledActionCliCommand } from '../compiledCommands';
import { runCompiledActionCliCommand } from '../executeCommand';
import { tryHandleRegistrySourceCliCommand } from './registrySourcesArgv';
import { createSavedSecretsCliHttpFixture } from './savedSecretsCliHttpFixture';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = 0; });

async function harness() {
  const fixture = await createSavedSecretsCliHttpFixture(); cleanups.push(fixture.close);
  const nativeFetch = globalThis.fetch;
  // The Home uses real loopback HTTP; only the third-party registry is substituted.
  vi.stubGlobal('fetch', async (url: string | URL | Request, options?: RequestInit) => {
    const target = new URL(url instanceof Request ? url.url : String(url));
    if (target.origin === fixture.origin) return nativeFetch(url, options);
    if (target.hostname === 'raw.githubusercontent.com') return Response.json({ plugins: [] });
    throw new Error('Unexpected third-party fixture endpoint');
  });
  async function run(path: readonly string[], argv: readonly string[]) {
    const command = findCompiledActionCliCommand(path, listCompiledActionCliCommands());
    if (!command) throw new Error('Registry command unavailable');
    const output = captureConsoleJsonOutput();
    try {
      await fixture.inHome(() => runCompiledActionCliCommand({ command,
        argv: [...path, ...argv, '--server-id', 'home-fixture', '--json'], deps: fixture.deps }));
      return output.json();
    } finally { output.restore(); }
  }
  return { ...fixture, run, ref: 'happier:shared-secret:v1:resource-id' };
}

describe('compiled registry credential input', () => {
  it.each(['Acme', 'resource-id', 'happier:shared-secret:v1:resource-id'])('stores catalog-produced refs from %s', async name => {
    const h = await harness();
    expect(await h.run(['registries', 'token'], ['Acme catalog', '--secret', name, '--npm-profile', 'new-profile'])).toMatchObject({ ok: true });
    expect(h.registryWrites).toEqual([expect.objectContaining({ key: 'registry-sources', value: expect.objectContaining({ sources: [
      expect.objectContaining({ id: 'catalog-id', token: { secretRef: h.ref }, npmRegistryProfileId: 'new-profile' }),
    ] }) })]);
  });
  it('clears both credentials through the canonical token Action', async () => {
    const h = await harness();
    expect(await h.run(['registries', 'token'], ['Acme catalog', '--clear', '--clear-npm-profile'])).toMatchObject({ ok: true });
    expect(JSON.stringify(h.registryWrites)).not.toContain('old-profile');
    expect(JSON.stringify(h.registryWrites)).not.toContain('secretRef');
  });
  it.each([
    ['https://github.com/acme/skills', '--token-secret', 'Acme'],
    ['--input-json', '{"url":"https://github.com/acme/skills"}', '--token-secret', 'Acme'],
  ])('resolves a token on create without ever passing a secret value: %j', async (...argv) => {
    const h = await harness();
    expect(await h.run(['registries', 'add'], argv)).toMatchObject({ ok: true });
    expect(h.registryWrites).toEqual([expect.objectContaining({ key: 'registry-sources', value: expect.objectContaining({ sources: expect.arrayContaining([
      expect.objectContaining({ token: { secretRef: h.ref } }),
    ]) }) })]);
    expect(JSON.stringify(h.registryWrites)).not.toContain('incumbent-value');
  });
  it('rejects conflicting credential choices before writing', async () => {
    const h = await harness();
    expect(await h.run(['registries', 'token'], ['Acme catalog', '--secret', 'Acme', '--clear'])).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(h.registryWrites).toEqual([]);
  });
  it('keeps a dry-run safe by refusing credentials intended only for add', async () => {
    const h = await harness(); const output = captureConsoleJsonOutput();
    try {
      expect(await h.inHome(() => tryHandleRegistrySourceCliCommand({ argv: ['registries', 'add', 'https://github.com/acme/skills',
        '--dry-run', '--token-secret', 'Acme', '--server-id', 'home-fixture', '--json'], actionExecutionDeps: h.deps }))).toBe(true);
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      expect(h.registryWrites).toEqual([]);
    } finally { output.restore(); }
  });
});
