import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '../../crypto/base64.js';
import { signMachineInstallationProof } from '../../machines/identity/installationIdentity.js';
import { signRunnerClaimV1 } from '../../ephemeralRunner/endpoint.js';
import {
  IrohMachineAdmissionHandshakeV1Schema,
} from '../../connectivity/iroh/machineAdmissionHandshakeV1.js';
import { IrohMachineHandshakeV1Schema } from '../../connectivity/iroh/machineHandshakeV1.js';
import {
  createRunnerBrokerReadinessSigningInputV1,
  doesRunnerBrokerReadinessResponseMatchRequestV1,
  IrohRunnerBrokerReadinessHandshakeV1Schema,
  RunnerBrokerReadinessResponseV1Schema,
  RunnerBrokerReadinessRequestV1Schema,
  TeamCredentialResourceReadinessV1Schema,
  signRunnerBrokerReadinessRequestV1,
  verifyRunnerBrokerReadinessRequestV1,
} from './readinessV1.js';
import { TeamCredentialUsageLimitMetricV1Schema } from './usageV1.js';

function fixture() {
  const activationKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
  const installationKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
  const boxKey = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3));
  const binding = {
    activationId: '00000000-0000-4000-8000-000000000001',
    homeServerIdentityId: 'srv_runner_broker_readiness',
    creatorAccountId: 'creator-account',
    creatorTokenEpoch: 3,
    activationExpiresAt: null,
    workspace: { kind: 'choose_on_endpoint' as const },
    sessionId: 'reserved-session',
    machineId: 'reserved-machine',
    authoringCommitment: encodeBase64(new Uint8Array(32).fill(4), 'base64url'),
    activationSigningPublicKey: encodeBase64(activationKey.publicKey, 'base64url'),
    artifact: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
    endpointFactsRecipient: { mode: 'plain' as const, creatorAccountId: 'creator-account' },
  };
  const claimPayload = {
    v: 1 as const,
    purpose: 'happier.ephemeral-session-runner.claim' as const,
    binding,
    runnerBoxPublicKey: encodeBase64(boxKey.publicKey, 'base64url'),
    installation: {
      installationId: 'runner-installation',
      publicKey: encodeBase64(installationKey.publicKey, 'base64url'),
      proof: signMachineInstallationProof({
        payload: {
          version: 1,
          installationId: 'runner-installation',
          machineId: binding.machineId,
          accountId: binding.creatorAccountId,
        },
        privateKey: installationKey.secretKey,
      }),
    },
    protocolEpoch: 1 as const,
  };
  const claim = signRunnerClaimV1({ payload: claimPayload, activationSecretKey: activationKey.secretKey });
  const facts = {
    v: 1 as const,
    kind: 'provider_broker_readiness' as const,
    homeServerIdentityId: binding.homeServerIdentityId,
    activationId: binding.activationId,
    launchManifestCommitment: encodeBase64(new Uint8Array(32).fill(5), 'base64url'),
    resourceId: 'credential-resource',
    agentTargetKey: 'agent:happier.agent.codex/codex',
    modelId: 'gpt-5',
    protocol: 'openai-responses',
    initiator: {
      installationId: claimPayload.installation.installationId,
      endpointId: 'a'.repeat(64),
    },
    target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) },
  };
  const request = signRunnerBrokerReadinessRequestV1({
    facts,
    claim,
    activationSecretKey: activationKey.secretKey,
    installationSecretKey: installationKey.secretKey,
  });
  return { activationKey, binding, claim, facts, installationKey, request };
}

describe('Runner broker readiness protocol', () => {
  it('accepts only safe optional broker refusal reasons without requiring them from existing producers', () => {
    expect(TeamCredentialResourceReadinessV1Schema.parse({ kind: 'broker_unavailable' }))
      .toEqual({ kind: 'broker_unavailable' });
    for (const reason of ['application_unavailable', 'model_unavailable']) {
      const readiness = { kind: 'broker_unavailable', reason };
      expect(TeamCredentialResourceReadinessV1Schema.parse(readiness)).toEqual(readiness);
    }
    for (const reason of ['source_changed', 'source_unavailable', 'credential_missing', 'private diagnostic']) {
      expect(TeamCredentialResourceReadinessV1Schema.safeParse({ kind: 'broker_unavailable', reason }).success).toBe(false);
    }
    expect(TeamCredentialResourceReadinessV1Schema.safeParse({
      kind: 'broker_unavailable', reason: 'model_unavailable', modelId: 'private-model',
    }).success).toBe(false);
  });

  it('accepts only the recursively closed content-free request and keeps admission purposes separate', () => {
    const { request } = fixture();
    expect(RunnerBrokerReadinessRequestV1Schema.parse(request)).toEqual(request);
    expect(IrohRunnerBrokerReadinessHandshakeV1Schema.parse(request)).toEqual(request);
    expect(IrohMachineAdmissionHandshakeV1Schema.parse(request)).toEqual(request);
    expect(IrohMachineHandshakeV1Schema.safeParse(request).success).toBe(false);

    for (const changed of [
      { ...request, bearer: 'secret' },
      { ...request, prompt: 'do work' },
      { ...request, url: 'http://127.0.0.1:1234' },
      { ...request, initiator: { ...request.initiator, accountId: 'caller-chosen' } },
      { ...request, target: { ...request.target, port: 1234 } },
      { ...request, activationSignature: `${request.activationSignature}=` },
    ]) expect(RunnerBrokerReadinessRequestV1Schema.safeParse(changed).success).toBe(false);
    expect(RunnerBrokerReadinessRequestV1Schema.safeParse({ ...request, kind: 'provider_broker' }).success).toBe(false);
    const signingInput = createRunnerBrokerReadinessSigningInputV1(request);
    expect(signingInput).toContain('happier.provider-broker.readiness-request.v1');
    expect(signingInput).not.toBe(createRunnerBrokerReadinessSigningInputV1({
      ...request,
      target: { ...request.target, machineId: 'other-broker' },
    }));
  });

  it('verifies both claim-derived keys and every expected request fact', () => {
    const { binding, claim, facts, request } = fixture();
    const verify = (candidate: unknown, expectedFacts: unknown = facts, expectedBinding: unknown = binding) => (
      verifyRunnerBrokerReadinessRequestV1({
        request: candidate,
        claim,
        expectedBinding,
        expectedFacts,
      })
    );
    expect(verify(request)).toEqual(request);

    for (const patch of [
      { homeServerIdentityId: 'srv_other_home' },
      { activationId: '00000000-0000-4000-8000-000000000002' },
      { launchManifestCommitment: encodeBase64(new Uint8Array(32).fill(6), 'base64url') },
      { resourceId: 'other-resource' },
      { agentTargetKey: 'agent:happier.agent.claude/claude' },
      { modelId: 'claude-sonnet-4-5' },
      { protocol: 'anthropic' },
      { initiator: { ...request.initiator, endpointId: 'c'.repeat(64) } },
      { target: { ...request.target, machineId: 'other-broker' } },
    ]) expect(verify({ ...request, ...patch })).toBeNull();
    expect(verify({ ...request, activationSignature: request.installationSignature })).toBeNull();
    expect(verify({ ...request, installationSignature: request.activationSignature })).toBeNull();
    expect(verify(request, { ...facts, target: { ...facts.target, endpointId: 'c'.repeat(64) } })).toBeNull();
    expect(verify(request, facts, { ...binding, creatorTokenEpoch: 4 })).toBeNull();
    expect(verify(request, facts, { ...binding, sessionId: 'other-reserved-session' })).toBeNull();
  });

  it('returns only an exact checked binding and canonical safe readiness state', () => {
    const { request } = fixture();
    const binding = {
      homeServerIdentityId: request.homeServerIdentityId,
      activationId: request.activationId,
      launchManifestCommitment: request.launchManifestCommitment,
      resourceId: request.resourceId,
      agentTargetKey: request.agentTargetKey,
      modelId: request.modelId,
      protocol: request.protocol,
      initiator: request.initiator,
      target: request.target,
    };
    const credentialSelectionBinding = { v: 1, resourceId: request.resourceId, brokerMachineId: request.target.machineId, revision: 7,
      application: { agentTargetKey: request.agentTargetKey, implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: request.protocol },
      sourceRevision: 'source-revision-7' };
    const response = RunnerBrokerReadinessResponseV1Schema.parse({
      v: 1,
      binding,
      credentialSelectionBinding,
      readiness: { kind: 'available' },
    });
    expect(response).toEqual({ v: 1, binding, credentialSelectionBinding, readiness: { kind: 'available' } });
    expect(doesRunnerBrokerReadinessResponseMatchRequestV1(request, response)).toBe(true);
    expect(doesRunnerBrokerReadinessResponseMatchRequestV1(
      request,
      { ...response, binding: { ...response.binding, activationId: '00000000-0000-4000-8000-000000000002' } },
    )).toBe(false);
    expect(doesRunnerBrokerReadinessResponseMatchRequestV1(
      request,
      { ...response, binding: { ...response.binding, modelId: 'substituted-model' } },
    )).toBe(false);
    expect(TeamCredentialResourceReadinessV1Schema.parse({
      kind: 'limit_reached', metric: 'total_tokens', resetsAtUtc: '2026-09-09T00:00:00.000Z',
    }).kind).toBe('limit_reached');
    expect(TeamCredentialResourceReadinessV1Schema.safeParse({ kind: 'broker_offline', machineId: 'private' }).success).toBe(false);
    // The readiness a recipient reads carries the same metric vocabulary the
    // limit owner decided with: the catalog read copies the denial's metric
    // straight from the usage evaluation, so any spelling this schema does not
    // accept makes the whole catalog entry throw for that recipient.
    for (const metric of TeamCredentialUsageLimitMetricV1Schema.options) {
      expect(TeamCredentialResourceReadinessV1Schema.parse({
        kind: 'limit_reached', metric, resetsAtUtc: '2026-09-09T00:00:00.000Z',
      })).toEqual({ kind: 'limit_reached', metric, resetsAtUtc: '2026-09-09T00:00:00.000Z' });
    }
    expect(TeamCredentialResourceReadinessV1Schema.safeParse({
      kind: 'limit_reached', metric: 'request_count', resetsAtUtc: '2026-09-09T00:00:00.000Z',
    }).success).toBe(false);
    expect(RunnerBrokerReadinessResponseV1Schema.safeParse({
      v: 1, binding: { ...binding, accountId: 'must-not-leak' }, credentialSelectionBinding, readiness: { kind: 'available' },
    }).success).toBe(false);
  });
});
