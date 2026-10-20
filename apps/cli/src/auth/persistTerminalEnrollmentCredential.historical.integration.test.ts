import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import predecessor from '@/api/machine/machineLegacyContent.predecessor.fixture.json';
// Load this large real CLI graph during collection; each case reloads its
// environment-bound configuration after setting its isolated Home.
import './persistTerminalEnrollmentCredential';

const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_API_TOKEN']);
const token = (n: string) => `header.${Buffer.from(JSON.stringify({ sub: 'owner', n })).toString('base64url')}.signature`;
afterEach(() => { env.restore(); vi.restoreAllMocks(); vi.resetModules(); });

describe('managed enrollment historical custody', () => {
  it.each([false, true])('prepares historical Machine material before admission, then persists only on success (denied=%s)', async denied => {
    await withTempDir('managed-enrollment-custody-', async home => {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://managed-home.test', HAPPIER_API_TOKEN: undefined });
      vi.resetModules();
      const { default: axios } = await import('axios');
      const persistence = await import('@/persistence');
      const { configuration } = await import('@/configuration');
      const fixture = predecessor.rows.find(row => row.credentialKind === 'dataKey');
      if (!fixture || !fixture.accountPublicKey) throw new Error('Missing captured predecessor data-key fixture');
      const encryption = { type: 'dataKey' as const, machineKey: new Uint8Array(Buffer.from(fixture.accountSecret, 'base64')),
        publicKey: new Uint8Array(Buffer.from(fixture.accountPublicKey, 'base64')) };
      await persistence.writeStoredCredentialsForServerId(configuration.activeServerId, { token: token('old'), encryption });
      const originalCredentialBytes = await readFile(configuration.privateKeyFile, 'utf8');
      await persistence.updateSettings(settings => ({ ...settings,
        machineIdByServerId: { [configuration.activeServerId]: fixture.machine.id },
        machineIdByServerIdByAccountId: { [configuration.activeServerId]: { owner: fixture.machine.id } },
        lastTokenSubByServerId: { [configuration.activeServerId]: 'owner' },
      }));
      const managedEnrollment = { homeId: 'srv_managed_home', managedId: 'managed-child', expectedIntentRevision: 2,
        requestId: 'approved-create', controller: { machineId: 'physical-controller', installationId: 'host-installation' },
        resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
          value: { containerId: 'native-child' }, devcontainerObservation: { nativeResourceId: 'native-child', user: 'developer',
            workspaceFolder: '/work/project', storage: { kind: 'child' as const, childPath: '/work/project' } } } };
      let row: Record<string, unknown> = { ...fixture.machine, storageMode: 'e2ee' };
      const writes: string[] = [];
      // Axios is the genuine Home transport boundary; registration, crypto,
      // identity, CAS preparation and credential files remain real.
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        expect(url.startsWith('https://managed-home.test/')).toBe(true);
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (url.includes('/v1/machines/')) return { status: 200, data: { machine: row } };
        throw new Error('Unexpected Home read');
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url: string, body: unknown) => {
        expect(await persistence.readStoredCredentialsForServerId(configuration.activeServerId)).toMatchObject({ token: token('old'), encryption });
        if (!body || typeof body !== 'object') throw new Error('Missing Home request body');
        const input = body as Record<string, unknown>;
        if (url.endsWith('/content-key/transition')) {
          writes.push('transition');
          const next = input.next as Record<string, unknown>;
          expect(input.expected).toEqual({ dataEncryptionKey: fixture.machine.dataEncryptionKey, metadataVersion: 4, daemonStateVersion: 3 });
          row = { ...row, ...next, storageMode: 'plain', metadataVersion: 5, daemonStateVersion: 4 };
          return { status: 200, data: { kind: 'committed', machine: row } };
        }
        if (!url.endsWith('/v1/machines')) throw new Error('Unexpected Home write');
        writes.push('register');
        // Plain content has no active Account encryption pin, even when this
        // key-holding installation retains genuine predecessor custody.
        expect(input.contentPublicKeyFingerprint).toBeUndefined();
        expect(input.managedEnrollment).toEqual(managedEnrollment);
        expect(input.metadata).toBe(row.metadata);
        expect(input.dataEncryptionKey).toBe(row.dataEncryptionKey);
        if (denied) throw new axios.AxiosError('Managed enrollment was refused', 'ERR_BAD_REQUEST', undefined, undefined, {
          status: 403, statusText: 'Forbidden', data: { error: 'managed_enrollment_not_current' }, headers: {},
          config: { headers: new axios.AxiosHeaders() },
        });
        return { status: 200, data: { machine: row } };
      });
      const { registerAndPersistManagedTerminalEnrollmentCredential } = await import('./persistTerminalEnrollmentCredential');
      const completion = registerAndPersistManagedTerminalEnrollmentCredential({ token: token('new'), opened: { type: 'tokenOnly', authenticated: true },
        runtimeOrigin: 'https://managed-home.test', managedEnrollment,
        homeRetry: { deadlineMs: Date.now() + 5_000, pollIntervalMs: 1 }, assertCurrent() {} });
      if (denied) await expect(completion).rejects.toMatchObject({ isAxiosError: true, response: { status: 403, data: { error: 'managed_enrollment_not_current' } } });
      else await expect(completion).resolves.toMatchObject({ machineId: fixture.machine.id, encryptionType: 'tokenOnly' });
      expect(writes).toEqual(['transition', 'register']);
      if (denied) expect(await readFile(configuration.privateKeyFile, 'utf8')).toBe(originalCredentialBytes);
      expect(await persistence.readStoredCredentialsForServerId(configuration.activeServerId)).toMatchObject({ token: token(denied ? 'old' : 'new'), encryption });
    });
  });
});
