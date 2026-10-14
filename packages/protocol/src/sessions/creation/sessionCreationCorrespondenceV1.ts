import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../../connect/connectedServiceBindings.js';
import { SessionCapabilitySelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';
import { SessionModelSelectionV1Schema } from '../../providers/selection/v1.js';
import { AgentSessionConfigurationSnapshotV1Schema } from '../../runtime/agentSessionV1.js';
import { AgentSessionToolPolicyShapeV1 } from '../../runtime/permissionIntentV1.js';
import { AgentSessionStartupInstructionsMarkerV1Schema } from '../../runtime/agentSessionStartupInstructionsV1.js';
import { SessionAuthoringTerminalV1Schema } from '../authoring/creationFieldsV1.js';
import { SessionCreationTagV1Schema } from './sessionCreationIdentityV1.js';
import { SessionOrganizationPlacementV1Schema } from './sessionSpawnNewResultV1.js';
import { SecretReferenceOverlayV1Schema } from '../../profiles/secretReferenceOverlayV1.js';
import { SessionDirectoryIntentV1Schema, refineSessionDirectoryIntentCheckoutV1 } from './sessionDirectoryIntentV1.js';
import { SessionIdentityAdditionsV1Schema } from '../identity/sessionBotV1.js';
import { SessionPromptStackV1Schema } from '../context/sessionContextV1.js';
import { ManagedControllerV1Schema } from '../../machines/managed/managedMachineV1.js';

/** Immutable birth provenance, validated against Home's admitted resource before Session creation. */
export const SessionManagedCreationV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: z.string().check(z.trim(), z.minLength(1)),
  managedId: z.string().check(z.trim(), z.minLength(1)),
  controller: ManagedControllerV1Schema,
}));
export type SessionManagedCreationV1 = z.infer<typeof SessionManagedCreationV1Schema>;

export const SessionCreationImmutableRecipeV1Schema = lazyZodSchema(() => z.strictObject({
  ...AgentSessionToolPolicyShapeV1,
  execution: z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1)),
    directory: SessionDirectoryIntentV1Schema,
  }),
  organization: SessionOrganizationPlacementV1Schema,
  agentTarget: AgentExecutionTargetV1Schema,
  modelSelection: z.nullable(SessionModelSelectionV1Schema),
  profileId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  identity: z.optional(SessionIdentityAdditionsV1Schema),
  memoryEnabled: z.optional(z.boolean()),
  promptStack: z.optional(SessionPromptStackV1Schema),
  managedCreation: z.optional(SessionManagedCreationV1Schema),
  secretReferenceOverlay: z.optional(SecretReferenceOverlayV1Schema),
  requestedPermissionMode: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  agentModeId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  configuration: z.nullable(AgentSessionConfigurationSnapshotV1Schema),
  connectedServices: z.nullable(ConnectedServiceBindingsV2IngressSchema),
  capabilitySelection: z.nullable(SessionCapabilitySelectionAuthoringV1Schema),
  transcriptStorage: z.nullable(z.enum(['persisted', 'direct'])),
  terminal: z.nullable(SessionAuthoringTerminalV1Schema),
  agentSessionStartupInstructionsMarkerV1:
    z.nullable(AgentSessionStartupInstructionsMarkerV1Schema),
  checkout: z.nullable(z.strictObject({
    kind: z.literal('git_worktree'),
    finalDirectory: z.string().check(z.trim(), z.minLength(1)),
    baseRef: z.nullable(z.string().check(z.trim(), z.minLength(1))),
    branchMode: z.enum(['new', 'existing']),
  })),
}).check(z.superRefine((recipe, context) => refineSessionDirectoryIntentCheckoutV1(
  { directory: recipe.execution.directory, checkoutCreationDraft: recipe.checkout },
  context,
  ['checkout'],
))));
export type SessionCreationImmutableRecipeV1 = z.infer<
  typeof SessionCreationImmutableRecipeV1Schema
>;

export const SessionCreationCorrespondenceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionCreationTag: SessionCreationTagV1Schema,
  recipe: SessionCreationImmutableRecipeV1Schema,
}));
export type SessionCreationCorrespondenceV1 = z.infer<
  typeof SessionCreationCorrespondenceV1Schema
>;
export const SessionCreationCorrespondenceV1ReadSchema = createStoredReadSchema(SessionCreationCorrespondenceV1Schema);


export function normalizeSessionCreationOrganizationPlacementV1(
  input: z.input<typeof SessionOrganizationPlacementV1Schema> | undefined,
): z.output<typeof SessionOrganizationPlacementV1Schema> {
  const parsed = SessionOrganizationPlacementV1Schema.parse(
    input ?? { folderId: null, tagIds: [] },
  );
  return {
    folderId: parsed.folderId,
    tagIds: [...parsed.tagIds].sort((left, right) => left.localeCompare(right)),
  };
}

export function sessionCreationCorrespondenceMatchesV1(
  left: unknown,
  right: unknown,
): boolean {
  const parsedLeft = SessionCreationCorrespondenceV1ReadSchema.safeParse(left);
  const parsedRight = SessionCreationCorrespondenceV1ReadSchema.safeParse(right);
  return parsedLeft.success
    && parsedRight.success
    && JSON.stringify(semanticCorrespondence(parsedLeft.data)) === JSON.stringify(semanticCorrespondence(parsedRight.data));
}

function semanticCorrespondence(value: SessionCreationCorrespondenceV1) {
  const selection = value.recipe.modelSelection;
  return {
    ...value,
    recipe: {
      ...value.recipe,
      // Selection time orders later model updates; it does not change the
      // initial model/provider binding. Keep the stored carrier unchanged.
      modelSelection: selection ? { v: selection.v, ref: selection.ref } : null,
    },
  };
}
