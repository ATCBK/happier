import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StoredJsonContentEnvelopeSchema,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

import { ApiClient } from './api';
import { decodeBase64, encodeBase64, encrypt, getRandomBytes } from './encryption';
import tweetnacl from 'tweetnacl';
import predecessor from './machine/machineLegacyContent.predecessor.fixture.json';

const mockPost = vi.fn();
const mockGet = vi.fn();

vi.mock('axios', () => ({
  default: {
    post: (...args: unknown[]) => mockPost(...args),
    get: (...args: unknown[]) => mockGet(...args),
    isAxiosError: (value: unknown) => typeof value === 'object' && value !== null && 'isAxiosError' in value && value.isAxiosError === true,
  },
  isAxiosError: (value: unknown) => typeof value === 'object' && value !== null && 'isAxiosError' in value && value.isAxiosError === true,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.com',
    apiServerUrl: 'https://api.example.com',
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));


function decodeEnvelope(value: string) {
  return StoredJsonContentEnvelopeSchema.parse(
    JSON.parse(Buffer.from(decodeBase64(value)).toString('utf8')),
  );
}

describe('ApiClient.getOrCreateMachine plaintext account storage', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();

  });

  it('writes and reads machine state without consulting account encryption material', async () => {
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/v1/machines/')) throw { isAxiosError: true, response: { status: 404 } };
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    });
    mockPost.mockImplementation(async (_url: string, body: Record<string, unknown>) => {
      expect(decodeEnvelope(String(body.metadata))).toEqual({
        t: 'plain',
        v: expect.objectContaining({ host: 'plain-host' }),
      });
      expect(decodeEnvelope(String(body.daemonState))).toEqual({
        t: 'plain',
        v: { status: 'running' },
      });
      expect(decodeEnvelope(String(body.dataEncryptionKey))).toEqual({ t: 'plain', v: null });
      expect(body).not.toHaveProperty('contentPublicKey');

      return {
        data: {
          machine: {
            id: 'machine-plain-1',
            metadata: body.metadata,
            metadataVersion: 1,
            daemonState: body.daemonState,
            daemonStateVersion: 1,
            dataEncryptionKey: body.dataEncryptionKey,
          },
        },
      };
    });

    const api = await ApiClient.create({
      token: 'token-test',
      encryption: null,
    });
    const machine = await api.getOrCreateMachine({
      machineId: 'machine-plain-1',
      metadata: {
        host: 'plain-host',
        homeDir: '/home/plain',
        platform: 'linux',
        happyCliVersion: '0.0.0-test',
        happyHomeDir: '/home/plain/.happier',
        happyLibDir: '/home/plain/.happier/lib',
      },
      daemonState: {
        status: 'running',
        serviceLabel: undefined,
      },
    });

    expect(machine).toMatchObject({
      id: 'machine-plain-1',
      encryptionMode: 'plain',
      metadata: { host: 'plain-host' },
      daemonState: { status: 'running' },
    });
  });

  it('recovers exact predecessor Machine blobs before registering an already-plain Account', async () => {
    const fixture = predecessor.rows.find(row => row.credentialKind === 'dataKey')!;
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    let row: Record<string, unknown> = { ...fixture.machine, storageMode: 'e2ee', contentPublicKeyFingerprint: 'old-key' };
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/v1/machines/')) return { status: 200, data: { machine: row } };
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    });
    mockPost.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/content-key/transition')) {
        const next = body.next as Record<string, unknown>;
        expect(decodeEnvelope(String(next.metadata))).toEqual({ t: 'plain', v: predecessor.openedMetadata });
        expect(decodeEnvelope(String(next.daemonState))).toEqual({ t: 'plain', v: predecessor.openedDaemonState });
        expect(body.expected).toEqual({ dataEncryptionKey: fixture.machine.dataEncryptionKey, metadataVersion: 4, daemonStateVersion: 3 });
        row = { ...row, ...next, storageMode: 'plain', metadataVersion: 5, daemonStateVersion: 4, contentPublicKeyFingerprint: null };
        return { status: 200, data: { kind: 'committed', machine: row } };
      }
      expect(body.metadata).toBe(row.metadata);
      expect(body.daemonState).toBe(row.daemonState);
      expect(body.dataEncryptionKey).toBe(row.dataEncryptionKey);
      return { status: 200, data: { machine: row } };
    });
    const api = await ApiClient.create({ token, encryption: { type: 'dataKey', machineKey: decodeBase64(fixture.accountSecret), publicKey: decodeBase64(fixture.accountPublicKey!) } });
    const machine = await api.getOrCreateMachine({ machineId: fixture.machine.id,
      metadata: { host: 'current-host', platform: 'linux', happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happier' } });
    expect(machine).toMatchObject({ encryptionMode: 'plain', metadata: { displayName: 'User edit' }, daemonState: predecessor.openedDaemonState });
    expect(mockPost.mock.calls.map(([url]) => String(url).endsWith('/content-key/transition'))).toEqual([true, false]);
  });

  it('keeps predecessor Machine bytes locked when the historical key is unavailable', async () => {
    const fixture = predecessor.rows.find(row => row.credentialKind === 'dataKey')!;
    mockGet.mockImplementation(async (url: string) => url.includes('/v1/machines/')
      ? { status: 200, data: { machine: fixture.machine } }
      : { status: 200, data: { mode: 'plain', updatedAt: 1 } });
    const api = await ApiClient.create({ token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null });
    await expect(api.getOrCreateMachine({ machineId: fixture.machine.id,
      metadata: { host: 'current-host', platform: 'linux', happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happier' } }))
      .rejects.toMatchObject({ code: 'machine_content_key_unavailable' });
    expect(mockPost).not.toHaveBeenCalled();
  });


});


describe('ApiClient.getMachine published content key', () => {
  it('opens metadata and returns the selected scoped transport key instead of the Account key', async () => {
    const machineKey = new Uint8Array(32).fill(11);
    const scopedKey = new Uint8Array(32).fill(29);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const metadata = { host: 'scoped-host', homeDir: '/tmp/scoped', platform: 'linux',
      happyCliVersion: '0.0.0-test', happyHomeDir: '/tmp/scoped/.happier' };
    mockGet.mockImplementation(async (url: string) => url.endsWith('/v1/machines/scoped')
      ? { data: { machine: {
        id: 'scoped',
        dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: scopedKey, recipientPublicKey: publicKey, randomBytes: getRandomBytes })),
        metadata: encodeBase64(encrypt(scopedKey, 'dataKey', metadata)), metadataVersion: 1,
        daemonState: null, daemonStateVersion: 0,
      } } }
      : { status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    const api = await ApiClient.create({ token: 'token-test', encryption: { type: 'dataKey', machineKey, publicKey } });
    await expect(api.getMachine('scoped')).resolves.toMatchObject({
      id: 'scoped', metadata, encryptionMode: 'e2ee', encryptionKey: scopedKey, encryptionVariant: 'dataKey',
    });
  });
});
