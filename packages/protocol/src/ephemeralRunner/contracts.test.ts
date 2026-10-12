import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '../crypto/base64.js';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import { RunnerRuntimeBootstrapV1Schema } from './bootstrap.js';
import { RunnerServerErrorV1Schema } from './errors.js';
import {
  computeRunnerMachineContentKeyFingerprintV1,
  openRunnerMachineContentKeyVerifierFactV1,
  sealRunnerMachineContentKeyVerifierFactV1,
  signRunnerMachineContentKeyBindingV1,
  verifyRunnerMachineContentKeyBindingV1,
} from './machineContentKeyBinding.js';
import { VerifiedEphemeralSessionRunnerPrincipalSchema } from './principal.js';
import { signRunnerEndpointProjectionProofV1, verifyRunnerEndpointProjectionProofV1 } from './endpointProjection.js';
import { RunnerMachineMaterializationInputV1Schema } from './materialization.js';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
} from '../machines/machineStoredContent.js';

describe('Runner authority contracts', () => {
  it('reads retained unsigned verifier facts while preserving their activation and Machine binding', () => {
    const payload = { v: 1, activationId: '00000000-0000-4000-8000-000000000001', machineId: 'machine',
      activationSigningPublicKey: encodeBase64(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey, 'base64url'), retired: true };
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const ciphertext = sealAccountScopedBlobCiphertext({ kind: 'runner_machine_content_key_verifier', material, payload,
      randomBytes: length => new Uint8Array(length).fill(5) });
    expect(openRunnerMachineContentKeyVerifierFactV1({ ciphertext, material,
      expectedActivationId: payload.activationId, expectedMachineId: payload.machineId })).toBe(payload.activationSigningPublicKey);
    expect(openRunnerMachineContentKeyVerifierFactV1({ ciphertext, material,
      expectedActivationId: payload.activationId, expectedMachineId: 'another-machine' })).toBeNull();
  });
  it('admits the server error for a declared but invalid Runner publication', () => {
    expect(RunnerServerErrorV1Schema.safeParse({
      error: 'runner_artifact_publication_invalid',
    }).success).toBe(true);
  });

  it('requires the canonical Plain Machine marker or a bound encrypted envelope', () => {
    const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const binding = signRunnerMachineContentKeyBindingV1({
      payload: {
        v: 1,
        purpose: 'happier.ephemeral-runner.machine-content-key',
        homeServerIdentityId: 'srv_runner',
        activationId: '00000000-0000-4000-8000-000000000006',
        creatorAccountId: 'creator',
        machineId: 'machine',
        installationId: 'installation',
        machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(new Uint8Array(32).fill(4)),
      },
      activationSigningSecretKey: signing.secretKey,
    });
    expect(RunnerMachineMaterializationInputV1Schema.safeParse({
      metadata: encodePlainMachineStoredContent({ host: 'runner.test' }),
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      runnerContentKeyBinding: null,
    }).success).toBe(true);
    expect(RunnerMachineMaterializationInputV1Schema.safeParse({
      metadata: encodePlainMachineStoredContent({ host: 'runner.test' }),
      dataEncryptionKey: null,
      runnerContentKeyBinding: null,
    }).success).toBe(false);
    expect(RunnerMachineMaterializationInputV1Schema.safeParse({
      metadata: 'opaque-encrypted-machine-metadata',
      dataEncryptionKey: 'opaque-runner-envelope',
      runnerContentKeyBinding: binding,
    }).success).toBe(true);
    expect(RunnerMachineMaterializationInputV1Schema.safeParse({
      metadata: 'opaque-encrypted-machine-metadata',
      dataEncryptionKey: 'opaque-runner-envelope',
      runnerContentKeyBinding: null,
    }).success).toBe(false);
    expect(RunnerMachineMaterializationInputV1Schema.safeParse({
      metadata: encodePlainMachineStoredContent({ host: 'runner.test' }),
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      runnerContentKeyBinding: binding,
    }).success).toBe(false);
  });

  it('binds the scoped Machine key to exact Home, activation, Account, Machine, and installation facts', () => {
    const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const payload = {
      v: 1 as const,
      purpose: 'happier.ephemeral-runner.machine-content-key' as const,
      homeServerIdentityId: 'srv_runner',
      activationId: '00000000-0000-4000-8000-000000000007',
      creatorAccountId: 'creator',
      machineId: 'machine',
      installationId: 'installation',
      machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(new Uint8Array(32).fill(9)),
    };
    const binding = signRunnerMachineContentKeyBindingV1({
      payload,
      activationSigningSecretKey: signing.secretKey,
    });
    const expectedKey = encodeBase64(signing.publicKey, 'base64url');
    expect(payload.machineContentKeyFingerprint).toBe(
      'runner-machine-content-key-sha256:8c0cc17a04942cc4f8e0fe0b302606d3108860c126428ba2ceeb5f9ed41c2b05',
    );
    expect(expectedKey).toBe('6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw');
    expect(binding.accountSignatureBase64Url).toBe(
      'h8UtzqzPU81E_i4z4eJqYPwZGXo05FBieteOwMbBsjf8bNuTvIZHPW3e364u5nctPk_Veqo_KD10Hcc_jNlACQ',
    );
    expect(verifyRunnerMachineContentKeyBindingV1({ binding, expectedPayload: payload, expectedAccountSigningPublicKey: expectedKey })).toEqual(binding);
    for (const key of ['homeServerIdentityId', 'activationId', 'creatorAccountId', 'machineId', 'installationId', 'machineContentKeyFingerprint'] as const) {
      expect(verifyRunnerMachineContentKeyBindingV1({
        binding,
        expectedPayload: { ...payload, [key]: key === 'activationId' ? '00000000-0000-4000-8000-000000000008' : `${payload[key]}-other` },
        expectedAccountSigningPublicKey: expectedKey,
      })).toBeNull();
    }
    expect(verifyRunnerMachineContentKeyBindingV1({ binding: { ...binding, authority: 'account' }, expectedPayload: payload, expectedAccountSigningPublicKey: expectedKey })).toBeNull();

    // The creator-sealed verifier fact rides beside the signature. It changes
    // no signed byte, and it cannot re-point the proof: a reader that opens a
    // different identity from it simply fails to verify.
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(11) };
    const carried = {
      ...binding,
      creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
        payload: {
          v: 1,
          activationId: payload.activationId,
          machineId: payload.machineId,
          activationSigningPublicKey: expectedKey,
        },
        material,
        randomBytes: (length: number) => new Uint8Array(length).fill(3),
      }),
    };
    expect(carried.accountSignatureBase64Url).toBe(binding.accountSignatureBase64Url);
    expect(verifyRunnerMachineContentKeyBindingV1({ binding: carried, expectedPayload: payload, expectedAccountSigningPublicKey: expectedKey })).toEqual(carried);
    expect(openRunnerMachineContentKeyVerifierFactV1({
      ciphertext: carried.creatorVerifierFactCiphertext,
      material,
      expectedActivationId: payload.activationId,
      expectedMachineId: payload.machineId,
    })).toBe(expectedKey);
    // Another Account's material, another Runner's identities, and a missing
    // fact all resolve nothing rather than a verifier the Home chose.
    expect(openRunnerMachineContentKeyVerifierFactV1({
      ciphertext: carried.creatorVerifierFactCiphertext,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(12) },
      expectedActivationId: payload.activationId,
      expectedMachineId: payload.machineId,
    })).toBeNull();
    expect(openRunnerMachineContentKeyVerifierFactV1({
      ciphertext: carried.creatorVerifierFactCiphertext,
      material,
      expectedActivationId: '00000000-0000-4000-8000-000000000008',
      expectedMachineId: payload.machineId,
    })).toBeNull();
    expect(openRunnerMachineContentKeyVerifierFactV1({
      ciphertext: null,
      material,
      expectedActivationId: payload.activationId,
      expectedMachineId: payload.machineId,
    })).toBeNull();
  });

  it('keeps Plain bootstrap keyless and requires both scoped keys for E2EE', () => {
    const common = {
      v: 1 as const,
      purpose: 'happier.ephemeral-session-runner.runtime' as const,
      homeServerIdentityId: 'home',
      activationId: '00000000-0000-4000-8000-000000000007',
      creatorAccountId: 'creator',
      sessionId: 'session', machineId: 'machine', installationId: 'installation',
      launchManifestCommitment: 'A'.repeat(43),
    };
    expect(RunnerRuntimeBootstrapV1Schema.safeParse({ ...common, storedContent: { mode: 'plain' }, machineContent: { mode: 'plain' } }).success).toBe(true);
    for (const field of ['homeServerIdentityId', 'creatorAccountId', 'installationId'] as const) {
      const { [field]: _missing, ...incomplete } = common;
      expect(RunnerRuntimeBootstrapV1Schema.safeParse({ ...incomplete, storedContent: { mode: 'plain' }, machineContent: { mode: 'plain' } }).success).toBe(false);
    }
    expect(RunnerRuntimeBootstrapV1Schema.safeParse({ ...common, storedContent: { mode: 'plain', sessionDataEncryptionKey: 'secret' }, machineContent: { mode: 'plain' } }).success).toBe(false);
    expect(RunnerRuntimeBootstrapV1Schema.safeParse({ ...common, storedContent: { mode: 'e2ee' }, machineContent: { mode: 'e2ee' } }).success).toBe(false);
  });

  it('rejects unknown principal authority fields', () => {
    const principal = {
      kind: 'ephemeral_session_runner', authority: 'session_runtime', accountId: 'creator',
      activationId: '00000000-0000-4000-8000-000000000007', sessionId: 'session', machineId: 'machine',
      installationId: 'installation', installationPublicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey, 'base64url'), creatorTokenEpoch: 1,
    };
    expect(VerifiedEphemeralSessionRunnerPrincipalSchema.safeParse(principal).success).toBe(true);
    expect(VerifiedEphemeralSessionRunnerPrincipalSchema.safeParse({ ...principal, isAdmin: true }).success).toBe(false);
    expect(VerifiedEphemeralSessionRunnerPrincipalSchema.safeParse({ ...principal, sessionId: 'other' }).success).toBe(true);
  });

  it('rejects endpoint projection proof substitution across the reserved binding', () => {
    const activation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
    const payload = {
      v: 1 as const, purpose: 'happier.ephemeral-session-runner.endpoint-projection' as const,
      activationId: '00000000-0000-4000-8000-000000000011', sessionId: 'session', machineId: 'machine',
      launchManifestCommitment: null, creatorTokenEpoch: 3,
    };
    const request = signRunnerEndpointProjectionProofV1({ payload, activationSecretKey: activation.secretKey, installationSecretKey: installation.secretKey });
    const keys = { activationSigningPublicKey: encodeBase64(activation.publicKey, 'base64url'), installationPublicKey: encodeBase64(installation.publicKey, 'base64url') };
    expect(verifyRunnerEndpointProjectionProofV1({ request, expectedPayload: payload, ...keys })).toEqual(request);
    expect(verifyRunnerEndpointProjectionProofV1({ request, expectedPayload: { ...payload, machineId: 'substitute' }, ...keys })).toBeNull();
    expect(verifyRunnerEndpointProjectionProofV1({ request: { ...request, accountId: 'creator' }, expectedPayload: payload, ...keys })).toBeNull();
  });
});
