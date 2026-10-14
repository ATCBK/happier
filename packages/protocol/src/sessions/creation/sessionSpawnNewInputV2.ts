import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../../connect/connectedServiceBindings.js';
import { SessionCapabilitySelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';
import { SessionModelSelectionV1Schema } from '../../providers/selection/v1.js';
import {
  AgentSessionConfigurationSnapshotV1Schema,
} from '../../runtime/agentSessionV1.js';
import { AgentPermissionIntentV1Schema, AgentSessionToolPolicyShapeV1 } from '../../runtime/permissionIntentV1.js';
import {
  AgentSessionStartupInstructionsV1Schema,
} from '../../runtime/agentSessionStartupInstructionsV1.js';
import {
  PluginSessionInputAttachmentsV1Schema,
  requireSessionInputContent,
} from '../messages/sessionInputAuthoringV1.js';
import { RawIngressStructuredInputV1Schema } from '../../runtime/input/structuredInputV1.js';
import { ReviewCommentDraftMessageV1Schema } from '../../messages/structured/reviewCommentsV1.js';
import {
  SessionAuthoringCheckoutCreationDraftV1Schema,
  SessionAuthoringTerminalV1Schema,
} from '../authoring/creationFieldsV1.js';
export { SessionAuthoringCheckoutCreationDraftV1Schema } from '../authoring/creationFieldsV1.js';
export type { SessionAuthoringCheckoutCreationDraftV1 } from '../authoring/creationFieldsV1.js';
import { SessionCreationKeyV1Schema } from './sessionCreationIdentityV1.js';
import { SessionSpawnSourceContextV1Schema } from './sessionSpawnSourceContextV1.js';
import { SessionExecutionTargetV1Schema } from './sessionExecutionTargetV1.js';
import { SessionOrganizationPlacementV1Schema } from './sessionSpawnNewResultV1.js';
import { MachinePoolSelectionOriginV1Schema } from '../../machines/pools/v1.js';
import { SessionInitialAccessDraftV1Schema } from '../access/sessionInitialAccessDraftV1.js';
import { SessionReportsToV1Schema } from '../relations/sessionReportsToV1.js';
import { SessionTeamCredentialBindingIntentsV1Schema } from '../../teams/credentials/sessionBindingIntentV1.js';
import { SecretReferenceOverlayV1Schema } from '../../profiles/secretReferenceOverlayV1.js';
import { SessionDirectoryIntentV1Schema, refineSessionDirectoryIntentCheckoutV1 } from './sessionDirectoryIntentV1.js';
import { SessionInitialTriggerV1Schema } from '../../workflows/triggers/workflowTriggerActionsV1.js';
import { SessionIdentityAdditionsV1Schema } from '../identity/sessionBotV1.js';
import { SessionPromptStackV1Schema } from '../context/sessionContextV1.js';
import { SessionManagedCreationV1Schema } from './sessionCreationCorrespondenceV1.js';
import { SessionAttestedContextV1Schema } from './sessionAttestedContextV1.js';
export { SessionAttestedContextV1Schema, type SessionAttestedContextV1 } from './sessionAttestedContextV1.js';

/**
 * One Message-owned input admitted before the new Session runtime may start.
 * The creation key owns retry identity, so this shape carries content only;
 * callers cannot establish a second Message idempotency owner.
 */
export const SessionSpawnNewInitialInputV1Schema = lazyZodSchema(() => z.strictObject({
  text: z.optional(z.string()),
  attachments: zMini.optional(PluginSessionInputAttachmentsV1Schema),
  /** Composer references and semantic attachments before a Session exists. */
  structuredInput: zMini.optional(RawIngressStructuredInputV1Schema),
  /** Session-independent drafts; spawn settlement adds the new Session ID. */
  reviewComments: z.optional(z.strictObject({
    comments: z.array(ReviewCommentDraftMessageV1Schema),
    displayText: z.string().check(z.minLength(1)),
  })),
}).check(z.superRefine(requireSessionInputContent)));
export type SessionSpawnNewInitialInputV1 = z.infer<typeof SessionSpawnNewInitialInputV1Schema>;

/**
 * The sole public request for an ordinary authored hosted Session. Legacy flat
 * spawn fields are normalized before this boundary and are never accepted as a
 * second canonical creation vocabulary.
 */
export const SessionSpawnNewInputV2BaseSchema = lazyZodSchema(() => z.strictObject({
  ...AgentSessionToolPolicyShapeV1,
  creationKey: zMini.optional(SessionCreationKeyV1Schema),
  executionTarget: SessionExecutionTargetV1Schema,
  placementOrigin: zMini.optional(MachinePoolSelectionOriginV1Schema),
  directory: SessionDirectoryIntentV1Schema,
  organizationPlacement: zMini.optional(SessionOrganizationPlacementV1Schema),
  agentTarget: AgentExecutionTargetV1Schema,
  roleId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  modelSelection: zMini.optional(SessionModelSelectionV1Schema),
  profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Value-free Saved Secret binding overrides for this launch only. */
  secretReferenceOverlay: zMini.optional(SecretReferenceOverlayV1Schema),
  permissionMode: zMini.optional(asProtocolZod(AgentPermissionIntentV1Schema)),
  agentModeId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  configuration: zMini.optional(AgentSessionConfigurationSnapshotV1Schema),
  connectedServices: zMini.optional(ConnectedServiceBindingsV2IngressSchema),
  capabilitySelection: zMini.optional(SessionCapabilitySelectionAuthoringV1Schema),
  transcriptStorage: z.optional(z.enum(['persisted', 'direct'])),
  terminal: zMini.optional(SessionAuthoringTerminalV1Schema),
  checkoutCreationDraft: zMini.optional(zMini.nullable(SessionAuthoringCheckoutCreationDraftV1Schema)),
  title: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Host-owned identity facts persisted at ordinary Session birth. */
  identity: zMini.optional(SessionIdentityAdditionsV1Schema),
  /** Plugin-only, immutable integrator facts; never authored by an Agent or token. */
  attestedContext: zMini.optional(SessionAttestedContextV1Schema),
  /** Host-verified resource this Session was created with; never current Controller authority. */
  managedCreation: zMini.optional(SessionManagedCreationV1Schema),
  /** Admitted kind preference or explicit draft choice; omission uses the birth kind default. */
  memoryEnabled: z.optional(z.boolean()),
  /** Complete selected Session context committed before its first preparation. */
  promptStack: zMini.optional(SessionPromptStackV1Schema),
  initialInput: z.optional(SessionSpawnNewInitialInputV1Schema),
  initialTriggers: z.optional(z.array(z.lazy(() => SessionInitialTriggerV1Schema))),
  initialAccess: zMini.optional(SessionInitialAccessDraftV1Schema),
  reportsTo: zMini.optional(SessionReportsToV1Schema),
  primaryTeamId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  /** Complete slot-keyed Team credential selection batch for the fresh Session commit. */
  teamCredentialBindings: zMini.optional(SessionTeamCredentialBindingIntentsV1Schema),
  agentSessionStartupInstructionsV1: zMini.optional(AgentSessionStartupInstructionsV1Schema),
  /**
   * Create this Session as a continuation of an existing one. Because this
   * schema is `.strict()`, a daemon that predates the field REJECTS the request
   * instead of silently dropping the source recipe — operation-scoped safe
   * degradation, not compatibility by silent ignore.
   */
  sourceContext: zMini.optional(SessionSpawnSourceContextV1Schema),
  /**
   * Raw launch environment forwarded verbatim to the spawned process. Only the
   * CLI's direct-to-daemon path may carry it: the browser-safe server-start
   * draft below omits it so values never enter server-visible creation state.
   * Bounds match the handoff resume plan's environment contract.
   */
  environmentVariables: z.optional(z.record(z.string().check(z.minLength(1), z.maxLength(128)), z.string().check(z.maxLength(16 * 1024)))),
}));

export const SessionSpawnNewInputV2Schema = lazyZodSchema(() => SessionSpawnNewInputV2BaseSchema.check(z.superRefine(refineSessionDirectoryIntentCheckoutV1)));

export type SessionSpawnNewInputV2 = z.infer<typeof SessionSpawnNewInputV2Schema>;

/**
 * Browser-safe omission of host-sealed creation facts. The daemon-only
 * server-start transport consumes this exact projection without owning a
 * second Session input schema.
 */
export const SessionServerStartSpawnDraftV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(SessionSpawnNewInputV2BaseSchema, {
  creationKey: true,
  initialInput: true,
  environmentVariables: true,
  attestedContext: true,
})).check(z.superRefine(refineSessionDirectoryIntentCheckoutV1)));

export type SessionServerStartSpawnDraftV1 = Omit<
  SessionSpawnNewInputV2,
  'creationKey' | 'initialInput' | 'environmentVariables' | 'attestedContext'
>;
