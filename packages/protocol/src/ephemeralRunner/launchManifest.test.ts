import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { encodeBase64 } from '../crypto/base64.js';
import { SESSION_DRAFT_MAX_PRIVATE_PAYLOAD_BYTES, SessionDraftPrivatePayloadV1Schema } from '../drafts/sessionDrafts.js';
import {
  computeRunnerAuthoringCommitmentV1,
  computeRunnerLaunchManifestCommitmentV1,
  deriveRunnerLaunchManifestAgentTargetKeyV1,
  RunnerLaunchManifestV1Schema,
  RunnerPreparedAuthoringV1Schema,
} from './launchManifest.js';

function preparedFixture() {
  return {
    v: 1,
    actionsSettings: {
      v: 1,
      actions: {
        'session.activity.get': { approvalRequiredSurfaces: [] },
      },
    },
    mcpMaterial: null,
    authoring: {
      targetType: 'new_session',
      executionTarget: { kind: 'temporary_computer', serverId: 'srv_runner', artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' } },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.codex', localId: 'codex' } },
      permissionMode: 'default',
      modelSelection: { v: 1, ref: { agentTargetKey: 'agent:happier.codex/codex', providerConnectionId: null, modelId: 'gpt-5' }, updatedAt: 1 },
      transcriptStorage: 'persisted',
      profileId: null,
      environmentVariables: null,
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
      connectedServices: null,
      checkoutCreationDraft: null,
      resumeSessionId: null,
      terminal: null,
      windowsRemoteSessionLaunchMode: null,
      windowsRemoteSessionConsole: null,
      windowsTerminalWindowName: null,
      acpSessionModeId: 'plan',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 456,
        overrides: { speed: { updatedAt: 456, value: 'fast' } },
      },
      access: null,
      primaryTeamId: null,
      organizationPlacement: { folderId: null, tagIds: [] },
    },
    composer: { text: 'Inspect the project', references: [], attachments: [] },
    files: [{ id: 'file-one', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 12, sha256: 'a'.repeat(64) }],
    attachmentDestination: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'git_info_exclude', vcsIgnoreWritesEnabled: true },
  };
}

describe('Runner prepared authoring commitment', () => {
  it('derives the exact qualified Agent target from the strict reviewed manifest only', () => {
    const preparedAuthoring = preparedFixture();
    const binding = {
      activationId: '00000000-0000-4000-8000-000000000013',
      homeServerIdentityId: 'srv_runner',
      creatorAccountId: 'creator',
      creatorTokenEpoch: 1,
      activationExpiresAt: null,
      workspace: { kind: 'choose_on_endpoint' as const },
      sessionId: 'session-a',
      machineId: 'machine-a',
      activationSigningPublicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey, 'base64url'),
      authoringCommitment: computeRunnerAuthoringCommitmentV1(preparedAuthoring),
      artifact: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
      endpointFactsRecipient: { mode: 'plain', creatorAccountId: 'creator' },
    };
    const launchManifest = {
      v: 1,
      purpose: 'happier.ephemeral-session-runner.launch-manifest',
      binding,
      preparedAuthoring,
      authoringCommitment: binding.authoringCommitment,
      endpointFacts: {
        v: 1,
        directory: '/work',
        machine: {
          host: 'runner.example.test',
          platform: 'linux',
          happyCliVersion: '0.3.0',
          happyHomeDir: '/runner/home',
          homeDir: '/runner/home',
        },
      },
      machineContentKeyBinding: null,
      credentialSelectionBinding: { v: 1, resourceId: 'resource-a', brokerMachineId: 'broker-a', revision: 1,
        application: { agentTargetKey: 'agent:happier.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' },
        sourceRevision: 'source-revision-1' },
      displayFacts: { v: 1, homeId: 'srv_runner', homeName: 'Acme Home', requesterId: 'creator', requesterName: 'Alice', teamId: 'team-a', teamName: 'Platform' },
      reviewedProviderModel: {
        selection: { kind: 'team_credential_provider_model', resourceId: 'resource-a', teamId: 'team-a', expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.codex/codex', modelId: 'gpt-5' },
        descriptor: { id: 'gpt-5', name: 'GPT-5' },
        application: { agentTargetKey: 'agent:happier.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' },
        sourceRevision: 'source-revision-1', availability: 'available',
      },
      connectedServiceReviewBindings: { v: 1, bindings: [] },
    };
    expect(deriveRunnerLaunchManifestAgentTargetKeyV1(launchManifest)).toBe('agent:happier.codex/codex');

    const parsed = RunnerLaunchManifestV1Schema.parse(launchManifest);
    const originalCommitment = computeRunnerLaunchManifestCommitmentV1(parsed);

    const withConnectedService = (
      selection: Record<string, unknown>,
      reviewedBinding: Record<string, unknown> | null,
    ) => {
      const preparedWithService = {
        ...preparedAuthoring,
        authoring: {
          ...preparedAuthoring.authoring,
          connectedServices: {
            v: 2 as const,
            bindingsByServiceId: { 'acme.agent/cloud': selection },
          },
        },
      };
      const authoringCommitment = computeRunnerAuthoringCommitmentV1(preparedWithService);
      return {
        ...launchManifest,
        binding: { ...binding, authoringCommitment },
        preparedAuthoring: preparedWithService,
        authoringCommitment,
        connectedServiceReviewBindings: {
          v: 1 as const,
          bindings: reviewedBinding ? [reviewedBinding] : [],
        },
      };
    };
    const connectedAccount = {
      service: { pluginId: 'acme.agent', localId: 'cloud' },
      accountId: 'work',
    };
    const reviewedBinding = {
      serviceKey: 'acme.agent/cloud',
      account: connectedAccount,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      configurationRevision: null,
      authenticationModeId: 'oauth',
    };
    expect(RunnerLaunchManifestV1Schema.safeParse(withConnectedService(
      { source: 'connected', selection: 'profile', profileId: 'work' },
      { ...reviewedBinding, selection: { kind: 'profile', profileId: 'work' } },
    )).success).toBe(false);
    expect(RunnerLaunchManifestV1Schema.safeParse(withConnectedService(
      { source: 'connected', selection: 'group', groupId: 'engineering' },
      { ...reviewedBinding, selection: { kind: 'group', groupId: 'engineering', generation: 3 } },
    )).success).toBe(false);
    const teamResourceResult = RunnerLaunchManifestV1Schema.safeParse(withConnectedService(
      { source: 'team_resource', resourceId: 'team-service-resource', deliveryMode: 'brokered' },
      null,
    ));
    expect(teamResourceResult.success).toBe(false);


    expect(computeRunnerLaunchManifestCommitmentV1({
      ...parsed,
      displayFacts: { ...parsed.displayFacts, homeName: 'Substituted Home' },
    })).not.toBe(originalCommitment);
    expect(RunnerLaunchManifestV1Schema.safeParse({
      ...launchManifest,
      binding: { ...binding, workspace: { kind: 'endpoint_home' } },
    }).success).toBe(false);
    expect(RunnerLaunchManifestV1Schema.safeParse({
      ...parsed,
      displayFacts: { ...parsed.displayFacts, homeId: 'substituted-home' },
    }).success).toBe(false);
    expect(RunnerLaunchManifestV1Schema.safeParse({
      ...parsed,
      reviewedProviderModel: {
        ...parsed.reviewedProviderModel,
        descriptor: { ...parsed.reviewedProviderModel.descriptor, name: 'GPT\u001b[2J' },
      },
    }).success).toBe(false);
    expect(RunnerLaunchManifestV1Schema.safeParse({
      ...parsed,
      reviewedProviderModel: {
        ...parsed.reviewedProviderModel,
        selection: { ...parsed.reviewedProviderModel.selection, deliveryMode: 'direct' },
      },
    }).success).toBe(false);

    for (const changedAuthoring of [
      { ...preparedAuthoring.authoring, profileId: 'changed-profile' },
      { ...preparedAuthoring.authoring, environmentVariables: { RUNNER_PROFILE_TOKEN: 'changed-secret' } },
      { ...preparedAuthoring.authoring, capabilitySelection: { mcp: {
        v: 1 as const,
        managedServersEnabled: false,
        forceIncludeServerIds: [],
        forceExcludeServerIds: [],
      } } },
      { ...preparedAuthoring.authoring, connectedServices: { v: 2 as const, bindingsByServiceId: {
        'happier.service.github/github': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
      } } },
      { ...preparedAuthoring.authoring, transcriptStorage: 'direct' as const },
      { ...preparedAuthoring.authoring, acpSessionModeId: 'act' },
      { ...preparedAuthoring.authoring, sessionConfigOptionOverrides: {
        v: 1 as const,
        updatedAt: 457,
        overrides: { speed: { updatedAt: 457, value: 'slow' } },
      } },
      { ...preparedAuthoring.authoring, checkoutCreationDraft: {
        kind: 'git_worktree' as const,
        displayName: 'runner-review',
        baseRef: 'main',
      } },
      { ...preparedAuthoring.authoring, resumeSessionId: 'provider-session-1' },
      { ...preparedAuthoring.authoring, terminal: {
        mode: 'tmux' as const,
        tmux: { sessionName: 'reviewed', isolated: true, tmpDir: '/tmp/reviewed' },
      } },
      { ...preparedAuthoring.authoring, windowsRemoteSessionLaunchMode: 'windows_terminal' as const },
      { ...preparedAuthoring.authoring, windowsRemoteSessionConsole: 'visible' as const },
      { ...preparedAuthoring.authoring, windowsTerminalWindowName: 'Runner reviewed' },
    ]) {
      expect(RunnerLaunchManifestV1Schema.safeParse({
        ...launchManifest,
        preparedAuthoring: { ...preparedAuthoring, authoring: changedAuthoring },
      }).success).toBe(false);
    }
  });

  it('rejects an incomplete request that cannot reproduce the reviewed launch', () => {
    expect(RunnerPreparedAuthoringV1Schema.safeParse({
      ...preparedFixture(),
      authoring: {},
    }).success).toBe(false);
  });
  it('accepts valid draft content when review-only destination facts exceed the draft envelope ceiling', () => {
    const text = 'x'.repeat(SESSION_DRAFT_MAX_PRIVATE_PAYLOAD_BYTES - 1024);
    const mutationId = 'c6e00f64-4252-4b4a-b56d-98472a086159';
    const draft = { v: 1, address: { kind: 'newSession', draftId: mutationId }, document: {
      v: 1, composer: { text: { mutationId, value: text }, mentions: { mutationId, value: [] }, attachments: { mutationId, value: [] } },
      target: { kind: 'newSession', authoring: {} }, extensions: {},
    } };
    expect(SessionDraftPrivatePayloadV1Schema.safeParse(draft).success).toBe(true);
    const input = preparedFixture();
    expect(RunnerPreparedAuthoringV1Schema.safeParse({ ...input,
      composer: { ...input.composer, text },
      attachmentDestination: { ...input.attachmentDestination, workspaceRelativeDir: 'd'.repeat(4096) },
    }).success).toBe(true);
  });

  it('commits exact public authoring, composer and staged-file facts through the shared domain-separated digest', () => {
    const input = preparedFixture();
    const parsed = RunnerPreparedAuthoringV1Schema.parse(input);
    const expected = computeCanonicalDomainSeparatedDigest('happier.ephemeral-session-runner.authoring.v1', [createCanonicalJsonSigningInput(parsed)]);
    expect(computeRunnerAuthoringCommitmentV1(input)).toBe(expected);
    for (const modified of [
      { ...input, composer: { ...input.composer, text: 'Delete the project' } },
      { ...input, authoring: { ...input.authoring, permissionMode: 'bypassPermissions' } },
      { ...input, authoring: { ...input.authoring, profileId: 'review-profile' } },
      { ...input, authoring: { ...input.authoring, environmentVariables: { RUNNER_PROFILE_TOKEN: 'reviewed-secret' } } },
      { ...input, authoring: { ...input.authoring, capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } } } },
      { ...input, authoring: { ...input.authoring, connectedServices: { v: 2, bindingsByServiceId: {
        'happier.service.github/github': { source: 'connected', selection: 'profile', profileId: 'work' },
      } } } },
      { ...input, authoring: { ...input.authoring, transcriptStorage: 'direct' } },
      { ...input, authoring: { ...input.authoring, acpSessionModeId: 'act' } },
      { ...input, authoring: { ...input.authoring, sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 457,
        overrides: { speed: { updatedAt: 457, value: 'slow' } },
      } } },
      { ...input, actionsSettings: { v: 1, actions: { 'session.activity.get': { enabled: false } } } },
      { ...input, files: [{ ...input.files[0], sha256: 'b'.repeat(64) }] },
      { ...input, attachmentDestination: { ...input.attachmentDestination, uploadLocation: 'os_temp' } },
    ]) expect(computeRunnerAuthoringCommitmentV1(modified)).not.toBe(expected);
    expect(computeRunnerAuthoringCommitmentV1({ ...input, authoring: { ...input.authoring } })).toBe(expected);
  });

  it('requires every ordinary runtime selection whose omission would change the reviewed launch', () => {
    const input = preparedFixture();
    for (const field of [
      'transcriptStorage',
      'profileId',
      'environmentVariables',
      'capabilitySelection',
      'connectedServices',
      'acpSessionModeId',
      'sessionConfigOptionOverrides',
    ] as const) {
      const authoring = { ...input.authoring };
      delete authoring[field];
      expect(RunnerPreparedAuthoringV1Schema.safeParse({ ...input, authoring }).success).toBe(false);
    }
  });

  it('accepts only reviewed environment material while rejecting unrelated local secrets, staged handles and duplicate files', () => {
    const input = preparedFixture();
    expect(RunnerPreparedAuthoringV1Schema.parse({
      ...input,
      authoring: { ...input.authoring, environmentVariables: { RUNNER_PROFILE_TOKEN: 'sealed-secret' } },
    }).authoring.environmentVariables).toEqual({ RUNNER_PROFILE_TOKEN: 'sealed-secret' });
    for (const modified of [
      { ...input, authoring: { ...input.authoring, sessionEncryptionKeyBase64: 'secret' } },
      { ...input, files: [{ ...input.files[0], sourcePath: '/private/local-file' }] },
      { ...input, files: [input.files[0], input.files[0]] },
      { ...input, attachmentDestination: { ...input.attachmentDestination, arbitraryCommand: 'run' } },
    ]) expect(RunnerPreparedAuthoringV1Schema.safeParse(modified).success).toBe(false);

    expect(RunnerPreparedAuthoringV1Schema.safeParse({
      ...input,
      actionsSettings: { ...input.actionsSettings, arbitraryPolicy: true },
    }).success).toBe(false);
  });

  it('requires explicit Runner material documents instead of silently defaulting signed authority', () => {
    const prepared = preparedFixture();
    const withoutMcpMaterial = { ...prepared };
    delete withoutMcpMaterial.mcpMaterial;
    expect(RunnerPreparedAuthoringV1Schema.safeParse(withoutMcpMaterial).success).toBe(false);

    const binding = {
      activationId: '00000000-0000-4000-8000-000000000013',
      homeServerIdentityId: 'srv_runner',
      creatorAccountId: 'creator',
      creatorTokenEpoch: 1,
      activationExpiresAt: null,
      workspace: { kind: 'choose_on_endpoint' as const },
      sessionId: 'session-a',
      machineId: 'machine-a',
      activationSigningPublicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey, 'base64url'),
      authoringCommitment: computeRunnerAuthoringCommitmentV1(prepared),
      artifact: { product: 'happier-runner' as const, version: '0.3.0', target: 'linux-x64' as const, sha256: 'a'.repeat(64) },
      endpointFactsRecipient: { mode: 'plain' as const, creatorAccountId: 'creator' },
    };
    expect(RunnerLaunchManifestV1Schema.safeParse({
      v: 1,
      purpose: 'happier.ephemeral-session-runner.launch-manifest',
      binding,
      preparedAuthoring: prepared,
      authoringCommitment: binding.authoringCommitment,
      endpointFacts: {
        v: 1,
        directory: '/work',
        machine: { host: 'runner.example.test', platform: 'linux', happyCliVersion: '0.3.0', happyHomeDir: '/runner/home', homeDir: '/runner/home' },
      },
      machineContentKeyBinding: null,
      credentialSelectionBinding: { v: 1, resourceId: 'resource-a', brokerMachineId: 'broker-a', revision: 1,
        application: { agentTargetKey: 'agent:happier.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' },
        sourceRevision: 'source-revision-1' },
      displayFacts: { v: 1, homeId: 'srv_runner', homeName: 'Acme Home', requesterId: 'creator', requesterName: 'Alice', teamId: 'team-a', teamName: 'Platform' },
      reviewedProviderModel: {
        selection: { kind: 'team_credential_provider_model', resourceId: 'resource-a', teamId: 'team-a', expectedResourceRevision: 1, agentTargetKey: 'agent:happier.codex/codex', modelId: 'gpt-5' },
        descriptor: { id: 'gpt-5', name: 'GPT-5' },
        application: { agentTargetKey: 'agent:happier.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' },
        sourceRevision: 'source-revision-1', availability: 'available',
      },
    }).success).toBe(false);
  });

  it('commits a well-formed unknown qualified plugin Action without making the document root open', () => {
    const input = preparedFixture();
    const qualifiedActionId = 'acme.runner/actions/future-action';
    const withPluginAction = {
      ...input,
      actionsSettings: {
        ...input.actionsSettings,
        actions: {
          ...input.actionsSettings.actions,
          [qualifiedActionId]: { enabled: false, futureOverride: { v: 2 } },
        },
      },
    };
    const parsed = RunnerPreparedAuthoringV1Schema.parse(withPluginAction);
    expect(parsed.actionsSettings.actions[qualifiedActionId]).toMatchObject({
      enabled: false,
      futureOverride: { v: 2 },
    });
    expect(computeRunnerAuthoringCommitmentV1(parsed)).not.toBe(computeRunnerAuthoringCommitmentV1(input));
  });
});

function externalListingFixture() {
  return {
    source: {
      id: 'marketplace:community-npm',
      kind: 'community-npm',
      sourceUrl: 'https://registry.npmjs.org/',
    },
    pluginId: 'acme.reviewed-external',
    publisher: { id: 'acme', displayName: 'Acme' },
    packageName: '@acme/reviewed-external',
    registryOrigin: 'https://registry.npmjs.org',
    version: '1.2.3',
    integrity: `sha512-${'A'.repeat(86)}==`,
    manifestDigest: `sha256:${'b'.repeat(64)}`,
    review: { status: 'unreviewed', reviewedAt: null },
    updatePolicy: 'pinned',
  };
}

function externalPreparedFixture() {
  const prepared = preparedFixture();
  return {
    ...prepared,
    authoring: {
      ...prepared.authoring,
      agentTarget: { kind: 'agent', identity: { pluginId: 'acme.reviewed-external', localId: 'assistant' } },
      modelSelection: {
        ...prepared.authoring.modelSelection,
        ref: { ...prepared.authoring.modelSelection.ref, agentTargetKey: 'agent:acme.reviewed-external/assistant' },
      },
    },
    agentPluginDistribution: externalListingFixture(),
  };
}

describe('Runner reviewed external Agent plugin distribution', () => {
  it('commits the exact reviewed distribution for an external agent-target plugin', () => {
    const input = externalPreparedFixture();
    const parsed = RunnerPreparedAuthoringV1Schema.parse(input);
    expect(parsed.agentPluginDistribution).toMatchObject({
      pluginId: 'acme.reviewed-external',
      packageName: '@acme/reviewed-external',
      version: '1.2.3',
      integrity: input.agentPluginDistribution.integrity,
      manifestDigest: input.agentPluginDistribution.manifestDigest,
    });
    // A substituted distribution must move the one commitment the activation
    // binding already carries, so it fails before the endpoint consent surface.
    const substituted = {
      ...input,
      agentPluginDistribution: { ...input.agentPluginDistribution, version: '1.2.4' },
    };
    expect(computeRunnerAuthoringCommitmentV1(substituted))
      .not.toBe(computeRunnerAuthoringCommitmentV1(input));
  });

  it('treats an absent distribution as the bundled case and still commits it explicitly', () => {
    const bundled = RunnerPreparedAuthoringV1Schema.parse(preparedFixture());
    expect(bundled.agentPluginDistribution).toBeNull();
    expect(computeRunnerAuthoringCommitmentV1(preparedFixture()))
      .toBe(computeRunnerAuthoringCommitmentV1({ ...preparedFixture(), agentPluginDistribution: null }));
  });

  it('rejects a distribution that does not name the reviewed Agent plugin', () => {
    const input = externalPreparedFixture();
    expect(RunnerPreparedAuthoringV1Schema.safeParse({
      ...input,
      agentPluginDistribution: { ...input.agentPluginDistribution, pluginId: 'acme.other-plugin' },
    }).success).toBe(false);
    // A bundled Agent target may not smuggle an external acquisition either.
    expect(RunnerPreparedAuthoringV1Schema.safeParse({
      ...preparedFixture(),
      agentPluginDistribution: externalListingFixture(),
    }).success).toBe(false);
  });

  it('rejects a creator-selected private registry profile', () => {
    const input = externalPreparedFixture();
    expect(RunnerPreparedAuthoringV1Schema.safeParse({
      ...input,
      agentPluginDistribution: {
        ...input.agentPluginDistribution,
        source: { id: 'acme-catalog', kind: 'user', sourceUrl: 'https://catalog.acme.test/index.json' },
        registryProfileId: 'acme-private',
      },
    }).success).toBe(false);
  });
});
