import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { resolveTerminalProvisioningMaterial } from './terminalProvisioningMaterial';

describe('authenticated Account provisioning mode', () => {
  const machineKey = new Uint8Array(32).fill(3);
  const credentials = { token: 'fixture', encryption: { type: 'dataKey' as const,
    publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey, machineKey } };
  const e2ee = { mode: 'e2ee' as const, contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(credentials.encryption.publicKey) };
  it('never exports retained historical keys from a plain Account', () => {
    expect(resolveTerminalProvisioningMaterial(credentials, { mode: 'plain', contentKeyFingerprint: null })).toEqual({ kind: 'tokenOnly' });
  });
  it('exports genuine material only for an authenticated E2EE Account', () => {
    expect(resolveTerminalProvisioningMaterial(credentials, e2ee)).toEqual({ kind: 'dataKey', contentPrivateKey: machineKey });
    expect(() => resolveTerminalProvisioningMaterial({ token: 'fixture', encryption: null }, e2ee)).toThrow();
    expect(() => resolveTerminalProvisioningMaterial(credentials, null)).toThrow();
    expect(() => resolveTerminalProvisioningMaterial(credentials, { ...e2ee, contentKeyFingerprint: null })).toThrow();
  });
  it('refuses a retained key that differs from current Account content fingerprint', () => {
    expect(() => resolveTerminalProvisioningMaterial(credentials, { ...e2ee, contentKeyFingerprint: 'aemk1_another-key' })).toThrow();
  });

});
