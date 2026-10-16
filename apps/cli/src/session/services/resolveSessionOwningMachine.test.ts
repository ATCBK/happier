import { describe, expect, it } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  sealSessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { resolveSessionOwningMachineId } from './resolveSessionOwningMachine';

describe('resolveSessionOwningMachineId', () => {
  it.each(['plain', 'e2ee'] as const)('reads layout-one locality under the persisted %s Account mode', accountEncryptionMode => {
    const secret = new Uint8Array(32).fill(19);
    const ownerMetadata = { v: 1 as const, workspace: { machineId: 'session-machine' } };
    const ownerEnvelope = accountEncryptionMode === 'plain'
      ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata)
      : sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret }, ownerMetadata,
        randomBytes: length => new Uint8Array(length).fill(11) });
    const input = {
      credentials: { token: 'test-token', encryption: accountEncryptionMode === 'plain'
        ? null : { type: 'legacy' as const, secret } },
      accountEncryptionMode,
      rawSession: { metadataLayoutVersion: 1, encryptionMode: 'plain',
        metadata: JSON.stringify({ v: 1 }), ownerMetadata: ownerEnvelope },
    };
    expect(resolveSessionOwningMachineId(input)).toEqual({ ok: true, machineId: 'session-machine' });
    expect(resolveSessionOwningMachineId({ ...input,
      accountEncryptionMode: accountEncryptionMode === 'plain' ? 'e2ee' : 'plain',
    })).toEqual({ ok: false });
  });

  it('refuses layout-one routing without readable owner locality instead of choosing caller-local control', () => {
    const input = {
      credentials: { token: 'test-token', encryption: null }, accountEncryptionMode: 'plain' as const,
      rawSession: { metadataLayoutVersion: 1, encryptionMode: 'plain', metadata: JSON.stringify({ v: 1 }),
        machineId: 'untrusted-public-machine' },
    };
    expect(resolveSessionOwningMachineId(input)).toEqual({ ok: false });
  });
});
