import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import {
  deriveAccountMachineKeyFromRecoverySecret,
  sealEncryptedDataKeyEnvelopeV1,
  computeRunnerMachineContentKeyFingerprintV1,
  sealRunnerMachineContentKeyVerifierFactV1,
  signRunnerMachineContentKeyBindingV1,
  type SessionFollowSourceKeyPreparationResultV1,
} from '@happier-dev/protocol';
import nacl from 'tweetnacl';

import { encodeBase64 } from '@/api/encryption';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const resolveSessionTransportContext = vi.hoisted(() => vi.fn());
const resolveSessionOwningMachineId = vi.hoisted(() => vi.fn());
const prepareSessionFollowSourceKey = vi.hoisted(() => vi.fn());
const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({ resolveSessionTransportContext }));
vi.mock('@/session/services/resolveSessionOwningMachine', () => ({ resolveSessionOwningMachineId }));
vi.mock('./prepareSessionFollowSourceKey', () => ({ prepareSessionFollowSourceKey }));

// Captures, without replacing, the canonical opener so hygiene tests can
// observe the exact sender-owned buffer the production path opened. The real
// envelope crypto stays live beneath this wrapper.
const openSessionDataEncryptionKey = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/openSessionDataEncryptionKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client/openSessionDataEncryptionKey')>();
  openSessionDataEncryptionKey.mockImplementation(actual.openSessionDataEncryptionKey);
  return { openSessionDataEncryptionKey };
});

import { createSessionFollowSourceKeyPreparationAfterSet } from './createSessionFollowSourceKeyPreparationAfterSet';

const destination = {
  ok: true as const,
  sessionId: 'destination',
  rawSession: { id: 'destination', encryptionMode: 'e2ee' },
  accountEncryptionCurrentness: { mode: 'e2ee' },
  mode: 'e2ee' as const,
  ctx: { encryptionKey: new Uint8Array(32).fill(4), encryptionVariant: 'dataKey' as const },
};

function sealSourceEnvelope(dataKeyFill: number) {
  const accountKey = new Uint8Array(32).fill(11);
  const recipientPublicKey = nacl.box.keyPair.fromSecretKey(accountKey).publicKey;
  const sourceDataEncryptionKey = new Uint8Array(32).fill(dataKeyFill);
  const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: sourceDataEncryptionKey,
    recipientPublicKey,
    randomBytes: (length) => new Uint8Array(length).fill(17),
  }));
  return {
    credentials: {
      token: 'data-key-token',
      encryption: { type: 'dataKey' as const, publicKey: recipientPublicKey, machineKey: accountKey },
    },
    sourceDataEncryptionKey,
    envelope,
  };
}

function mockSourceAndDestination(envelope: string) {
  resolveSessionTransportContext
    .mockResolvedValueOnce({
      ok: true,
      sessionId: 'source',
      rawSession: { id: 'source', encryptionMode: 'e2ee', dataEncryptionKey: envelope },
      accountEncryptionCurrentness: { mode: 'e2ee' },
      mode: 'e2ee',
      ctx: { encryptionKey: new Uint8Array(32).fill(99), encryptionVariant: 'dataKey' as const },
    })
    .mockResolvedValueOnce(destination);
}

function openedSourceKey(): Uint8Array {
  const opened = openSessionDataEncryptionKey.mock.results.at(-1)?.value;
  if (!(opened instanceof Uint8Array)) {
    throw new Error('canonical opener did not return a buffer');
  }
  return opened;
}

function createPreparation(credentials: Parameters<typeof createSessionFollowSourceKeyPreparationAfterSet>[0]['credentials']) {
  return createSessionFollowSourceKeyPreparationAfterSet({
    credentials,
    serverHttpBaseUrl: 'https://home.example',
    serverIdentityId: 'home-1',
  });
}

let restoreRunnerHttp = () => {};
async function useRealRunnerPreparation(credentials: Parameters<typeof createPreparation>[0]) {
  const encryption = credentials.encryption;
  if (!encryption) throw new Error('Encrypted Runner fixture needs Account material');
  const seed = encryption.type === 'legacy' ? deriveAccountMachineKeyFromRecoverySecret(encryption.secret) : encryption.machineKey;
  const runnerKey = new Uint8Array(32).fill(47);
  const signing = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(53));
  const randomBytes = (length: number) => new Uint8Array(length).fill(59);
  const payload = { v: 1 as const, purpose: 'happier.ephemeral-runner.machine-content-key' as const,
    homeServerIdentityId: 'home-1', creatorAccountId: 'account-1', machineId: 'machine-1',
    activationId: '11111111-1111-4111-8111-111111111111', installationId: 'runner-installation',
    machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(runnerKey) };
  // Substitute only the authenticated Machine HTTP read and Socket.IO boundary.
  // The real preparer, Machine trust and private request construction stay live.
  const machineRead = vi.spyOn(axios, 'get').mockResolvedValue({ data: { machine: {
    id: 'machine-1', kind: 'ephemeral_session_runner', storageMode: 'e2ee', installationId: payload.installationId,
    dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: runnerKey,
      recipientPublicKey: nacl.box.keyPair.fromSecretKey(seed).publicKey, randomBytes })),
    runnerContentKeyBinding: { ...signRunnerMachineContentKeyBindingV1({ payload, activationSigningSecretKey: signing.secretKey }),
      creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
        payload: { v: 1, activationId: payload.activationId, machineId: 'machine-1',
          activationSigningPublicKey: encodeBase64(signing.publicKey, 'base64url') }, material: encryption, randomBytes }),
    },
  } } });
  restoreRunnerHttp = () => machineRead.mockRestore();
  const socket = createApiSessionSocketStub();
  io.mockReturnValue(socket);
  const actual = await vi.importActual<typeof import('./prepareSessionFollowSourceKey')>('./prepareSessionFollowSourceKey');
  prepareSessionFollowSourceKey.mockImplementation(actual.prepareSessionFollowSourceKey);
  return socket;
}

afterEach(() => { restoreRunnerHttp(); restoreRunnerHttp = () => {}; });

describe('createSessionFollowSourceKeyPreparationAfterSet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionOwningMachineId.mockReturnValue({ ok: true, machineId: 'machine-1' });
    prepareSessionFollowSourceKey.mockResolvedValue({ kind: 'prepared' });
  });

  it.each([
    {
      name: 'legacy Account secret',
      credentials: {
        token: 'legacy-token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
      },
      fallbackKey: new Uint8Array(32).fill(7),
      fallbackVariant: 'legacy' as const,
    },
    {
      name: 'Account machine key',
      credentials: {
        token: 'data-key-token',
        encryption: {
          type: 'dataKey' as const,
          publicKey: new Uint8Array(32).fill(8),
          machineKey: new Uint8Array(32).fill(9),
        },
      },
      fallbackKey: new Uint8Array(32).fill(9),
      fallbackVariant: 'dataKey' as const,
    },
  ])('does not transfer an absent-envelope $name fallback', async ({ credentials, fallbackKey, fallbackVariant }) => {
    const authenticated = { ...credentials, token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature' };
    const socket = await useRealRunnerPreparation(authenticated);
    resolveSessionTransportContext
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'source',
        rawSession: { id: 'source', encryptionMode: 'e2ee', dataEncryptionKey: null },
        accountEncryptionCurrentness: { mode: 'e2ee' },
        mode: 'e2ee',
        ctx: { encryptionKey: fallbackKey, encryptionVariant: fallbackVariant },
      })
      .mockResolvedValueOnce(destination);

    await expect(createPreparation(authenticated)({
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      context: {} as never,
    })).resolves.toEqual({ kind: 'waiting', reason: 'source_key_unavailable', cause: 'source_key_unavailable' });

    expect(socket.emitWithAck).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('opens the physical source envelope and transfers exactly its standalone Session DEK', async () => {
    const accountKey = new Uint8Array(32).fill(11);
    const recipientPublicKey = nacl.box.keyPair.fromSecretKey(accountKey).publicKey;
    const sourceDataEncryptionKey = new Uint8Array(32).fill(23);
    const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: sourceDataEncryptionKey,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(17),
    }));
    const credentials = {
      token: 'data-key-token',
      encryption: { type: 'dataKey' as const, publicKey: recipientPublicKey, machineKey: accountKey },
    };
    resolveSessionTransportContext
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'source',
        rawSession: { id: 'source', encryptionMode: 'e2ee', dataEncryptionKey: envelope },
        accountEncryptionCurrentness: { mode: 'e2ee' },
        mode: 'e2ee',
        // The generic transport context is not the transferable-key owner. A
        // producer that forwards this field would send the wrong 32-byte key.
        ctx: { encryptionKey: new Uint8Array(32).fill(99), encryptionVariant: 'dataKey' },
      })
      .mockResolvedValueOnce(destination);

    // Capture the bytes at call time: the opened buffer is zeroized after the
    // outcome, so stored mock arguments no longer preserve the observed bytes.
    let observedAtCall: Uint8Array | undefined;
    prepareSessionFollowSourceKey.mockImplementation(async (input: {
      sourceDataEncryptionKey: Uint8Array;
    }) => {
      observedAtCall = Uint8Array.from(input.sourceDataEncryptionKey);
      return { kind: 'prepared' as const };
    });

    await expect(createPreparation(credentials)({
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      context: {} as never,
    })).resolves.toEqual({ kind: 'prepared' });

    expect(prepareSessionFollowSourceKey).toHaveBeenCalledTimes(1);
    expect(observedAtCall).toEqual(sourceDataEncryptionKey);
    expect(prepareSessionFollowSourceKey).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
    }));
  });

  it('uses the authenticated feature-snapshot Home identity carried by Action context', async () => {
    const { credentials, sourceDataEncryptionKey, envelope } = sealSourceEnvelope(27);
    mockSourceAndDestination(envelope);
    let observedHomeServerIdentityId: string | undefined;
    prepareSessionFollowSourceKey.mockImplementation(async (input: {
      homeServerIdentityId: string;
      sourceDataEncryptionKey: Uint8Array;
    }) => {
      observedHomeServerIdentityId = input.homeServerIdentityId;
      expect(input.sourceDataEncryptionKey).toEqual(sourceDataEncryptionKey);
      return { kind: 'prepared' as const };
    });
    const preparation = createSessionFollowSourceKeyPreparationAfterSet({
      credentials,
      serverHttpBaseUrl: 'https://home.example',
    });

    await expect(preparation({
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      // createCliActionExecutorFromCredentials enriches this from the exact
      // authenticated feature snapshot before invoking the Follow owner.
      context: { serverIdentityId: 'srv_snapshot_home' },
    })).resolves.toEqual({ kind: 'prepared' });

    expect(observedHomeServerIdentityId).toBe('srv_snapshot_home');
  });

  it('returns the current DataKey Runner trust outcome instead of treating an opened source as prepared', async () => {
    const accountKey = new Uint8Array(32).fill(41);
    const recipientPublicKey = nacl.box.keyPair.fromSecretKey(accountKey).publicKey;
    const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: new Uint8Array(32).fill(43),
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(17),
    }));
    const credentials = {
      token: 'data-key-token',
      encryption: { type: 'dataKey' as const, publicKey: recipientPublicKey, machineKey: accountKey },
    };
    resolveSessionTransportContext
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'source',
        rawSession: { id: 'source', encryptionMode: 'e2ee', dataEncryptionKey: envelope },
        accountEncryptionCurrentness: { mode: 'e2ee' },
        mode: 'e2ee',
        ctx: { encryptionKey: accountKey, encryptionVariant: 'dataKey' },
      })
      .mockResolvedValueOnce(destination);
    prepareSessionFollowSourceKey.mockResolvedValue({
      kind: 'waiting',
      reason: 'runner_key_unavailable',
    });

    await expect(createPreparation(credentials)({
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      context: {} as never,
    })).resolves.toEqual({ kind: 'waiting', reason: 'runner_key_unavailable' });
  });

  it.each([
    { name: 'malformed', dataEncryptionKey: 'not-an-envelope' },
    { name: 'unopenable', dataEncryptionKey: encodeBase64(new Uint8Array(105)) },
  ])('fails closed for a $name physical source envelope', async ({ dataEncryptionKey }) => {
    const secret = new Uint8Array(32).fill(13);
    const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: { type: 'legacy' as const, secret } };
    const socket = await useRealRunnerPreparation(credentials);
    resolveSessionTransportContext
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'source',
        rawSession: { id: 'source', encryptionMode: 'e2ee', dataEncryptionKey },
        accountEncryptionCurrentness: { mode: 'e2ee' },
        mode: 'e2ee',
        ctx: { encryptionKey: secret, encryptionVariant: 'dataKey' },
      })
      .mockResolvedValueOnce(destination);

    await expect(createPreparation(credentials)({
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      context: {} as never,
    })).resolves.toEqual({ kind: 'waiting', reason: 'source_key_unavailable', cause: 'source_key_unavailable' });

    expect(socket.emitWithAck).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it.each(['wrong_machine', 'revoked_machine'] as const)(
    'keeps the committed edge waiting when destination custody rejects a $name',
    async (code) => {
      const secret = new Uint8Array(32).fill(19);
      const contentKey = deriveAccountMachineKeyFromRecoverySecret(secret);
      const recipientPublicKey = nacl.box.keyPair.fromSecretKey(contentKey).publicKey;
      const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
        dataKey: new Uint8Array(32).fill(29),
        recipientPublicKey,
        randomBytes: (length) => new Uint8Array(length).fill(5),
      }));
      const credentials = {
        token: 'legacy-token',
        encryption: { type: 'legacy' as const, secret },
      };
      resolveSessionTransportContext
        .mockResolvedValueOnce({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'e2ee', dataEncryptionKey: envelope },
          accountEncryptionCurrentness: { mode: 'e2ee' },
          mode: 'e2ee',
          ctx: { encryptionKey: secret, encryptionVariant: 'legacy' },
        })
        .mockResolvedValueOnce(destination);
      resolveSessionOwningMachineId.mockReturnValue({ ok: false, code });

      await expect(createPreparation(credentials)({
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
        context: {} as never,
      })).resolves.toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'destination_machine_unresolved' });
      expect(prepareSessionFollowSourceKey).not.toHaveBeenCalled();
    },
  );

  it('opens a legacy credential envelope through the canonical Account content-key derivation', async () => {
    const recoverySecret = new Uint8Array(32).fill(31);
    const contentKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const recipientPublicKey = nacl.box.keyPair.fromSecretKey(contentKey).publicKey;
    const sourceDataEncryptionKey = new Uint8Array(32).fill(29);
    const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: sourceDataEncryptionKey,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(3),
    }));
    const credentials = {
      token: 'legacy-token',
      encryption: { type: 'legacy' as const, secret: recoverySecret },
    };
    resolveSessionTransportContext
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'source',
        rawSession: { id: 'source', encryptionMode: 'e2ee', dataEncryptionKey: envelope },
        accountEncryptionCurrentness: { mode: 'e2ee' },
        mode: 'e2ee',
        ctx: { encryptionKey: new Uint8Array(32).fill(99), encryptionVariant: 'dataKey' },
      })
      .mockResolvedValueOnce(destination);

    let observedAtCall: Uint8Array | undefined;
    prepareSessionFollowSourceKey.mockImplementation(async (input: {
      sourceDataEncryptionKey: Uint8Array;
    }) => {
      observedAtCall = Uint8Array.from(input.sourceDataEncryptionKey);
      return { kind: 'prepared' as const };
    });

    await expect(createPreparation(credentials)({
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      context: {} as never,
    })).resolves.toEqual({ kind: 'prepared' });

    expect(observedAtCall).toEqual(sourceDataEncryptionKey);
  });

  describe('opened sender-owned source DEK hygiene', () => {
    let observedAtCall: Uint8Array | undefined;
    let receivedReference: Uint8Array | undefined;

    const observePreparerInput = (input: {
      sourceDataEncryptionKey: Uint8Array;
      signal?: AbortSignal;
    }) => {
      receivedReference = input.sourceDataEncryptionKey;
      observedAtCall = Uint8Array.from(input.sourceDataEncryptionKey);
    };

    const prepareWithOutcome = (
      outcome: SessionFollowSourceKeyPreparationResultV1 | Promise<SessionFollowSourceKeyPreparationResultV1>,
    ) => {
      prepareSessionFollowSourceKey.mockImplementation(async (input: {
        sourceDataEncryptionKey: Uint8Array;
        signal?: AbortSignal;
      }) => {
        observePreparerInput(input);
        return await outcome;
      });
    };

    const expectDownstreamObservedOriginalBeforeCleanup = (fixtureKey: Uint8Array) => {
      // The downstream RPC preparer encoded the original bytes before cleanup.
      expect(observedAtCall).toEqual(fixtureKey);
      // It received exactly the sender-owned opened buffer, not an escaping copy.
      const opened = openedSourceKey();
      expect(receivedReference).toBe(opened);
      // That buffer is zeroized once the outcome is decided.
      expect(opened).toEqual(new Uint8Array(fixtureKey.length));
      // The seal-time fixture key is caller-owned and must stay intact.
      expect(fixtureKey).not.toEqual(new Uint8Array(fixtureKey.length));
    };

    beforeEach(() => {
      observedAtCall = undefined;
      receivedReference = undefined;
    });

    it.each([
      { name: 'not-needed', outcome: { kind: 'not_needed' } },
      { name: 'prepared', outcome: { kind: 'prepared' } },
      { name: 'waiting', outcome: { kind: 'waiting', reason: 'runner_key_unavailable' } },
    ] as const)('zeroizes the opened source key after a $name outcome', async ({ outcome }) => {
      const { credentials, sourceDataEncryptionKey, envelope } = sealSourceEnvelope(23);
      mockSourceAndDestination(envelope);
      prepareWithOutcome(outcome);

      await expect(createPreparation(credentials)({
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
        context: {} as never,
      })).resolves.toEqual(outcome);

      expectDownstreamObservedOriginalBeforeCleanup(sourceDataEncryptionKey);
    });

    it('zeroizes the opened source key when the preparer throws', async () => {
      const { credentials, sourceDataEncryptionKey, envelope } = sealSourceEnvelope(29);
      mockSourceAndDestination(envelope);
      prepareWithOutcome(Promise.reject(new Error('rpc failure')));

      await expect(createPreparation(credentials)({
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
        context: {} as never,
      })).resolves.toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'preparation_exception' });

      expectDownstreamObservedOriginalBeforeCleanup(sourceDataEncryptionKey);
    });

    it('zeroizes the opened source key when the preparer is aborted', async () => {
      const { credentials, sourceDataEncryptionKey, envelope } = sealSourceEnvelope(31);
      mockSourceAndDestination(envelope);
      const controller = new AbortController();
      prepareSessionFollowSourceKey.mockImplementation(async (input: {
        sourceDataEncryptionKey: Uint8Array;
        signal?: AbortSignal;
      }) => {
        observePreparerInput(input);
        input.signal?.throwIfAborted();
        return { kind: 'prepared' as const };
      });
      controller.abort();

      await expect(createPreparation(credentials)({
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
        context: {} as never,
        signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });

      expectDownstreamObservedOriginalBeforeCleanup(sourceDataEncryptionKey);
    });

    it('zeroizes the opened source key when home identity is missing after the open', async () => {
      const { credentials, sourceDataEncryptionKey, envelope } = sealSourceEnvelope(37);
      mockSourceAndDestination(envelope);
      const preparation = createSessionFollowSourceKeyPreparationAfterSet({
        credentials,
        serverHttpBaseUrl: 'https://home.example',
      });

      await expect(preparation({
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
        context: {} as never,
      })).resolves.toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'home_identity_unavailable' });

      expect(prepareSessionFollowSourceKey).not.toHaveBeenCalled();
      expect(openedSourceKey()).toEqual(new Uint8Array(sourceDataEncryptionKey.length));
      expect(sourceDataEncryptionKey).toEqual(new Uint8Array(32).fill(37));
    });

    it('zeroizes the opened source key when destination custody is rejected after the open', async () => {
      const { credentials, sourceDataEncryptionKey, envelope } = sealSourceEnvelope(41);
      mockSourceAndDestination(envelope);
      resolveSessionOwningMachineId.mockReturnValue({ ok: false, code: 'wrong_machine' });

      await expect(createPreparation(credentials)({
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
        context: {} as never,
      })).resolves.toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'destination_machine_unresolved' });

      expect(prepareSessionFollowSourceKey).not.toHaveBeenCalled();
      expect(openedSourceKey()).toEqual(new Uint8Array(sourceDataEncryptionKey.length));
      expect(sourceDataEncryptionKey).toEqual(new Uint8Array(32).fill(41));
    });
  });
});
