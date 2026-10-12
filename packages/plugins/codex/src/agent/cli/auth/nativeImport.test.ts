import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodexNativeAuthCredentials } from './nativeImport.js';

describe('Codex native credential storage selection', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('respects configured keyring storage instead of importing a stale auth file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-keyring-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: {
      id_token: 'stale-id', access_token: 'stale-access', refresh_token: 'stale-refresh', account_id: 'stale-account',
    } }));
    await expect(readCodexNativeAuthCredentials({
      env: { CODEX_HOME: dir }, platform: 'darwin',
      readKeyring: async ({ service, account }) => {
        expect(service).toBe('Codex Auth');
        expect(account).toBe(`cli|${createHash('sha256').update(await realpath(dir)).digest('hex').slice(0, 16)}`);
        return JSON.stringify({ tokens: {
        id_token: 'native-id', access_token: 'native-access', refresh_token: 'native-refresh', account_id: 'native-account',
        } });
      },
    })).resolves.toMatchObject({ accessToken: 'native-access', accountId: 'native-account' });
  });

  it('rejects Windows encrypted and ephemeral storage without borrowing the file login', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-unavailable-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir }, platform: 'win32' })).rejects.toMatchObject({
      code: 'credentials_unavailable',
    });
    await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "ephemeral"\n');
    await expect(readCodexNativeAuthCredentials({ env: { CODEX_HOME: dir } })).rejects.toMatchObject({
      code: 'credentials_unavailable',
    });
  });

  it('honors Codex secret_auth_storage on Linux instead of consulting a direct keyring login', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-secrets-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n[features]\nsecret_auth_storage = true\n');
    await expect(readCodexNativeAuthCredentials({
      env: { CODEX_HOME: dir }, platform: 'linux', readKeyring: async () => JSON.stringify({ tokens: {
        id_token: 'wrong-store-id', access_token: 'wrong-store-access', refresh_token: 'refresh', account_id: 'account',
      } }),
    })).rejects.toMatchObject({ code: 'credentials_unavailable' });
  });

  it('imports the file fallback only when auto storage has no keyring entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-native-auto-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'config.toml'), 'cli_auth_credentials_store = "auto"\n');
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: {
      id_token: 'file-id', access_token: 'file-access', refresh_token: 'file-refresh', account_id: 'file-account',
    } }));
    await expect(readCodexNativeAuthCredentials({
      env: { CODEX_HOME: dir }, platform: 'darwin', readKeyring: async () => null,
    })).resolves.toMatchObject({ accountId: 'file-account' });
    await expect(readCodexNativeAuthCredentials({
      env: { CODEX_HOME: dir }, platform: 'darwin', readKeyring: async () => '{secret-malformed',
    })).rejects.toMatchObject({ code: 'reauthorization_required' });
  });
});
