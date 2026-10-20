import { beforeEach, describe, expect, it, vi } from 'vitest';

const callExactMachineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callExactMachineRpc }));

import { buildSessionFollowSourceKeyPrepareRequestV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { encodeBase64 } from '@/api/encryption';
import { prepareSessionFollowSourceKey } from './prepareSessionFollowSourceKey';

const credentials = {
  token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
};

const dataKeyCredentials = {
  token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature',
  encryption: {
    type: 'dataKey' as const,
    publicKey: new Uint8Array(32).fill(8),
    machineKey: new Uint8Array(32).fill(9),
  },
};

describe('prepareSessionFollowSourceKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses one exact encrypted Machine call with matching outer and inner relation identities', async () => {
    callExactMachineRpc.mockResolvedValue({ v: 1, outcome: 'installed' });
    const result = await prepareSessionFollowSourceKey({
      credentials,
      homeServerIdentityId: 'home-1',
      machineId: 'machine-1',
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      sourceDataEncryptionKey: new Uint8Array(32).fill(9),
    });
    expect(result).toEqual({ kind: 'prepared' });
    expect(callExactMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE,
      expectedEncryptionMode: 'e2ee',
      requiredMachineKind: 'ephemeral_session_runner',
      requireCurrentMachine: true,
      expectedRunnerMachineContentKeyBinding: {
        homeServerIdentityId: 'home-1',
        creatorAccountId: 'account-1',
        machineId: 'machine-1',
      },
      // Built by the one Protocol owner both DEK-sending hosts use; a locally
      // assembled literal here is how the two hosts drift apart.
      ...buildSessionFollowSourceKeyPrepareRequestV1({
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
        sourceDataEncryptionKeyBase64: encodeBase64(new Uint8Array(32).fill(9)),
      }),
    }));
  });

  it('rejects malformed source material before opening a transport', async () => {
    await expect(prepareSessionFollowSourceKey({
      credentials,
      homeServerIdentityId: 'home-1',
      machineId: 'machine-1',
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      sourceDataEncryptionKey: new Uint8Array(31),
    })).rejects.toThrow();
    expect(callExactMachineRpc).not.toHaveBeenCalled();
  });

  it('carries exact admitted input custody in both sides of the encrypted Machine call', async () => {
    callExactMachineRpc.mockResolvedValue({ v: 1, outcome: 'installed' });
    expect(await prepareSessionFollowSourceKey({
      credentials, homeServerIdentityId: 'home-1', machineId: 'machine-1',
      sourceSessionId: 'source', destinationSessionId: 'destination',
      sourceDataEncryptionKey: new Uint8Array(32).fill(9), localInputId: 'admitted-original',
    })).toEqual({ kind: 'prepared' });
    expect(callExactMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      authorization: expect.objectContaining({ localInputId: 'admitted-original' }),
      request: expect.objectContaining({ localInputId: 'admitted-original' }),
    }));
  });

  it('prepares with DataKey credentials through the same independently trusted Runner scope', async () => {
    // The verifier identity is the creator-sealed fact on the published
    // binding, so a DataKey daemon reaches the same proof a legacy one does.
    callExactMachineRpc.mockResolvedValue({ v: 1, outcome: 'installed' });
    await expect(prepareSessionFollowSourceKey({
      credentials: dataKeyCredentials,
      homeServerIdentityId: 'home-1',
      machineId: 'machine-1',
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      sourceDataEncryptionKey: new Uint8Array(32).fill(9),
    })).resolves.toEqual({ kind: 'prepared' });
    expect(callExactMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      expectedRunnerMachineContentKeyBinding: {
        homeServerIdentityId: 'home-1',
        creatorAccountId: 'account-1',
        machineId: 'machine-1',
      },
    }));
  });

  it('reports a token-only daemon as waiting without opening an unverified Runner carrier', async () => {
    callExactMachineRpc.mockRejectedValue(Object.assign(new Error('unverified Runner key'), {
      code: 'machine_content_key_unavailable',
    }));
    await expect(prepareSessionFollowSourceKey({
      credentials: { token: credentials.token, encryption: null },
      homeServerIdentityId: 'home-1',
      machineId: 'machine-1',
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      sourceDataEncryptionKey: new Uint8Array(32).fill(9),
    })).resolves.toEqual({ kind: 'waiting', reason: 'runner_key_unavailable', cause: 'machine_content_key_unavailable' });
    expect(callExactMachineRpc).toHaveBeenCalledWith(expect.not.objectContaining({
      expectedRunnerMachineContentKeyBinding: expect.anything(),
    }));
  });

  it('reports an exact-machine currentness rejection as waiting instead of prepared', async () => {
    callExactMachineRpc.mockRejectedValue(Object.assign(new Error('revoked runner'), {
      code: 'machine_target_not_current',
    }));

    await expect(prepareSessionFollowSourceKey({
      credentials,
      homeServerIdentityId: 'home-1',
      machineId: 'machine-1',
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      sourceDataEncryptionKey: new Uint8Array(32).fill(9),
    })).resolves.toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'machine_target_not_current' });
  });

  it('does not require source-key preparation for a persistent destination Machine', async () => {
    callExactMachineRpc.mockRejectedValue(Object.assign(new Error('persistent machine'), {
      code: 'machine_kind_mismatch',
    }));

    await expect(prepareSessionFollowSourceKey({
      credentials: dataKeyCredentials,
      homeServerIdentityId: 'home-1',
      machineId: 'machine-1',
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      sourceDataEncryptionKey: new Uint8Array(32).fill(9),
    })).resolves.toEqual({ kind: 'not_needed' });
  });

  it('carries the exact external invocation proof to the destination Machine RPC', async () => {
    callExactMachineRpc.mockResolvedValue({ v: 1, outcome: 'installed' });
    const context = {
      externalActionExecutionAuthorization: { token: 'home-proof' },
      externalActionTarget: { kind: 'session', sessionId: 'destination' },
    } as never;
    const privateKey = new Uint8Array(64).fill(5);

    await prepareSessionFollowSourceKey({
      credentials,
      homeServerIdentityId: 'home-1',
      machineId: 'destination-machine',
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      sourceDataEncryptionKey: new Uint8Array(32).fill(9),
      externalAction: {
        context,
        effectActionId: 'follow.set',
        installationId: 'relay-installation',
        privateKey,
      },
    });

    expect(callExactMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'destination-machine',
      method: RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE,
      externalAction: {
        context,
        effectActionId: 'follow.set',
        installationId: 'relay-installation',
        privateKey,
      },
    }));
  });
});
