import { z } from 'zod';

import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { ProviderAgentTargetKeySchema } from '../providers/ids.js';
import { ComposerSnapshotV1Schema } from '../plugins/ui/composer.js';
import { ReviewCommentDraftMessageV1Schema } from '../messages/structured/reviewCommentsV1.js';
import { ComposerAttachmentViewV1Schema, MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 } from '../runtime/input/composerAttachmentV1.js';
import { ComposerContentDisplayNameV1Schema } from '../runtime/input/composerContentV1.js';
import {
  SessionAuthoringValueV1Schema,
} from '../sessions/authoring/index.js';
import { SessionCapabilitySelectionAuthoringV1Schema, type SessionCapabilitySelectionV1 } from '../reach/sessionCapabilitySelectionV1.js';
import {
  ConnectedServiceBindingsV2IngressSchema,
  type ConnectedServiceBindingsV2,
} from '../connect/connectedServiceBindings.js';
import { ActionsSettingsV1Schema } from '../actions/actionSettings.js';
import { ExpectedMarketplaceListingV1Schema } from '../marketplace/expectedMarketplaceListingV1.js';
import { RunnerActivationBindingV1Schema, RunnerResourceIdSchema, RunnerSha256CommitmentSchema } from './activation.js';
import { RunnerEndpointFactsContentV1Schema } from './endpoint.js';
import { RunnerMachineContentKeyBindingV1Schema } from './machineContentKeyBindingSchema.js';
import { RunnerConsentDisplayFactsV1Schema, RunnerCredentialSelectionBindingV1Schema } from './review.js';
import { TeamCredentialProviderModelCatalogEntryV1Schema } from '../teams/credentials/resourceV1.js';
import { RunnerMcpMaterialV1Schema } from './runnerMcpMaterial.js';
import {
  RunnerConnectedServiceReviewBindingsV1Schema,
  classifyRunnerConnectedServiceSelectionV1,
} from './runnerConnectedServices.js';

/** Review records contain semantic input, never transfer-local content handles. */
const ReviewedComposerAttachmentV1Schema = ComposerAttachmentViewV1Schema.omit({ availability: true, content: true }).strict();

/**
 * Runner commitments require a closed policy document root. Delegate all
 * Action-row normalization to the persisted-settings owner so contributed
 * Action ids and forward-compatible override fields keep their canonical
 * semantics without making the signed Runner document itself open.
 */
const RunnerActionsSettingsV1Schema = z.object({
  v: z.literal(1),
  actions: z.record(z.string(), z.unknown()).default({}),
  approvalWaivedSurfaces: z.unknown().optional(),
}).strict().transform((value, context) => {
  const parsed = ActionsSettingsV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
  return z.NEVER;
});

export const RunnerReviewedFileV1Schema = z.object({
  id: RunnerResourceIdSchema,
  name: ComposerContentDisplayNameV1Schema,
  mimeType: z.string().min(1).nullable(),
  sizeBytes: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type RunnerReviewedFileV1 = z.infer<typeof RunnerReviewedFileV1Schema>;

/** Exact existing attachment-upload behavior; uploadLocation is the copy-to-workspace fact. */
export const RunnerAttachmentDestinationV1Schema = z.object({
  uploadLocation: z.enum(['workspace', 'os_temp']),
  // Same path-size boundary as the Account attachment setting; transfer owns path normalization.
  workspaceRelativeDir: z.string().min(1).max(4 * 1024),
  vcsIgnoreStrategy: z.enum(['git_info_exclude', 'gitignore', 'none']),
  vcsIgnoreWritesEnabled: z.boolean(),
}).strict();

const RunnerStrictAuthoringV1Schema = SessionAuthoringValueV1Schema.pick({
  targetType: true,
  executionTarget: true,
  agentTarget: true,
  permissionMode: true,
  modelSelection: true,
  transcriptStorage: true,
  profileId: true,
  environmentVariables: true,
  connectedServices: true,
  checkoutCreationDraft: true,
  resumeSessionId: true,
  terminal: true,
  windowsRemoteSessionLaunchMode: true,
  windowsRemoteSessionConsole: true,
  windowsTerminalWindowName: true,
  acpSessionModeId: true,
  sessionConfigOptionOverrides: true,
  access: true,
  primaryTeamId: true,
  organizationPlacement: true,
}).extend({
  // The synchronized document owns defaults; a reviewed launch must spell out
  // these runtime selections so omission cannot be reinterpreted downstream.
  profileId: z.unknown().transform((value, context): string | null => {
    if (value === undefined) {
      context.addIssue({ code: 'custom', message: 'Reviewed authoring field is required' });
      return z.NEVER;
    }
    const parsed = SessionAuthoringValueV1Schema.shape.profileId.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: 'custom', message: 'Invalid reviewed profile selection' });
      return z.NEVER;
    }
    return parsed.data;
  }),
  transcriptStorage: z.unknown().transform((value, context): 'persisted' | 'direct' | null => {
    if (value === undefined) {
      context.addIssue({ code: 'custom', message: 'Reviewed authoring field is required' });
      return z.NEVER;
    }
    const parsed = SessionAuthoringValueV1Schema.shape.transcriptStorage.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: 'custom', message: 'Invalid reviewed transcript-storage selection' });
      return z.NEVER;
    }
    return parsed.data;
  }),
  capabilitySelection: z.unknown().transform((value, context): SessionCapabilitySelectionV1 | null => {
    if (value === undefined) {
      context.addIssue({ code: 'custom', message: 'Reviewed authoring field is required' });
      return z.NEVER;
    }
    if (value === null) return null;
    const parsed = SessionCapabilitySelectionAuthoringV1Schema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: 'custom', message: 'Invalid reviewed capability selection' });
      return z.NEVER;
    }
    return parsed.data;
  }),
  connectedServices: z.unknown().transform((value, context): ConnectedServiceBindingsV2 | null => {
    if (value === undefined) {
      context.addIssue({ code: 'custom', message: 'Reviewed authoring field is required' });
      return z.NEVER;
    }
    if (value === null) return null;
    const parsed = ConnectedServiceBindingsV2IngressSchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: 'custom', message: 'Invalid reviewed Connected Service selection' });
      return z.NEVER;
    }
    return parsed.data;
  }),
  acpSessionModeId: z.unknown().transform((value, context): string | null => {
    if (value === undefined) {
      context.addIssue({ code: 'custom', message: 'Reviewed authoring field is required' });
      return z.NEVER;
    }
    const parsed = SessionAuthoringValueV1Schema.shape.acpSessionModeId.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: 'custom', message: 'Invalid reviewed Session mode selection' });
      return z.NEVER;
    }
    return parsed.data;
  }),
}).strict().superRefine((authoring, context) => {
  for (const key of [
    'access',
    'primaryTeamId',
    'organizationPlacement',
    'modelSelection',
    'transcriptStorage',
    'profileId',
    'environmentVariables',
    'capabilitySelection',
    'connectedServices',
    'checkoutCreationDraft',
    'resumeSessionId',
    'terminal',
    'windowsRemoteSessionLaunchMode',
    'windowsRemoteSessionConsole',
    'windowsTerminalWindowName',
    'acpSessionModeId',
    'sessionConfigOptionOverrides',
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(authoring, key)) {
      context.addIssue({ code: 'custom', path: [key], message: 'Reviewed authoring field is required' });
    }
  }
  if (authoring.targetType !== 'new_session') {
    context.addIssue({ code: 'custom', path: ['targetType'], message: 'Runner launch must create a new Session' });
  }
  if (authoring.executionTarget?.kind !== 'temporary_computer') {
    context.addIssue({ code: 'custom', path: ['executionTarget'], message: 'Temporary-computer execution target is required' });
  }
  if (authoring.agentTarget === null) {
    context.addIssue({ code: 'custom', path: ['agentTarget'], message: 'Agent target is required' });
  }
  if (authoring.permissionMode === null) {
    context.addIssue({ code: 'custom', path: ['permissionMode'], message: 'Permission mode is required' });
  }
});

export const RunnerPreparedAuthoringV1Schema = z.object({
  v: z.literal(1),
  /** Creator-reviewed launch policy; the endpoint cannot replace it with environment or Account settings. */
  actionsSettings: RunnerActionsSettingsV1Schema,
  /** Exact creator-resolved MCP material; null is the simple no-managed-server case. */
  mcpMaterial: RunnerMcpMaterialV1Schema.nullable(),
  authoring: RunnerStrictAuthoringV1Schema,
  /**
   * The exact reviewed distribution the endpoint must acquire before the
   * reviewed Agent can run, for an Agent contributed by an installed external
   * plugin. `null` is the bundled case: the Runner artifact already carries
   * that generation and the endpoint acquires nothing.
   *
   * It reuses the marketplace listing commitment the canonical plugin change
   * preparer already revalidates, so the endpoint gains no second distribution
   * vocabulary. Because the field sits inside the prepared submission, it is
   * covered by `computeRunnerAuthoringCommitmentV1` and therefore by the
   * activation binding the endpoint compares before consent.
   */
  agentPluginDistribution: ExpectedMarketplaceListingV1Schema.nullable().default(null),
  composer: ComposerSnapshotV1Schema.pick({ text: true, references: true }).extend({
    attachments: z.array(ReviewedComposerAttachmentV1Schema).max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1),
  }).strict(),
  reviewComments: z.object({
    workspace: z.object({
      serverId: z.string().min(1),
      machineId: z.string().min(1),
      rootPath: z.string().min(1),
    }).strict(),
    comments: z.array(ReviewCommentDraftMessageV1Schema),
  }).strict().nullable().optional(),
  files: z.array(RunnerReviewedFileV1Schema).max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1),
  attachmentDestination: RunnerAttachmentDestinationV1Schema,
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const file of value.files) {
    if (ids.has(file.id)) context.addIssue({ code: 'custom', path: ['files'], message: 'Reviewed file identities must be unique' });
    ids.add(file.id);
  }
  const distribution = value.agentPluginDistribution;
  if (distribution === null) return;
  const agentTarget = value.authoring.agentTarget;
  if (agentTarget?.kind !== 'agent' || agentTarget.identity.pluginId !== distribution.pluginId) {
    context.addIssue({
      code: 'custom',
      path: ['agentPluginDistribution', 'pluginId'],
      message: 'Reviewed plugin distribution must name the reviewed Agent target plugin',
    });
  }
  if (distribution.registryProfileId !== undefined) {
    // Private-registry authentication is an endpoint-side selection: a creator
    // that named one would hand the endpoint credentials authority nobody
    // granted, so the commitment carrying it fails closed here.
    context.addIssue({
      code: 'custom',
      path: ['agentPluginDistribution', 'registryProfileId'],
      message: 'Reviewed plugin distribution must not select an endpoint registry profile',
    });
  }
});
export type RunnerPreparedAuthoringV1 = z.infer<typeof RunnerPreparedAuthoringV1Schema>;

/** One hash for creator custody, activation creation and the later reviewed manifest. */
export function computeRunnerAuthoringCommitmentV1(input: unknown): string {
  const prepared = RunnerPreparedAuthoringV1Schema.parse(input);
  return computeCanonicalDomainSeparatedDigest('happier.ephemeral-session-runner.authoring.v1', [createCanonicalJsonSigningInput(prepared)]);
}

export const RunnerLaunchManifestV1Schema = z.object({
  v: z.literal(1),
  purpose: z.literal('happier.ephemeral-session-runner.launch-manifest'),
  binding: RunnerActivationBindingV1Schema,
  preparedAuthoring: RunnerPreparedAuthoringV1Schema,
  authoringCommitment: RunnerSha256CommitmentSchema,
  endpointFacts: RunnerEndpointFactsContentV1Schema,
  machineContentKeyBinding: RunnerMachineContentKeyBindingV1Schema.nullable(),
  credentialSelectionBinding: RunnerCredentialSelectionBindingV1Schema,
  /** Home-authenticated presentation facts committed with this exact review. */
  displayFacts: RunnerConsentDisplayFactsV1Schema,
  /** Exact private catalog selection/descriptor sealed to the Runner endpoint. */
  reviewedProviderModel: TeamCredentialProviderModelCatalogEntryV1Schema,
  /** Credential-free, creator-resolved identities/revisions for the exact selected services. */
  connectedServiceReviewBindings: RunnerConnectedServiceReviewBindingsV1Schema,
}).strict().superRefine((value, context) => {
  const computed = computeRunnerAuthoringCommitmentV1(value.preparedAuthoring);
  if (computed !== value.authoringCommitment || computed !== value.binding.authoringCommitment) {
    context.addIssue({ code: 'custom', path: ['authoringCommitment'], message: 'Authoring commitment does not match the prepared submission and activation binding' });
  }
  const executionTarget = value.preparedAuthoring.authoring.executionTarget;
  if (
    executionTarget?.kind !== 'temporary_computer'
    || executionTarget.workspace.kind !== value.binding.workspace.kind
  ) {
    context.addIssue({
      code: 'custom',
      path: ['preparedAuthoring', 'authoring', 'executionTarget', 'workspace'],
      message: 'Reviewed workspace policy must match the creator-authenticated activation binding',
    });
  }
  const reviewedByServiceKey = new Map(
    value.connectedServiceReviewBindings.bindings.map((binding) => [binding.serviceKey, binding]),
  );
  for (const [serviceKey, selection] of Object.entries(
    value.preparedAuthoring.authoring.connectedServices?.bindingsByServiceId ?? {},
  )) {
    const reviewed = reviewedByServiceKey.get(serviceKey);
    const portability = classifyRunnerConnectedServiceSelectionV1(selection);
    if (portability === 'endpoint_native') {
      if (reviewed) context.addIssue({ code: 'custom', path: ['connectedServiceReviewBindings'], message: 'Native Connected Services cannot carry Runner custody' });
      continue;
    }
    if (portability === 'not_portable') {
      context.addIssue({ code: 'custom', path: ['connectedServiceReviewBindings'], message: `Runner Connected Service '${serviceKey}' requires an unavailable scoped Connected-Service broker` });
      continue;
    }
  }
  if (reviewedByServiceKey.size !== 0) {
    context.addIssue({ code: 'custom', path: ['connectedServiceReviewBindings'], message: 'Runner Connected Service review contains an unselected service' });
  }
  if ((value.binding.endpointFactsRecipient.mode === 'e2ee') !== (value.machineContentKeyBinding !== null)) {
    context.addIssue({ code: 'custom', path: ['machineContentKeyBinding'], message: 'Machine content-key binding must match the creator encryption mode' });
  }
  const selected = value.reviewedProviderModel;
  const binding = value.credentialSelectionBinding;
  if (/\p{Cc}|[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(selected.descriptor.name)) {
    context.addIssue({ code: 'custom', path: ['reviewedProviderModel', 'descriptor', 'name'], message: 'Reviewed model name must be safe to display' });
  }
  if (
    value.displayFacts.homeId !== value.binding.homeServerIdentityId
    || value.displayFacts.requesterId !== value.binding.creatorAccountId
    || value.displayFacts.teamId !== selected.selection.teamId
  ) context.addIssue({ code: 'custom', path: ['displayFacts'], message: 'Verified display identities must match the exact launch binding' });
  const authoredModel = value.preparedAuthoring.authoring.modelSelection?.ref;
  if (
    selected.availability !== 'available'
    || selected.selection.deliveryMode !== 'brokered'
    || selected.selection.resourceId !== binding.resourceId
    || selected.selection.expectedResourceRevision !== binding.revision
    || selected.application.agentTargetKey !== binding.application.agentTargetKey
    || selected.application.implementationIdentity.pluginId !== binding.application.implementationIdentity.pluginId
    || selected.application.implementationIdentity.localId !== binding.application.implementationIdentity.localId
    || selected.application.endpointTemplateId !== binding.application.endpointTemplateId
    || selected.application.protocol !== binding.application.protocol
    || selected.sourceRevision !== binding.sourceRevision
    || authoredModel?.agentTargetKey !== selected.selection.agentTargetKey
    || authoredModel?.modelId !== selected.selection.modelId
  ) context.addIssue({ code: 'custom', path: ['reviewedProviderModel'], message: 'Reviewed Provider model must match the credential selection binding' });
});
export type RunnerLaunchManifestV1 = z.infer<typeof RunnerLaunchManifestV1Schema>;

/**
 * Derives the only Agent target a Runner may prepare from the creator-reviewed
 * strict launch manifest. Callers must not accept a parallel target hint.
 */
export function deriveRunnerLaunchManifestAgentTargetKeyV1(input: unknown) {
  const manifest = RunnerLaunchManifestV1Schema.parse(input);
  const agentTarget = manifest.preparedAuthoring.authoring.agentTarget;
  if (agentTarget === null) throw new Error('runner_launch_manifest_agent_target_missing');
  return ProviderAgentTargetKeySchema.parse(buildBackendTargetKeyV2(agentTarget));
}

export function computeRunnerLaunchManifestCommitmentV1(input: unknown): string {
  const manifest = RunnerLaunchManifestV1Schema.parse(input);
  return computeCanonicalDomainSeparatedDigest(
    'happier.ephemeral-session-runner.launch-manifest.v1',
    [createCanonicalJsonSigningInput(manifest)],
  );
}
