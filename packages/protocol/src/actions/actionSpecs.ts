import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginLocalizedStringV2Schema } from '../plugins/contributions/publicTypes.js';
import { SessionAccessEncryptionPrepareInputV1Schema, SessionAccessEncryptionReprepareInputV1Schema, SessionAccessEncryptionPrepareResultV1Schema, SessionAccessLayoutUpdateResultV1Schema } from '../sessions/access/sessionAccessActionsV1.js';
import { resolveMachineRpcGovernance } from '../machines/peer/mediation/rpc/governanceV1.js';
import { EXECUTION_RUN_INTENT_OPTIONS } from '../execution/runs/intentPolicyMatrix.js';
import { CODE_INTELLIGENCE_ACTION_SPECS } from './codeIntelligenceActionFamily.js';
import { SessionIdSchema } from '../sessions/idsV1.js';
import { parseQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';
import { PetChooseInputV1Schema, PetChooseResultV1Schema } from '../pets/selection.js';
import { RawIngressStructuredInputV1Schema } from '../runtime/input/structuredInputV1.js';
import { ActionSessionTargetDeclarationV1Schema, SessionTargetV1Schema, SessionTargetPreviewV1Schema, withSessionTargetFanoutResultV1, type SessionTargetV1 } from './sessionTargetV1.js';
import { SessionCoordinatorEnableInputV1Schema, SessionCoordinatorEnableResultV1Schema } from '../sessions/follow/sessionCoordinatorActionsV1.js';

/** What a presenting app knows that an approval summary may use; every field is optional. */
export type ApprovalPresentationContext = Readonly<{
  /** The target Machine's readable form of a path (home-relative). */
  formatPath?: (path: string) => string;
  /** Names captured from the admitted widget/catalog owners; presentation only, never routing. */
  widgetPresentation?: Readonly<{ widgetName?: string; pageName?: string; areaName?: string }>;
}>;
import { ScmDiffSummaryModelSelectorSchema } from '../scm/diffSummary.js';
import { BugReportSubmitInputSchema, BugReportSubmitOutputSchema, projectBugReportSubmitInput } from './specs/bugReport.js';
import { ModelFavoriteMutationV1Schema } from '../providers/modelFavoritesV1.js';
import { PLUGIN_EXECUTION_ORIGIN_ACTION_SPECS } from './specs/pluginExecutionOrigin.js';
import { NPM_REGISTRY_PROFILE_ACTION_SPECS_V1 } from './specs/npmRegistryProfiles.js';
import { PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_SPECS } from './specs/pluginAccountAdministration.js';
import { PluginAccountAdministrationActionInputSchemas, PluginAccountAdministrationActionOutputSchemas,
  type PluginAccountAdministrationActionId } from './pluginAccountAdministrationActionFamily.js';
import { NpmRegistryProfileActionInputSchemasV1, NpmRegistryProfileActionOutputSchemasV1,
  type NpmRegistryProfileActionIdV1 } from './npmRegistryProfileActionFamily.js';
import { PluginUpdatePolicyV1Schema } from '../marketplace/pluginUpdatePolicyV1.js';
import { ManagedResourceDispositionV1Schema } from '../machines/managed/managedDependencyV1.js';
import { PluginExecutionOriginActionInputSchemas, PluginExecutionOriginActionOutputSchemas,
  type PluginExecutionOriginActionId } from './pluginExecutionOriginActionFamily.js';
import { ActionPromptingSchema } from './metadata.js';
export { ActionPromptingSchema, type ActionPrompting } from './metadata.js';
import { MACHINE_PRESET_INPUT_FIELDS, MACHINE_POOL_INPUT_FIELDS } from './specs/machineInputHints.js';
import { AccountHomeContinuationInputV1Schema, AccountHomeContinuationResultV1Schema } from './accountHomeContinuationV1.js';
import { SessionForkRpcParamsSchema } from '../sessions/fork.js';
import { SessionResumeRequestV1Schema } from '../sessions/control/sessionResumeRequestV1.js';
import { SessionNeedsYouRaiseInputV1Schema, SessionNeedsYouRaiseOutputV1Schema } from '../sessions/permissions/questionV1.js';
import { SessionStatusActionResultV1Schema, SessionArchiveActionInputV1Schema, SessionArchiveActionResultV1Schema } from '../sessions/control/contract.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../connect/connectedAccountPurposeIdentity.js';
import { QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema } from '../connect/connectedAccountPurposeBindings.js';
import { RestartSessionRunnerResultV1Schema } from '../sessions/control/sessionRunnerRestartV1.js';
import { PromptDocRevisionV1Schema, PromptDocCreateActionInputV1Schema } from '../prompts/library/promptDocV2.js';
import { PromptBundleCreateActionInputV1Schema, PromptBundleUpdateActionInputV1Schema } from '../prompts/library/promptBundleSchemas.js';
import { PromptLibrarySaveOrganizationFieldsV1, isPromptLibrarySaveFolderAssignmentV1 } from '../prompts/library/promptFolderActionSchemasV1.js';
import { PromptLibraryStackUpdateInputV1Schema, PromptLibraryStackUpdateResultV1Schema } from '../prompts/library/promptStacksV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import { ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1 } from '../activity/accountNoticeArtifactKindsV1.js';
import { SessionSurfaceItemV1Schema } from '../sessions/board/item.js';
import { readSessionVisualCapabilitiesV1 } from '../sessions/board/visualPolicy.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { SessionPendingWithdrawInputV1Schema, SessionPendingWithdrawResultV1Schema } from '../sessions/control/pendingWithdrawV1.js';
import { SessionPendingMarkHandledInputV1Schema, SessionPendingDeliveryRecoveryInputV1Schema,
  SessionPendingDeliveryRecoveryResultV1Schema, SessionPendingSendAsNewResultV1Schema } from '../sessions/control/pendingDeliveryRecoveryV1.js';
import { SessionModelMutationExpectedV1Schema, SessionModelTransitionResultV1Schema } from '../sessions/control/modelTransitionV1.js';
import { MEMORY_DOCUMENT_ACTION_SPECS_V1 } from './specs/memoryDocuments.js';
import { DOC_COLLABORATION_ACTION_SPECS_V1 } from './specs/docCollaboration.js';
import { WORKFLOW_EVENT_CATALOG_ACTION_SPECS_V1 } from './specs/workflowEvents.js';
import { MEMORY_DOCUMENT_ACTION_IDS_V1 } from '../prompts/library/memoryActionsV1.js';
import { PROFILE_ACTION_SPECS_V1 } from './specs/profiles.js';
import {
  describeCreateDirectoryApprovalSummary, describeDeleteApprovalSummary, describeRenameApprovalSummary,
  describeUploadApprovalSummary, describeWriteFileApprovalSummary, projectWriteFileApprovalInput,
} from './specs/filesystemApprovalPresentation.js';
import { MCP_SERVER_ACTION_SPECS_V1 } from './specs/mcpServers.js';
import { REGISTRY_ACTION_SPECS_V1, readRegistryAgentCliLocatorV1 } from './specs/registries.js';
export { readRegistryAgentCliLocatorV1 } from './specs/registries.js';
import { PERSONAL_SAVED_SECRET_ACTION_SPECS_V1 } from './specs/personalSavedSecrets.js';
import { AgentsAcpBackendsInstallFromRegistryInputV1Schema, AgentsAcpBackendsInstallFromRegistryOutputV1Schema } from '../acp/catalog/registry/registryInstallActionV1.js';
import { CAPABILITY_RULES_ACTION_SPECS_V1 } from './specs/capabilityRules.js';
import { SESSION_CAPABILITIES_ACTION_SPECS_V1 } from './specs/sessionCapabilities.js';
import { SESSION_ACCESS_DISCOVERY_ACTION_SPECS_V1 } from './specs/sessionAccessDiscovery.js';
import { FRIENDS_ACTION_SPECS } from './specs/friends.js';
import { SKILL_ACTION_SPECS_V1 } from './specs/skills.js';
import { MCP_SERVER_ACTION_INPUT_SCHEMAS_V1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1, type McpServerActionIdV1 } from '../mcp/servers/serverActionsV1.js';
import { PROVIDER_ACTION_SPECS_V1 } from './specs/providers.js';
import { PROVIDER_ACTION_INPUT_SCHEMAS_V1, PROVIDER_ACTION_OUTPUT_SCHEMAS_V1, type ProviderActionIdV1 } from '../providers/providerActionsV1.js';
import { REMOTE_HOST_ACTION_SPECS_V1 } from './specs/remoteHosts.js';
import { HOME_RUNTIME_ACTION_SPECS_V1 } from './specs/homeRuntime.js';
import { ACCOUNT_LIFECYCLE_ACTION_SPECS } from './specs/accountLifecycle.js';
import { HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1, HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1, type HomeRuntimeActionIdV1 } from '../home/runtime/actionsV1.js';
import { REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1, REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1, type RemoteHostActionIdV1 } from '../remoteHosts/remoteHostActionsV1.js';
import { ARTIFACT_FOLDER_ACTION_SPECS_V1 } from './specs/artifactFolders.js';
import { ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1, ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1 } from '../prompts/library/promptFolderActionSchemasV1.js';
import type { ArtifactFolderActionIdV1 } from '../prompts/library/artifactFolderActionIdsV1.js';
import { PROFILE_ACTION_INPUT_SCHEMAS_V1, PROFILE_ACTION_OUTPUT_SCHEMAS_V1, type ProfileActionIdV1 } from '../profiles/profileActionsV1.js';
import { FilesystemReadFileInputSchema, FilesystemReadFileOutputSchema, FilesystemWriteFileInputSchema, FilesystemWriteFileOutputSchema, FilesystemListDirectoryInputSchema, FilesystemListDirectoryOutputSchema, FilesystemGetDirectoryTreeInputSchema, FilesystemGetDirectoryTreeOutputSchema, FilesystemCreateDirectoryInputSchema, FilesystemRenameInputSchema, FilesystemDeleteInputSchema, FilesystemCopyInputSchema, FilesystemCopyOutputSchema, FilesystemMutationOutputSchema, FilesystemUploadInputSchema, FilesystemUploadOutputSchema, FilesystemDownloadInputSchema, FilesystemDownloadOutputSchema, FilesystemTransferCancelInputSchema, FilesystemTransferCancelOutputSchema } from './filesystemActionFamily.js';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema } from '../projects/openProjectV1.js';
import { BotSetInputSchema } from '../sessions/identity/sessionBotV1.js';
import { MANAGED_MACHINE_ACTION_SPECS } from './specs/managedMachines.js';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1, type ManagedMachineActionIdV1 } from '../machines/managed/actionsV1.js';
import { SessionTitleSetInputSchema, SessionStatusReasonSetInputSchema, SessionStatusReasonSetResultSchema, SessionToolCallsSetInputSchema, SessionMemorySetInputV1Schema, SessionVoicePreferenceSetInputV1Schema, SessionContextUpdateInputV1Schema, SessionInstructionsSetInputV1Schema } from './sessionStateFieldActions.js';
import { ProjectContextUpdateInputV1Schema, ProjectContextUpdateOutputV1Schema } from '../projects/projectContextV1.js';
import { ProjectVisibilitySetInputV1Schema, ProjectVisibilitySetOutputV1Schema } from '../projects/projectVisibilityV1.js';
import { ProjectWorkspaceUpdateInputV1Schema, ProjectWorkspaceUpdateOutputV1Schema,
  ProjectWorkspaceForgetInputV1Schema, ProjectWorkspaceForgetOutputV1Schema } from '../projects/projectWorkspaceActionsV1.js';
import { PassthroughEmptyObjectSchema } from './specs/common.js';
import { InputOptionsConsumerV1Schema } from '../inputs/inputOptionsConsumer.js';
import { VOICE_CONVERSATION_ACTION_SPECS, VoiceConversationActionInputSchemas, VoiceConversationActionOutputSchemas, type VoiceConversationActionId } from './voiceConversationActionFamily.js';
import {
  SessionAccessGrantsListRequestV1Schema, SessionAccessGrantsListResponseV1Schema,
  SetSessionAccessGrantResponseV1Schema,
  RemoveSessionAccessGrantRequestV1Schema, RemoveSessionAccessGrantResponseV1Schema,
  SetSessionAccessContextRequestV1Schema, SetSessionAccessContextResponseV1Schema,
} from '../sessions/access/sessionAccessOperationsV1.js';
import {
  AgentsAcpBackendsDeleteInputV1Schema,
  AgentsAcpBackendsDeleteOutputV1Schema,
  AgentsAcpBackendsGetInputV1Schema,
  AgentsAcpBackendsGetOutputV1Schema,
  AgentsAcpBackendsUpsertInputV1Schema,
  AgentsAcpBackendsUpsertOutputV1Schema,
} from '../acp/catalog/catalogMutationsV1.js';
import {
  SessionAccessGrantSetActionInputV1Schema,
  SessionPublicLinkCreateActionInputV1Schema, SessionPublicLinkCreateActionResultV1Schema,
  SessionPublicLinkGetActionResultV1Schema, SessionPublicLinkRemoveActionResultV1Schema,
} from '../sessions/access/sessionAccessActionsV1.js';
import {
  SetSessionResponsibilityRequestSchema, SetSessionResponsibilityResponseSchema,
  SessionResponsibilityCandidatesRequestSchema, SessionResponsibilityCandidatesResponseSchema,
} from '../sessions/access/sessionResponsibilityV1.js';
import { z } from 'zod/mini';
import { ExternalSessionsRpcErrorCodeSchema } from '../sessions/external/rpcErrorCodes.js';
import { AccountHistoricalEncryptionKeyForgetInputV1Schema, AccountHistoricalEncryptionKeyForgetResultV1Schema,
  AccountEncryptionAutomationTemplatesRecoverInputV1Schema, AccountEncryptionAutomationTemplatesRecoverResultV1Schema } from '../auth/accountSecurity.js';
import { SCM_COMPARISON_VIEWS, ScmComparisonSourceSchema } from '../scm/comparison.js';
import { redactPublicShareCapabilityUrl } from '../crypto/publicShareCapabilityUrl.js';
import { ExecutionRunWaitConditionSchema } from '../execution/runs/waitForTerminal.js';
import { WaitActionInputV1Schema, WaitActionResultV1Schema, WAIT_CLI_PROJECTION } from './specs/wait.js';
import type { ApprovalNarrowing } from '../approvals/approvalNarrowing.js';
import { WORK_BOARD_ACTION_IDS_V1, type WorkBoardActionIdV1 } from '../boards/actionIdsV1.js';
import { WorkBoardActionInputSchemasV1, WorkBoardActionOutputSchemasV1 } from '../boards/actionsV1.js';
import { DaemonProviderModelProjectionResponseV1Schema } from '../rpc/providers.js';
import { DECISION_ACTION_IDS, TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS, canRequestPresentUserApprovalForActionInputV1 } from './decisionAuthority.js';
import { SessionPermissionRespondActionDecisionV1Schema, SessionPermissionRespondRpcParamsV1Schema } from '../sessions/permissions/respondRpcParamsV1.js';
import { SessionMessageV1Schema } from '../sessions/messages/sessionMessagesPageV1.js';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '../sessions/messages/sessionStoredMessageContent.js';
import { SessionSharedMetadataV1Schema } from '../sessions/metadata/sessionMetadataSchemasV1.js';
import {
  NotificationsNotifyMeInputV1Schema,
  NotificationsNotifyMeResultV1Schema,
} from '../account/notifications/notifyMeV1.js';
import {
  MachinesAgentsSignInStartInputSchema, MachinesAgentsSignInStartOutputSchema,
  MachinesAgentsSignInStatusInputSchema, AgentSignInStatusResponseSchema,
  MachinesAgentsSignInCancelInputSchema, MachinesAgentsSignInCancelOutputSchema,
} from '../daemon/agentSignIn.js';
import { MachinesAgentsListInputSchema, MachinesAgentsListOutputSchema } from '../capabilities/machineAgentInventory.js';
import { DaemonWorkspaceFileSearchRequestSchema, DaemonWorkspaceFileSearchResponseSchema } from '../machines/workspaceFiles.js';
import { DaemonWorkspaceFileReplacePreviewRequestSchema, DaemonWorkspaceFileReplacePreviewResponseSchema, DaemonWorkspaceFileReplaceApplyRequestSchema, DaemonWorkspaceFileReplaceApplyResponseSchema, WorkspaceFileReplaceOperationSchema, WorkspaceFileRestoreOperationSchema } from '../machines/workspaceFiles.js';
import { ActionOperationGetV1RequestSchema } from './operations/v1.js';

export const WorkspaceFilesReplacePreviewActionInputSchema = lazyZodSchema(() => z.strictObject({
  ...DaemonWorkspaceFileReplacePreviewRequestSchema.shape,
  machineId: z.string().check(z.trim(), z.minLength(1)),
}));
export const WorkspaceFilesReplaceActionInputSchema = lazyZodSchema(() => z.strictObject({
  ...DaemonWorkspaceFileReplaceApplyRequestSchema.shape,
  operation: z.discriminatedUnion('kind', [WorkspaceFileReplaceOperationSchema, WorkspaceFileRestoreOperationSchema]),
  machineId: z.string().check(z.trim(), z.minLength(1)),
}));
export type WorkspaceFilesReplacePreviewActionInput = z.infer<typeof WorkspaceFilesReplacePreviewActionInputSchema>;
export type WorkspaceFilesReplaceActionInput = z.infer<typeof WorkspaceFilesReplaceActionInputSchema>;
export const WorkspaceFilesReplaceActionOutputSchema = lazyZodSchema(() => z.union([
  DaemonWorkspaceFileReplaceApplyResponseSchema,
  z.strictObject({ operation: ActionOperationGetV1RequestSchema }),
]));
export type WorkspaceFilesReplaceActionOutput = z.infer<typeof WorkspaceFilesReplaceActionOutputSchema>;

export const WorkspaceFilesSearchActionInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonWorkspaceFileSearchRequestSchema, {
  machineId: z.string().check(z.trim(), z.minLength(1)),
})));
import {
  DaemonAgentInstallStartRequestSchema,
  DaemonAgentInstallStartResponseSchema,
  DaemonAgentInstallReadRequestSchema,
  DaemonAgentInstallReadResponseSchema,
  DaemonAgentInstallCancelRequestSchema,
  DaemonAgentInstallCancelResponseSchema,
} from '../daemon/agentInstallJobs.js';
import type { ActionCompletionDeclaration } from './actionCompletion.js';
import { planStartCompletion, reviewStartCompletion, reviewWalkthroughCompletion } from './specs/executionRunCompletion.js';
import { SCM_GIT_ACTION_SPECS } from './scmGitActionSpecs.js';
import { WORKSPACE_ACTION_SPECS, WORKSPACE_ACTION_INPUT_SCHEMAS, WORKSPACE_ACTION_OUTPUT_SCHEMAS, type WorkspaceActionId } from './workspaceActionFamily.js';
import { PROJECT_DEFINITION_ACTION_SPECS, PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS, PROJECT_DEFINITION_ACTION_OUTPUT_SCHEMAS, type ProjectDefinitionActionId } from './projectDefinitionActionFamily.js';
import { PROJECT_ACTION_SPECS_V1, PROJECT_ACTION_INPUT_SCHEMAS_V1, PROJECT_ACTION_OUTPUT_SCHEMAS_V1, type ProjectActionIdV1 } from './projectActionFamily.js';
import { SESSION_TERMINAL_ACTION_SPECS, SESSION_TERMINAL_ACTION_INPUT_SCHEMAS, SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS, type SessionTerminalActionId } from './sessionTerminalActionFamily.js';
import { SESSION_AGENT_TRANSITION_ACTION_SPECS, SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS,
  SESSION_AGENT_TRANSITION_ACTION_OUTPUT_SCHEMAS, type SessionAgentTransitionActionId } from './sessionAgentTransitionActionFamily.js';
import { COMMAND_PALETTE_ACTION_SPECS } from './commandPaletteActionSpecs.js';
import { FIND_ACTION_SPECS } from './findActionSpecs.js';
import { PROMPT_PICKER_ACTION_SPECS } from './promptPickerActionSpecs.js';
import { PROMPT_INVOCATION_CREATE_ACTION_SPECS } from './promptInvocationCreateActionSpecs.js';
import { SESSION_PENDING_NEXT_ACTION_SPECS } from './specs/sessionPendingNext.js';
export type { SessionPendingNextOutput } from './specs/sessionPendingNext.js';
import { AcpBackendApprovalInputSchema, projectAcpBackendApprovalInput } from './specs/acpBackendApproval.js';
import { PROJECT_WORKER_ACTION_SPECS, ProjectWorkerActionInputSchemasV1, ProjectWorkerActionOutputSchemasV1,
  type ProjectWorkerActionIdV1 } from './specs/projectWorkers.js';
import { ACTION_OPERATION_ACTION_SPECS, ActionOperationActionInputSchemasV1, ActionOperationActionOutputSchemasV1,
  type ActionOperationActionIdV1 } from './specs/actionOperations.js';
import { SESSION_ORGANIZATION_MOVE_ACTION_SPECS } from './sessionOrganizationMoveAction.js';
import { LIST_REORDER_ACTION_SPECS } from './listReorderAction.js';
import { TODO_SESSION_LINK_ACTION_SPECS } from './todoSessionLinkAction.js';
import { INTERNAL_TASK_ACTION_SPECS } from './internalTaskActions.js';
import { WORKFLOW_AUTHORING_ACTION_SPECS } from './workflowAuthoringAction.js';
import { WORKFLOW_DIAGNOSTIC_ACTION_SPECS } from './workflowDiagnosticActionSpecs.js';
import { SessionAuthoringOpenV1Schema, SessionAuthoringOpenResultV1Schema } from '../plugins/ui/hostApiRequests.js';
import { COMPOSER_INGRESS_ACTION_SPECS } from './composerIngressAction.js';
import { SETTINGS_DECLARATION_ACTION_IDS_V1, SettingsDeclarationActionInputSchemasV1, SettingsDeclarationActionOutputSchemasV1, type SettingsDeclarationActionIdV1 } from './settingsDeclarationActionFamily.js';
import { ACTION_POLICY_ACTION_IDS, ActionPolicyInputSchemas, ActionPolicyOutputSchemas, type ActionPolicyActionId } from './actionPolicyActionFamily.js';
import { describeSettingsDeclarationApprovalSummaryV1, projectSettingsDeclarationApprovalInputV1, readBuiltInSettingDeclarationV1, readBuiltInSettingsOperationApprovalPolicyV1 } from './settings/settingsDeclarations.js';
import { APP_SHELL_ACTION_IDS, APP_SHELL_ACTION_SPECS } from './appShellActionFamily.js';
import { NOTIFICATION_CONFIGURATION_ACTION_IDS, NOTIFICATION_CONFIGURATION_ACTION_SPECS, NotificationConfigurationActionInputSchemas, NotificationConfigurationActionOutputSchemas, type NotificationConfigurationActionId } from './notificationConfigurationActionFamily.js';
import { APP_UPDATE_ACTION_IDS, APP_UPDATE_ACTION_SPECS, AppUpdateActionInputSchemas, AppUpdateActionOutputSchemas, type AppUpdateActionId } from './appUpdateActionFamily.js';
import { UPDATES_ACTION_IDS, UPDATES_ACTION_SPECS, UpdatesActionInputSchemas, UpdatesActionOutputSchemas, type UpdatesActionId } from './updatesActionFamily.js';
import { CLIPBOARD_ACTION_SPECS } from './clipboardActionFamily.js';
import { WORKFLOW_EFFECT_ACTION_SPECS_V1, WorkflowEffectActionInputSchemasV1, WorkflowEffectActionOutputSchemasV1, type WorkflowEffectActionIdV1 } from '../workflows/stepActionsV1.js';
import { ROLE_ACTION_IDS_V1, type RoleActionIdV1 } from '../prompts/roles/roleActionIdsV1.js';
import { LaunchProfilePublishInputV1Schema, LaunchProfilePublishOutputV1Schema } from '../launchProfiles/publishLaunchProfile.js';
import { RoleActionInputSchemasV1, RoleActionOutputSchemasV1, isAccountRoleMutationV1 } from '../prompts/roles/roleActionsV1.js';
import { ARTIFACT_ACCESS_ACTION_IDS_V1, ArtifactAccessActionInputSchemasV1, ArtifactAccessActionOutputSchemasV1, type ArtifactAccessActionIdV1 } from '../artifacts/artifactAccessV1.js';
import { ARTIFACT_ACTION_IDS_V1, ArtifactActionInputSchemasV1, ArtifactActionOutputSchemasV1, type ArtifactActionIdV1 } from '../artifacts/artifactActionsV1.js';
import { SessionListQueryV1Schema } from '../sessions/listing/query.js';
import { QualifiedProjectKeyV1Schema } from '../workspaces/workspaceRefV1.js';
import { SessionManagerSetActionInputV1Schema, SessionManagerSetResultV1Schema } from '../sessions/follow/sessionManagerV1.js';
import {
  SetSessionFolderAssignmentRequestSchema, SetSessionFolderAssignmentResponseSchema,
  SetSessionTagAssignmentsRequestSchema, SetSessionTagAssignmentsResponseSchema,
} from '../sessions/organization/mutations.js';
import { SessionUpdatePostInputV1Schema, SessionUpdatePostOutputV1Schema } from '../sessions/relations/workerUpdateV1.js';
import {
  SESSION_LIST_AWARENESS_VIEW_V1,
  SESSION_LIST_SUMMARY_VIEW_V1,
  SessionActivityActionResultV1Schema,
  SessionListActionResultV1Schema,
  SessionListViewV1Schema,
  type SessionListViewV1,
} from '../sessions/awareness/action.js';
import {
  SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1,
  SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1,
  SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
} from '../sessions/board/actions.js';
import {
  DISCUSSION_ACTION_INPUT_SCHEMAS_V1,
  DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1,
} from '../discussions/actions.js';
import {
  CurrentSessionPresentationActionInputV1Schema,
  CurrentSessionPresentationActionResultV1Schema,
} from '../sessions/presentation/currentSessionPresentationV1.js';
import {
  MACHINE_POOL_ACTION_IDS_V1,
  MachinePoolActionInputSchemasV1,
  MachinePoolActionOutputSchemasV1,
  machinePoolActionEndpointPathV1,
  type MachinePoolActionIdV1,
} from '../machines/pools/actionsV1.js';
import {
  MACHINE_PRESET_ACTION_IDS_V1, MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1,
  machinePresetActionEndpointPathV1,
  type MachinePresetActionIdV1,
} from '../machines/managed/machinePresetActionsV1.js';
import {
  EPHEMERAL_RUNNER_ACTION_IDS_V1,
  EPHEMERAL_RUNNER_ACTION_TRANSPORTS_V1,
  EphemeralRunnerActionInputSchemasV1,
  EphemeralRunnerActionOutputSchemasV1,
  type EphemeralRunnerActionIdV1,
} from '../ephemeralRunner/actionsV1.js';
import {
  WorkflowActionInputSchemasV1,
  WorkflowActionOutputSchemasV1,
  type WorkflowActionIdV1,
} from '../workflows/actionsV1.js';
import {
  ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1,
  ACCOUNT_PASSWORD_CHANGE_PATH_V1,
  ACCOUNT_PASSWORD_ENROLL_PATH_V1,
  ACCOUNT_PASSWORD_REMOVE_PATH_V1,
  ACCOUNT_SECURITY_PATH_V1,
} from '../auth/accountSecurity.js';

import {
  assertPublicActionSdkMethodNames,
  resolveActionSdkMethodName,
} from './actionSdkMethodNames.js';

export { resolveActionSdkMethodName } from './actionSdkMethodNames.js';

import { ActionOperationDeclarationV1Schema, ActionOperationReentryPolicyV1Schema } from './operations/v1.js';
import {
  ActionCliProjectionSchema,
  readActionSchemaTopLevelFieldNames,
  type ActionCliCommandBinding,
  type ActionCliBindContext,
} from './actionCliProjection.js';
import { AgentsBackendsListOutputSchema } from './agentBackendInventory.js';
import {
  ActionExecutionPlacementSchema,
  ActionInputHintsSchema,
  ActionRequiredAuthoritySchema,
  ActionSurfaceSchema,
  ActionToolExposureModeSchema,
  ActionToolExposureSchema,
  ActionToolExposureSurfaceSchema,
  type ActionExecutionPlacement,
  type ActionInputHints,
  type ActionRequiredAuthority,
  type ActionSurfaces,
  type ActionToolExposure,
  type ActionToolExposureMode,
  type ActionToolExposureSurface,
} from './metadata.js';

import type { ActionCaller } from './executor/types.js';
import type { ExternalActionTargetV1 } from './externalActionApi.js';
import { ActionSafetySchema } from './safety.js';
import {
  ConversationTurnOriginV1Schema,
  type ConversationTurnOriginV1,
} from '../messages/structured/conversationTurnOriginV1.js';
import { SubagentLaunchV1Schema } from '../messages/structured/subagentLaunchV1.js';
import { SubagentCommandV1Schema } from '../messages/structured/subagentCommandV1.js';
import {
  ACTION_IDS,
  ACTION_ID_FAMILIES_V1,
  ActionIdSchema,
  PLUGIN_DEV_LOOP_ACTION_IDS_V1,
  RUNTIME_ACTION_IDS_V1,
  WORKFLOW_ACTION_IDS_V1,
  isRuntimeActionIdV1,
  type ActionId,
  type PluginDevLoopActionIdV1,
  type RuntimeActionIdV1,
} from './actionIds.js';
import {
  HUMAN_SECRET_API_EXCLUSION_ACTION_IDS,
  HUMAN_SECRET_API_EXCLUSION_REASONS,
  INTERNAL_ACTION_IDS,
  INTERNAL_ACTION_REASONS,
  PLUGIN_INVOCABLE_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_REASONS,
  PluginInvocableActionIdSchema,
  isHumanSecretApiExcludedActionId,
  isInternalActionId,
  isPluginSurfaceExcludedActionId,
  type HumanSecretApiExcludedActionId,
  type InternalActionId,
  type PluginInvocableActionId,
  type PluginSurfaceExcludedActionId,
} from './pluginActionSurface.js';

export {
  HUMAN_SECRET_API_EXCLUSION_ACTION_IDS,
  HUMAN_SECRET_API_EXCLUSION_REASONS,
  INTERNAL_ACTION_IDS,
  INTERNAL_ACTION_REASONS,
  PLUGIN_INVOCABLE_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_ACTION_IDS,
  PLUGIN_SURFACE_EXCLUSION_REASONS,
  PluginInvocableActionIdSchema,
  isHumanSecretApiExcludedActionId,
  isInternalActionId,
  isPluginSurfaceExcludedActionId,
  type HumanSecretApiExcludedActionId,
  type InternalActionId,
  type PluginInvocableActionId,
  type PluginSurfaceExcludedActionId,
};
import { ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { ReviewWalkthroughInputSchema, ReviewExplainFindingsInputSchema, ExecutionRunOutputObservationSchema } from '../reviews/reviewNarration.js';
import {
  REVIEW_COMMENT_ACTION_IDS_V1,
  ReviewCommentActionInputSchemasV1,
  ReviewCommentActionOutputSchemasV1,
  type ReviewCommentActionIdV1,
} from '../reviews/comments/actions.js';
import {
  PLUGIN_PERMISSION_GRANT_ACTION_IDS_V1,
  PluginPermissionGrantActionInputSchemasV1,
  PluginPermissionGrantActionOutputSchemasV1,
  type PluginPermissionGrantActionIdV1,
} from '../plugins/permissions/actions.js';
import { PluginPermissionSubjectV1Schema } from '../plugins/permissions/grants.js';
import {
  PLUGIN_WEBHOOK_ACTION_IDS_V1,
  PluginWebhookActionHttpPathsV1,
  PluginWebhookPluginSurfaceActionHttpPathsV1,
  PluginWebhookActionInputSchemasV1,
  PluginWebhookActionOutputSchemasV1,
  PluginWebhookEndpointEnsureResultV1Schema,
  isPluginWebhookPluginSurfaceActionIdV1,
  type PluginWebhookActionIdV1,
  type PluginWebhookPresentUserActionIdV1,
} from '../plugins/webhooks/endpointV1.js';
import {
  PluginAccountDataEraseActionInputV1Schema,
  PluginAccountDataEraseActionOutputV1Schema,
} from '../plugins/data/accountEraseV1.js';
import {
  AccountSessionsSignOutEverywhereActionInputV1Schema,
  AccountSessionsSignOutEverywhereActionOutputV1Schema,
} from '../auth/accountSessions.js';
import {
  AccountEmailChangeRequestResponseV1Schema,
  AccountEmailChangeRequestV1Schema,
  AccountPasswordChangeRequestV1Schema,
  AccountPasswordEnrollRequestV1Schema,
  AccountPasswordMutationResponseV1Schema,
  AccountPasswordRemoveRequestV1Schema,
  AccountSecurityGetRequestV1Schema,
  AccountSecurityGetResponseV1Schema,
  AccountTerminalPresentUserPolicySetRequestV1Schema,
  AccountTerminalPresentUserPolicySetResponseV1Schema,
  ACCOUNT_TERMINAL_PRESENT_USER_POLICY_PATH_V1,
} from '../auth/accountSecurity.js';
import {
  ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
  AccountApiTokensUpdateActionInputV1Schema,
  AccountApiTokensUpdateActionOutputV1Schema,
  AccountApiTokensCreateActionInputV1Schema,
  AccountApiTokensCreateActionOutputV1Schema,
  projectAccountApiTokenCreationObservation,
  AccountApiTokensListActionInputV1Schema,
  AccountApiTokensListActionOutputV1Schema,
  AccountApiTokensRevokeActionInputV1Schema,
  AccountApiTokensRevokeActionOutputV1Schema,
  AccountApiTokensRevokeAllActionInputV1Schema,
  AccountApiTokensRevokeAllActionOutputV1Schema,
} from '../auth/accountApiTokens.js';
import {
  PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1,
  PluginSettingsAdministrationActionInputSchemasV1,
  PluginSettingsAdministrationActionOutputV1Schema,
  resolvePluginSettingsAdministrationTargetV1,
  type PluginSettingsAdministrationActionIdV1,
} from '../plugins/settingsAdministration.js';
import {
  AUTOMATION_CONVERSATION_ACTION_IDS_V1,
  AutomationConversationActionInputSchemasV1,
  AutomationConversationActionOutputSchemasV1,
  type AutomationConversationActionIdV1,
  AUTOMATION_EVENT_ACTION_IDS_V1,
  AutomationEventActionInputSchemasV1,
  AutomationEventActionOutputSchemasV1,
  type AutomationEventActionIdV1,
} from '../automations/automationActionSpecsV1.js';
import {
  PluginContributionLocalIdSchema,
} from '../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { CurrentUiContextSnapshotV1Schema } from '../plugins/ui/currentUiContext.js';
import {
  ActionInputFieldHintSchema,
  ActionInputOptionSchema,
  ActionInputOptionValueSchema,
  ActionInputWidgetSchema,
  readActionInputOptionValue,
  type ActionInputFieldHint,
  type ActionInputOption,
  type ActionInputOptionValue,
  type ActionInputWidget,
} from './actionInputHints.js';
import {
  MemorySearchQueryV1Schema,
  MemorySearchScopeSchema,
  MemoryDocumentSearchCoverageV1Schema,
  MemorySearchResultHitV1Schema,
  MemorySearchResultV1Schema,
} from '../memory/memorySearch.js';
import { MemoryWindowV1Schema, MemoryWindowRequestV1Schema } from '../memory/memoryWindow.js';
import { MemorySettingsV1Schema } from '../memory/memorySettings.js';
import { MemoryStatusV1Schema } from '../memory/memoryStatus.js';
import {
  ApprovalRequestCreatedBySchema,
  ApprovalRequestOriginV1Schema,
  ApprovalRequestStatusSchema,
  ApprovalRequestV2StatusSchema,
} from '../approvals/approvalRequestV1.js';
import {
  PromptAssetInstallModeV1Schema,
  PromptAssetScopeV1Schema,
} from '../prompts/library/promptAssetsV1.js';
import {
  DaemonFilesystemListDirectoryRequestSchema,
} from '../machines/fileBrowser.js';
import { BackendTargetKeySchema } from '../backends/targets/backendTargetRef.js';
import { BackendTargetKeyV2Schema, BackendTargetRefV2Schema } from '../backends/targets/backendTargetRefV2.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../connect/connectedServiceBindings.js';
import { AgentModelsProbeObservationSchema, AgentSessionModesProbeObservationSchema, AgentConfigOptionsProbeObservationSchema } from '../capabilities/agentProbeObservation.js';
import { ScmDiffSummaryModelCatalogObservationV1Schema } from './settings/scmDiffSummarySettings.js';
import { normalizeConnectedServiceSelectionInput } from '../connect/normalizeConnectedServiceSelectionInput.js';
import { ExecutionRunListRequestSchema } from '../execution/runs/listRequest.js';
import { ExecutionRunCancelTurnRequestSchema, ExecutionRunCancelTurnResponseSchema } from '../execution/runs/cancelTurn.js';
import {
  ExecutionRunGetResponseSchema,
  ExecutionRunListResponseSchema,
  ExecutionRunSendResponseSchema,
  ExecutionRunStartResponseSchema,
  ExecutionRunStopResponseSchema,
  ExecutionRunWaitResultSchema,
} from '../execution/runs/responseSchemas.js';
import {
  ExecutionRunTurnStreamCancelResponseSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
} from '../execution/runs/streaming.js';
import { ExecutionRunTurnStreamReadRequestSchema } from '../execution/runs/runPrimitives.js';
import {
  ActionDiscoveryDefinitionSummaryV1Schema,
  ActionDiscoveryDefinitionV1Schema,
} from './actionDefinitionV1.js';
import {
  ExecutionRunStartRequestBaseSchema,
  ExecutionRunStartRequestSchema,
  ExecutionRunTeamCredentialSessionBindingConsentV1Schema,
  refineExecutionRunStartRequest,
} from '../execution/runs/startRequest.js';
import { ExecutionRunResultContractV1Schema } from '../execution/runs/resultContractV1.js';
import { SessionMcpSelectionV1Schema } from '../mcp/servers/sessionSelectionV1.js';
import { SessionConnectedServiceAuthSwitchRpcParamsSchema } from '../connect/sessionConnectedServiceAuthSwitch.js';
import { AcpConfigOptionOverridesV1Schema } from '../sessions/metadata/metadataOverridesV1.js';
import { RuntimeDescriptorV1Schema } from '../sessions/metadata/runtimeDescriptorV1.js';
import { SecretReferenceOverlayV1Schema } from '../profiles/secretReferenceOverlayV1.js';
import {
  SessionSpawnNewInputV2Schema,
  SessionSpawnNewInputV2BaseSchema,
} from '../sessions/creation/sessionSpawnNewInputV2.js';
import { refineSessionDirectoryIntentCheckoutV1 } from '../sessions/creation/sessionDirectoryIntentV1.js';
import { SessionSpawnNewResultV1Schema } from '../sessions/creation/sessionSpawnNewResultV1.js';
import { AGENT_PERMISSION_INTENTS_V1 } from '../runtime/permissionIntentV1.js';
import { SessionCreationKeyV1Schema } from '../sessions/creation/sessionCreationIdentityV1.js';
import {
  PluginSessionInputIdempotencyKeyV1Schema,
  PluginSessionUserTextAuthoredFieldSchemasV1,
  requireSessionInputContent,
  SessionMessageSendResultV1Schema,
} from '../sessions/messages/sessionInputAdmission.js';
import { ExternalShareableTranscriptPageV1Schema } from '../sessions/messages/sessionExternalShareableTranscriptV1.js';
import { PendingLocalIdSchema } from '../sessions/pending/pendingLocalId.js';
import { SessionMessageExplicitReplyV1Schema, SessionMessageReplyMutationResultV1Schema } from '../sessions/messages/sessionMessageReplyV1.js';
import { AutonomousExchangeObservedRevisionV1Schema,
  AutonomousExchangeStatusV1Schema } from '../sessions/messages/autonomousExchangeV1.js';
import { PendingRequestedActionV1Schema, SessionPendingActionSetInputV1Schema, SessionPendingActionSetResultV1Schema, PendingResetStartSetInputV1Schema, PendingResetStartCancelInputV1Schema, PendingResetStartSetResultV1Schema, PendingResetStartCancelResultV1Schema } from '../sessions/pending/pendingRequestedActionV1.js';
import {
  SessionPermissionRemoteGrantRevokeInputV1Schema,
  SessionPermissionRemoteGrantRevokeOutputV1Schema,
  SessionPermissionRemoteGrantsListInputV1Schema,
  SessionPermissionRemoteGrantsListOutputV1Schema,
  SessionPermissionRemotePendingListInputV1Schema,
  SessionPermissionRemotePendingListOutputV1Schema,
  SessionPermissionRemoteRespondInputV1Schema,
  SessionPermissionRemoteRespondOutputV1Schema,
  SessionUserActionRemoteAnswerInputV1Schema,
  SessionUserActionRemoteAnswerOutputV1Schema,
} from '../sessions/permissions/v1.js';
import { ProviderConnectionIdSchema } from '../providers/ids.js';
import {
  SpawnConfigOptionValueSchema,
  findSpawnConfigOptionAliasConflicts,
} from './sessionSpawnConfigOptions.js';
import {
  EXECUTION_RUN_ACTION_PERMISSION_INPUTS,
  EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
  ExecutionRunActionPermissionModeSchema,
} from './executionRunActionPermissionMode.js';
import {
  SESSION_PERMISSION_INTENT_INPUTS,
  SessionPermissionModeInputSchema,
} from '../sessions/metadata/sessionPermissionModes.js';
import { SessionFollowActionInputSchemasV1, SessionFollowActionOutputSchemasV1 } from '../sessions/follow/actions.js';
import {
  VoiceTrackedSessionAddressV1Schema,
  VoiceTrackedTargetsActionResultV1Schema,
} from '../sessions/follow/voiceTrackedTargetsCompatibilityV1.js';
import { SESSION_FOLLOW_HTTP_PATHS_V1 } from '../sessions/follow/api.js';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '../sessions/follow/sessionFollowSourcesApi.js';
import { DELIVERY_MUTE_HTTP_PATHS_V1, FollowReceiverRefV1Schema } from '../sessions/follow/sessionDeliveryMuteV1.js';
import { DISCUSSION_HTTP_PATHS_V1 } from '../discussions/api.js';
import { SessionWorkStateStatusV1Schema } from '../sessions/work/state/sessionWorkStateV1.js';
import { StructuredQuestionAnswersV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import {
  SessionUsageLimitCheckNowRequestV1Schema,
  SessionUsageLimitConsumeResetCreditRequestV1Schema,
  SessionUsageLimitWaitResumeCancelRequestV1Schema,
  SessionUsageLimitWaitResumeEnableRequestV1Schema,
} from '../sessions/work/state/sessionWorkStateRpc.js';
import {
  ExternalSessionAttachRequestSchema,
  ExternalSessionAttachResponseSchema,
  ExternalSessionBackgroundFollowActionInputV1Schema,
  ExternalSessionBackgroundFollowActionResultV1Schema,
  ExternalSessionDetachRequestSchema,
  ExternalSessionDetachResponseSchema,
  ExternalSessionFollowPolicySetRequestSchema,
  ExternalSessionFollowPolicySetResponseSchema,
  ExternalSessionLinkEnsureRequestSchema,
  ExternalSessionLinkEnsureResponseSchema,
  ExternalSessionCandidateDeleteRequestSchema,
  ExternalSessionCandidateDeleteResponseSchema,
  ExternalSessionsCandidatesListRequestSchema,
  ExternalSessionsCandidatesListResponseSchema,
  ExternalSessionsSourceSchema,
  ExternalSessionCandidateV1Schema,
  ExternalSessionStatusGetRequestSchema,
  ExternalSessionStatusGetResponseSchema,
  ExternalSessionStatusActionInputV1Schema,
  ExternalSessionStatusActionResultV1Schema,
  ExternalSessionTranscriptPageRequestSchema,
  ExternalSessionTranscriptPageResponseSchema,
  ExternalSessionTranscriptReadAfterRequestSchema,
  ExternalSessionTranscriptReadAfterResponseSchema,
  ExternalSessionViewerFollowActionInputV1Schema,
  ExternalSessionViewerFollowActionResultV1Schema,
  ExternalSessionViewerUnfollowActionInputV1Schema,
  ExternalSessionViewerUnfollowActionResultV1Schema,
} from '../sessions/external/daemonRpcV1.js';
import {
  ExternalSessionTranscriptRefreshReadAfterRequestV1Schema,
  ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
} from '../sessions/external/secureRefreshV1.js';
import {
  SourceControlCloneProtocolSchema,
  type SourceControlCloneProtocol,
} from '../scm/repositoryClone.js';
import {
  SkillCatalogItemV1Schema,
  SkillCatalogV1Schema,
} from '../runtime/catalog/skills.js';
import {
  VendorPluginCatalogItemV1Schema,
  VendorPluginCatalogV1Schema,
} from '../runtime/catalog/vendorPlugins.js';
import {
  ExternalSessionTakeoverInputV1Schema,
  ExternalSessionTakeoverResultV1Schema,
} from '../sessions/external/takeoverV1.js';
import {
  ExternalSessionMaterializeStartInputV1Schema,
  ExternalSessionMaterializeActionInputV1Schema,
  ExternalSessionMaterializeActionResultV1Schema,
  ExternalSessionOperationActionResultV1Schema,
  ExternalSessionOperationActionResponseV1Schema,
  ExternalSessionOperationCancelInputV1Schema,
  ExternalSessionOperationDiscardInputV1Schema,
  ExternalSessionOperationResumeInputV1Schema,
  ExternalSessionOperationRetryInputV1Schema,
  ExternalSessionOperationStatusInputV1Schema,
  ExternalSessionOperationTransportReferenceV1Schema,
  ExternalSessionTakeoverStartInputV1Schema,
  projectExternalSessionMaterializeActionResultV1,
  projectExternalSessionOperationActionResultV1,
} from '../sessions/external/operationActionSchemasV1.js';
import {
  PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT,
  PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS,
  PluginSessionHookInstallActionInputV1Schema,
  PluginSessionHookInstallInputV1Schema,
  PluginSessionHookInstallResponseV1Schema,
  PluginSessionHookInstallationMutationActionInputV1Schema,
  PluginSessionHookInstallationMutationInputV1Schema,
  PluginSessionHookStatusActionInputV1Schema,
  PluginSessionHookStatusInputV1Schema,
  PluginSessionHookStatusResponseV1Schema,
  PluginSessionHookToggleResponseV1Schema,
  PluginSessionHookUninstallResponseV1Schema,
} from '../sessions/external/hookManagementV1.js';
import {
  SubagentLifecycleDetailV1Schema,
  SubagentRefInputV1Schema,
  SubagentRefV1Schema,
  SubagentStatusV1Schema,
} from '../sessions/subagents/subagentRefV1.js';
import { SessionRollbackTargetSchema } from '../sessions/rollback.js';
import {
  CheckpointCodeRollbackRequestSchema,
  CheckpointCodeRollbackActionRequestSchema,
  CheckpointCodeRollbackResultSchema,
} from '../sessions/control/rollback/checkpointCodeRollback.js';
import {
  SessionCheckpointRequestV1Schema,
  SessionCheckpointResultV1Schema,
  SessionRestoreRequestV1Schema,
  SessionRestoreResultV1Schema,
} from '../sessions/control/checkpoints/v1.js';
import {
  SessionTerminalComposerClearRequestV1Schema,
  SessionTerminalComposerClearResultV1Schema,
} from '../sessions/control/terminalComposerClearV1.js';
import {
  SessionPendingInputInterruptAndRunRequestV1Schema,
  SessionPendingInputInterruptAndRunResultV1Schema,
} from '../sessions/control/pendingInputInterruptAndRunV1.js';
import {
  SessionHandoffAbortRequestSchema,
  SessionHandoffCommitRequestSchema,
  SessionHandoffPrepareTargetResultGetRequestSchema,
  SessionHandoffPrepareTargetResultGetResponseSchema,
  SessionHandoffPrepareTargetRequestSchema,
  SessionHandoffPrepareTargetResumeRequestSchema,
  SessionHandoffPrepareTargetResumeResponseSchema,
  SessionHandoffStatusGetRequestSchema,
  SessionHandoffActionResultV1Schema,
  refineSessionHandoffStateTransferV3,
} from '../sessions/control/handoff/handoffSchemas.js';
import { SessionHandoffStateTransferSchema } from '../sessions/control/handoff/handoffTypes.js';
import { HandoffTargetReplacementApprovalV1Schema } from '../sessions/control/handoff/handoffTargetReplacementApprovalV1.js';
import {
  WorkspaceSyncConflictResolveActionInputV1Schema,
  WorkspaceSyncConflictsListActionInputV1Schema,
  WorkspaceSyncConflictInspectActionInputV1Schema,
  WorkspaceSyncRelationshipsListActionInputV1Schema,
  WorkspaceSyncRelationshipsListActionOutputV1Schema,
  WorkspaceSyncRelationshipCreateActionInputV1Schema,
  WorkspaceSyncRelationshipCreateResultV1Schema,
  WorkspaceSyncRelationshipDisableActionInputV1Schema,
  WorkspaceSyncRelationshipDisableActionOutputV1Schema,
  WorkspaceSyncRelationshipEnableActionInputV1Schema,
  WorkspaceSyncRelationshipEnableActionOutputV1Schema,
  WorkspaceSyncRelationshipFlushActionInputV1Schema,
  WorkspaceSyncRelationshipFlushActionOutputV1Schema,
  WorkspaceSyncRelationshipTerminateActionInputV1Schema,
  WorkspaceSyncRelationshipTerminateActionOutputV1Schema,
  HandoffWorkspaceActionV1Schema,
  WorkspaceSyncConflictResolutionResultV1Schema,
  computeWorkspaceSyncPolicyDigest,
} from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { SessionContinueWithReplayRpcParamsSchema } from '../sessions/continueWithReplay.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from '../rpc/methods.js';
import { resolveActionBackendTargetSelection } from './resolveActionBackendTargetSelection.js';
import {
  RUNTIME_ACTION_INPUT_SCHEMAS,
  RUNTIME_ACTION_OUTPUT_SCHEMAS,
  RUNTIME_ACTION_SPECS,
} from './specs/index.js';
import { HOME_GOVERNANCE_ACTION_SPECS } from './specs/home.js';
import { ACCOUNT_PROFILE_ACTION_SPECS_V1 } from './specs/accountProfile.js';
import { HOME_IDENTITY_ACTION_SPECS } from './specs/homeIdentity.js';
import { SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS } from './specs/sessionOrganization.js';
import { SCOPE_ACTION_SPECS } from './specs/scope.js';
import { DIAGNOSTICS_ACTION_SPECS } from './specs/diagnostics.js';
import { HOME_HUB_LAYOUT_ACTION_SPECS } from './specs/homeHub.js';
import { PROJECT_SOURCE_ACTION_SPECS_V1 } from './specs/projectSources.js';
import { WIDGET_INSTANCE_ACTION_SPECS_V1, WIDGET_DEFINITION_ACTION_SPECS_V1, WIDGET_SNAPSHOT_ACTION_SPECS_V1, WIDGET_LAYOUT_FRAGMENT_ACTION_SPECS_V1 } from './specs/widgets.js';
import type { WidgetInstanceActionIdV1, WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1 } from '../widgets/actionsV1.js';
import type { WidgetDefinitionActionIdV1, WidgetDefinitionActionInputSchemasV1, WidgetDefinitionActionOutputSchemasV1 } from '../widgets/definitionActionsV1.js';
import type { WidgetLayoutFragmentActionIdV1, WidgetLayoutFragmentActionInputSchemasV1, WidgetLayoutFragmentActionOutputSchemasV1 } from '../widgets/fragmentActionsV1.js';
import { MACHINE_CONNECTION_ACTION_SPECS } from './specs/machineConnection.js';
import { LOCAL_DAEMON_SERVICE_ACTION_SPECS } from './specs/localDaemonService.js';
import { MACHINE_TERMINAL_ACTION_SPECS, MACHINE_TERMINAL_ACTION_IDS, MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS,
  MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS, type MachineTerminalActionId } from './specs/machineTerminal.js';
import { MACHINE_ACCESS_ACTION_SPECS } from './specs/machineAccess.js';
import { MACHINE_VITALS_ACTION_SPECS } from './specs/machineVitals.js';
import { MACHINE_PROCESSES_ACTION_SPECS } from './specs/machineProcesses.js';
import { MACHINE_STORAGE_ACTION_SPECS } from './specs/storage.js';
import { MACHINE_RESOURCES_ACTION_SPECS } from './specs/machineResources.js';
import { MACHINE_GUARD_ACTION_SPECS } from './specs/machineGuard.js';
import { TEAM_ACTION_SPECS } from './specs/teams.js';
import { SHARED_SAVED_SECRET_ACTION_SPECS } from './specs/sharedSavedSecrets.js';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_SPECS } from './specs/connectedServices.js';
import { USAGE_SOURCE_ACTION_SPECS } from './specs/usageSources.js';
import { USAGE_SOURCE_ACTION_INPUT_SCHEMAS, USAGE_SOURCE_ACTION_OUTPUT_SCHEMAS, type UsageSourceActionId } from '../usage/usageSources.js';
import { USAGE_ACTION_SPECS } from './specs/usage.js';
import { USAGE_COACH_ACTION_SPECS } from './specs/usageCoach.js';
import {
  TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1,
  TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1,
  type TeamCredentialActionIdV1,
} from '../teams/credentials/actionsV1.js';
import { TeamCredentialProviderModelSelectionV1Schema } from '../teams/credentials/resourceV1.js';
import {
  SHARED_SAVED_SECRET_ACTION_IDS_V1,
  SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1,
  SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1,
  type SharedSavedSecretActionIdV1,
} from '../account/settings/savedSecretResourceActionsV1.js';
import {
  MANAGED_IDENTITY_PROVIDER_ACTION_SPECS,
  type ManagedIdentityProviderRequiredAuthority,
} from './specs/identityProviders.js';
import { redactObservationInputPaths } from './specs/observationRedaction.js';
import {
  SESSION_ARCHIVE_CLI_PROJECTION,
  SESSION_MODEL_SET_CLI_PROJECTION,
  SESSION_PERMISSION_MODE_SET_CLI_PROJECTION,
  SessionPermissionModeSetApplyTimingSchema,
  SESSION_STATUS_GET_CLI_PROJECTION,
  SESSION_STOP_CLI_PROJECTION,
  SESSION_TITLE_SET_CLI_PROJECTION,
  SESSION_UNARCHIVE_CLI_PROJECTION,
  SESSION_WAIT_IDLE_CLI_PROJECTION,
} from './specs/sessionCommandCli.js';
import { SESSION_SEND_CLI_PROJECTION } from './specs/sessionSendCli.js';
import { SESSION_LIST_CLI_PROJECTION } from './specs/sessionListCli.js';
import {
  EXECUTION_RUN_GET_CLI_PROJECTION,
  EXECUTION_RUN_LIST_CLI_PROJECTION,
  EXECUTION_RUN_START_CLI_PROJECTION,
  EXECUTION_RUN_STOP_CLI_PROJECTION,
  EXECUTION_RUN_STREAM_CANCEL_CLI_PROJECTION,
  EXECUTION_RUN_STREAM_READ_CLI_PROJECTION,
  EXECUTION_RUN_STREAM_START_CLI_PROJECTION,
  EXECUTION_RUN_WAIT_CLI_PROJECTION,
} from './specs/executionRunCli.js';
import {
  SESSION_BOARD_GET_CLI_PROJECTION,
  SESSION_BOARD_ITEM_REMOVE_CLI_PROJECTION,
  SESSION_BOARD_ITEM_UPSERT_CLI_PROJECTION,
  SESSION_BOARD_LAYOUT_UPDATE_CLI_PROJECTION,
  SESSION_VISUAL_DESTINATION_HINT,
} from './specs/sessionBoardCli.js';
import { SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1 } from '../sessions/board/actionIds.js';
import {
  DISCUSSION_ARCHIVE_CLI_PROJECTION,
  DISCUSSION_CREATE_CLI_PROJECTION,
  DISCUSSION_GET_CLI_PROJECTION,
  DISCUSSION_LIST_CLI_PROJECTION,
  DISCUSSION_POST_CLI_PROJECTION,
  DISCUSSION_READ_CLI_PROJECTION,
  DISCUSSION_READ_STATE_SET_CLI_PROJECTION,
  DISCUSSION_RENAME_CLI_PROJECTION,
  DISCUSSION_RESTORE_CLI_PROJECTION,
} from './specs/discussionCli.js';
import { SESSION_READ_STATE_SET_CLI_PROJECTION } from './specs/sessionReadStateCli.js';
import {
  SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1,
  SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1,
} from '../sessions/readState/actions.js';
import { SESSION_READ_STATE_HTTP_PATHS_V1 } from '../sessions/readState/api.js';
import {
  SESSION_ATTENTION_STANDING_HTTP_PATH_V1,
  SessionAttentionSetInputV1Schema,
  SessionAttentionSetResultV1Schema,
} from '../sessions/organization/attentionAction.js';
import {
  MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1,
  MANAGED_IDENTITY_PROVIDER_ACTION_OUTPUT_SCHEMAS_V1,
  type ManagedIdentityProviderActionIdV1,
} from '../identity/providers.js';
import {
  MANAGED_GITHUB_APP_ACTION_IDS_V1,
  MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1,
  MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1,
  MANAGED_GITHUB_APP_ACTION_PATHS_V1,
  type ManagedGitHubAppActionIdV1,
} from '../identity/githubApps.js';
import { ActionApprovalSchema, ActionApprovalPolicySchema, resolveActionApprovalFlow, type ActionApproval } from './actionApprovalMetadata.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { WidgetSurfaceRefV1Schema } from '../widgets/widgetInstanceV1.js';
import { ActionInvokeInputSchema } from './actionInvokeInput.js';
import { isSourceQualifiedLocalServicePreviewActionInput } from './specs/localServices.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
export const SessionTargetsResolveInputV1Schema: z.ZodMiniType<
  { target: SessionTargetV1; actionId: string },
  { target: SessionTargetV1; actionId: string }
> = lazyZodSchema(() => z.strictObject({
  target: SessionTargetV1Schema,
  actionId: z.string().check(z.refine(id => ActionIdSchema.safeParse(id).success || parseQualifiedPluginActionId(id) !== null)),
}));
import {
  ActionContextualDefaultsSchema,
  type ActionContextualDefaults,
} from './contextualDefaults.js';

export {
  ActionContextualDefaultsSchema,
  type ActionContextualDefaults,
} from './contextualDefaults.js';

export {
  RuntimeActionHostEffectClassSchema,
  resolveRuntimeActionHostEffectClass,
  type RuntimeActionHostEffectClass,
} from './safety.js';

export {
  ActionApprovalFlowSchema,
  ActionApprovalResultSchema,
  ActionApprovalSchema,
  resolveActionApprovalFlow,
  type ActionApproval,
  type ActionApprovalFlow,
  type ActionApprovalResult,
} from './actionApprovalMetadata.js';

const ZodSchemaLike = lazyZodSchema(() => z.custom<z.ZodMiniType>((value) => {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  return typeof v.safeParse === 'function' && typeof v.parse === 'function';
}, { message: 'Expected a Zod schema' }));

export type ActionSurfaceBindingCaller = ActionCaller;

export type ActionSurfaceBindingContext = Readonly<{
  actionId: ActionId;
  surface: 'api' | 'rpc' | 'plugin';
  caller: ActionSurfaceBindingCaller;
  defaultSessionId?: string | null;
  serverId?: string | null;
  externalActionTarget?: ExternalActionTargetV1;
  signal?: AbortSignal;
  input?: unknown;
}>;

export type ActionSurfaceBindingTransform = (
  value: unknown,
  context: ActionSurfaceBindingContext,
) => unknown | Promise<unknown>;

const ActionSurfaceBindingTransformSchema = lazyZodSchema(() => z.custom<ActionSurfaceBindingTransform>(
  (value) => typeof value === 'function',
  { message: 'Expected an Action surface binding transform' },
));

export const ActionSpecSurfaceBindingsSchema = lazyZodSchema(() => z.strictObject({
  api: z.optional(z.strictObject({
    inputSchema: ZodSchemaLike,
    bindInput: z.optional(ActionSurfaceBindingTransformSchema),
    outputSchema: z.optional(ZodSchemaLike),
    inputHints: z.optional(ActionInputHintsSchema),
  })),
  rpc: z.optional(z.strictObject({
    inputSchema: ZodSchemaLike,
    decodeInput: ActionSurfaceBindingTransformSchema,
    outputSchema: ZodSchemaLike,
    encodeOutput: ActionSurfaceBindingTransformSchema,
  })),
  plugin: z.optional(z.strictObject({
    inputSchema: z.optional(ZodSchemaLike),
    bindInput: z.optional(ActionSurfaceBindingTransformSchema),
    outputSchema: z.optional(ZodSchemaLike),
    projectOutput: z.optional(ActionSurfaceBindingTransformSchema),
  })),
}));
export type ActionSpecSurfaceBindings = z.infer<typeof ActionSpecSurfaceBindingsSchema>;

const ActionPluginCallerAdministrativeSelectorSchema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
}));

/**
 * A host Action's explicit authority contract when it is callable by a
 * plugin. `caller` requires a current host-stamped plugin caller at the
 * canonical executor: the host proves the call really came from the claimed
 * plugin materialization. Further identity projection occurs only where an
 * incumbent domain owner has caller-dependent authorization — for example the
 * Account-scoped Automation owner, which fences its own reads by Account and
 * current materialization rather than by which plugin is asking — and it never
 * grants authority over another plugin. `self_or_inspector_admin` is reserved
 * for the one plugin-targeted host Action and makes its exceptional Inspector
 * administration visible at the Action declaration owner.
 */
export const ActionPluginCallerPolicySchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('caller'),
  }),
  z.strictObject({
    kind: z.literal('self_or_inspector_admin'),
    targetPluginIdField: z.literal('pluginId'),
    administrativeCallers: z.array(ActionPluginCallerAdministrativeSelectorSchema).check(z.minLength(1)),
  }),
]));
export type ActionPluginCallerPolicy = z.infer<typeof ActionPluginCallerPolicySchema>;

export { ActionSafetySchema, type ActionSafety } from './safety.js';
export {
  ActionExecutionPlacementSchema,
  ActionInputHintsSchema,
  ActionRequiredAuthoritySchema,
  ActionSurfaceSchema,
  ActionToolExposureModeSchema,
  ActionToolExposureSchema,
  ActionToolExposureSurfaceSchema,
  type ActionExecutionPlacement,
  type ActionInputHints,
  type ActionRequiredAuthority,
  type ActionSurfaces,
  type ActionToolExposure,
  type ActionToolExposureMode,
  type ActionToolExposureSurface,
} from './metadata.js';
export {
  ActionInputFieldHintSchema,
  ActionInputOptionSchema,
  ActionInputOptionValueSchema,
  ActionInputWidgetSchema,
  readActionInputOptionValue,
  type ActionInputFieldHint,
  type ActionInputOption,
  type ActionInputOptionValue,
  type ActionInputWidget,
} from './actionInputHints.js';

/** What a person approving a Session visual will see appear, and where. */
function describeSessionVisualApprovalSummary(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const item = value.item && typeof value.item === 'object' ? value.item as Record<string, unknown> : null;
  const title = typeof item?.title === 'string' && item.title.trim() ? `“${item.title.trim()}”` : 'a visual';
  const where = value.destination === 'board' ? 'on the Board'
    : value.destination === 'both' ? 'in the conversation and on the Board' : 'in the conversation';
  if (value.copySource !== undefined && value.copySource !== null) return `Copy a visual into this Session, ${where}.`;
  return `${typeof value.expectedItemRevision === 'string' ? 'Update' : 'Show'} ${title} ${where}.`;
}

/** Local declaration only; domain routes retain wire validation and authorization. */
export const ActionServerTransportSchema = lazyZodSchema(() => z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** Existing resource routes may validate the addressed identity again in the mutation body. */
  preservePathFieldsInBody: z.optional(z.literal(true)),
  path: z.string().check(z.startsWith('/'), z.refine((path) => !path.startsWith('//'), {
    message: 'Action transport must be a relative Home path',
  })),
}));
export type ActionServerTransport = z.infer<typeof ActionServerTransportSchema>;

export const ActionSpecSchema = lazyZodSchema(() => z.looseObject({
  id: ActionIdSchema,
  title: z.string().check(z.minLength(1)),
  /** Presentation only: a localized verb; omission uses the host's generic approval label. */
  confirmVerb: z.optional(PluginLocalizedStringV2Schema),
  /** The effect cannot be undone; independent of safety and approval policy. */
  irreversible: z.optional(z.literal(true)),
  description: z.optional(z.string().check(z.minLength(1))),
  safety: ActionSafetySchema,
  safetyForInput: z.optional(z.custom<(input: unknown) => z.infer<typeof ActionSafetySchema> | undefined>((value) => typeof value === 'function')),
  approval: ActionApprovalSchema,
  approvalPolicy: z.optional(ActionApprovalPolicySchema),
  // UI placements where the action can appear when the relevant surface is enabled.
  placements: z._default(z.array(ActionUiPlacementSchema), []),
  // Optional stable slash command token for UI slash-command placement.
  slash: z.optional(z.looseObject({
    tokens: z.array(z.string().check(z.minLength(1))),
  })),
  bindings: z.optional(z.looseObject({
    // Tool name the voice client is allowed to expose (surface.voice).
    voiceClientToolName: z.optional(z.string().check(z.minLength(1))),
    // Optional direct MCP tool name; generic action_execute invokes by Action id.
    mcpToolName: z.optional(z.string().check(z.minLength(1))),
    // Optional generated SDK method-name override. Most public Actions derive
    // their path from the canonical Action id; overrides only resolve a real
    // namespace collision.
    sdkMethod: z.optional(z.string().check(z.minLength(1))),
    // RPC method exposed when surface.rpc is true.
    rpcMethod: z.optional(z.string().check(z.minLength(1))),
    // Wire aliases accepted alongside the canonical method until their owning compatibility packet removes them.
    rpcMethodAliases: z.optional(z.array(z.string().check(z.minLength(1)))),
  })),
  surfaceBindings: z.optional(ActionSpecSurfaceBindingsSchema),
  sessionTarget: z.optional(ActionSessionTargetDeclarationV1Schema),
  outputSchema: z.optional(ZodSchemaLike),
  /** The deciding person's reduced operands; never an approval policy. */
  approvalNarrowing: z.optional(z.strictObject({
    narrow: z.custom<ApprovalNarrowing['narrow']>((value) => typeof value === 'function'),
  })),
  /** Host-private launch/terminal projection. Only its schema and awaits marker are frozen. */
  completion: z.optional(z.discriminatedUnion('awaits', [
    z.strictObject({
      awaits: z.literal('execution_runs'),
      terminalOutputSchema: ZodSchemaLike,
      launched: z.custom<Extract<ActionCompletionDeclaration, { awaits: 'execution_runs' }>['launched']>(
        (value) => typeof value === 'function',
      ),
      terminal: z.custom<Extract<ActionCompletionDeclaration, { awaits: 'execution_runs' }>['terminal']>(
        (value) => typeof value === 'function',
      ),
    }),
    z.strictObject({
      awaits: z.literal('action_operations'),
      immediateResultSchema: z.optional(ZodSchemaLike),
      terminalOutputSchema: ZodSchemaLike,
      launched: z.custom<Extract<ActionCompletionDeclaration, { awaits: 'action_operations' }>['launched']>(
        (value) => typeof value === 'function',
      ),
      terminal: z.custom<Extract<ActionCompletionDeclaration, { awaits: 'action_operations' }>['terminal']>(
        (value) => typeof value === 'function',
      ),
    }),
  ])),
  /** Host-private input projection for observers; secrets must never enter Action history. */
  projectObservationInput: z.optional(z.custom<(value: unknown) => unknown>(
    (value) => typeof value === 'function',
  )),
  /** Domain-owned, value-free human description of the exact effect under review. */
  approvalPresentation: z.optional(z.strictObject({
    /**
     * The presenting app may pass what only it knows (a Machine's home, to read paths `~/work/app`); without it the
     * summary still reads, so every surface (agent, CLI, MCP) gets the same contract.
     */
    summary: z.custom<(input: unknown, context?: ApprovalPresentationContext) => string | null>((value) => typeof value === 'function'),
    /**
     * Input paths that identify or correlate the request (command, view and session ids, fixed discriminators,
     * client plumbing) rather than say what it does. Approval reads them under Technical details; a path
     * `field.member` marks that direct member of a structured value.
     */
    technicalInputPaths: z.optional(z.readonly(z.array(z.string().check(z.minLength(1))))),
    /** Private approval review can disclose operands that must stay out of shared Action observations. */
    projectInput: z.optional(z.custom<(input: unknown) => unknown>((value) => typeof value === 'function')),
    /** Admits private review/history operands when they intentionally differ from executable input. */
    inputSchema: z.optional(ZodSchemaLike),
    /** Private review field labels may differ from the executable authoring form. */
    inputHints: z.optional(ActionInputHintsSchema),
    /** Private history may retain this declared review after replay; live-only custody still wins. */
    retainInputOnSettlement: z.optional(z.literal(true)),
  })),
  /** Host-private output projection for observers; never changes the intentional caller result. */
  projectObservationOutput: z.optional(z.custom<(value: unknown) => unknown>(
    (value) => typeof value === 'function',
  )),
  /**
   * Host-private custody rule for one-shot results that must never become
   * durable Approval Artifact result state. A present-user UI invocation keeps
   * the existing blocking waiter alive and receives the result directly; if
   * that live invocation is lost, the result is intentionally unrecoverable.
   */
  approvalResultCustody: z.optional(z.literal('live_only')),
  /** Successful self-retirement permits only a live, value-free receipt when this Account can no longer settle history. */
  accountAuthorityRetirementStatuses: z.optional(z.readonly(z.array(z.string().check(z.minLength(1))).check(z.minLength(1)))),
  /**
   * The input-side sibling of `approvalResultCustody`. Host-private custody rule
   * for secret-bearing input — credentials, verification bearers, reauthentication
   * proofs — that must never become durable Approval Artifact state. The admitted
   * invocation stays the blocking waiter and keeps the raw input; the Artifact
   * carries only this Action's own `projectObservationInput` projection, so a
   * replay that no longer has the live invocation fails closed instead of
   * recovering the secret from durable approval state.
   */
  approvalInputCustody: z.optional(z.literal('live_only')),
  /** Domain-owned disclosure of this exact operation to its Session participants. */
  projectSessionConfirmation: z.optional(z.custom<(
    input: unknown,
    context: Readonly<{ sessionId: string }>,
  ) => unknown | null>((value) => typeof value === 'function')),
  execution: z.optional(z.looseObject({
      handler: z.optional(z.string().check(z.minLength(1))),
      transport: z.optional(z.enum(['host', 'plugin', 'rpc', 'api'])),
    })),
  sideEffectClass: z.optional(z.enum(['none', 'read', 'write', 'external', 'danger'])),
  /** This Action mutates workspace files or repository state. Coordination writes do not. */
  workspaceWrite: z.optional(z.literal(true)),
  examples: z.optional(z.looseObject({
      voice: z.optional(z.looseObject({
          argsExample: z.optional(z.string().check(z.minLength(1))),
        })),
      mcp: z.optional(z.looseObject({
          argsExample: z.optional(z.string().check(z.minLength(1))),
        })),
      sdk: z.optional(z.looseObject({
          codeExample: z.optional(z.string().check(z.minLength(1))),
        })),
    })),
  prompting: z.optional(ActionPromptingSchema),
  toolExposure: z.optional(ActionToolExposureSchema),
  contextualDefaults: z.optional(ActionContextualDefaultsSchema),
  operation: z.optional(ActionOperationDeclarationV1Schema),
  /** Host-local exact-request policy; intentionally omitted from serialized Action discovery. */
  operationReentry: z.optional(ActionOperationReentryPolicyV1Schema),
  /** Host-owned admission floor; public callers never supply this in Action input. */
  requiredAuthority: z.optional(ActionRequiredAuthoritySchema),
  /** Host-owned routing placement; public callers never supply this in Action input. */
  executionPlacement: z.optional(ActionExecutionPlacementSchema),
  /** Host-only selector for an admitted input whose owner varies; never serialized as caller authority. */
  executionPlacementForInput: z.optional(z.custom<(input: unknown) => ActionExecutionPlacement>((value) => typeof value === 'function')),
  /** Placements producible by this input selector; ingress cannot open encrypted operands. */
  executionPlacements: z.optional(z.readonly(z.array(ActionExecutionPlacementSchema).check(z.minLength(1)))),
  /** Host ingress exceptions belong to the declaration, never consumer-maintained ID groups. */
  originalExecution: z.optional(z.strictObject({
    accountRoot: z.optional(z.enum(['allowed', 'separate'])),
    terminalRoot: z.optional(z.enum(['allowed', 'host'])),
    nativePurpose: z.optional(z.enum(['quota_read', 'session_board_write', 'pending_reset_start'])),
  })),
  /** Explicit host-stamped caller authority for a Plugin Action. */
  pluginCallerPolicy: z.optional(ActionPluginCallerPolicySchema),
  surfaces: ActionSurfaceSchema,
  inputSchema: ZodSchemaLike,
  inputHints: z.optional(ActionInputHintsSchema),
  /**
   * Friendly CLI command projection for this packaged binary. Intentionally
   * omitted by `serializeActionSpec`/`actionSpecToActionDefinitionV1`: it is not
   * a cross-version wire contract and its binder cannot be serialized.
   */
  cli: z.optional(ActionCliProjectionSchema),
  /** Not serialized; the bound domain adapter supplies encryption and Home identity. */
  serverTransport: z.optional(ActionServerTransportSchema),
}).check(z.superRefine((value, ctx) => {
  if (value.operationReentry && !value.operation) {
    ctx.addIssue({
      code: "custom",
      message: 'operationReentry requires a tracked operation declaration',
      path: ['operationReentry'],
    });
  }
  if ((value.placements?.length ?? 0) > 0 && !value.surfaces.ui) {
    ctx.addIssue({
      code: "custom",
      message: 'placements require surface.ui',
      path: ['surfaces', 'ui'],
    });
  }
  if (value.approvalResultCustody === 'live_only') {
    if (value.approval.result !== 'required') {
      ctx.addIssue({
        code: "custom",
        message: 'live-only approval custody requires a required result',
        path: ['approvalResultCustody'],
      });
    }
    if (!value.projectObservationOutput) {
      ctx.addIssue({
        code: "custom",
        message: 'live-only approval custody requires a safe observation projection',
        path: ['projectObservationOutput'],
      });
    }
  }
  if (value.approvalInputCustody === 'live_only') {
    if (resolveActionApprovalFlow(value.approval) !== 'blocking') {
      ctx.addIssue({
        code: "custom",
        message: 'live-only approval input custody requires a blocking approval flow',
        path: ['approvalInputCustody'],
      });
    }
    if (!value.projectObservationInput) {
      ctx.addIssue({
        code: "custom",
        message: 'live-only approval input custody requires a safe observation projection',
        path: ['projectObservationInput'],
      });
    }
  }
  if (value.surfaces.rpc && !value.bindings?.rpcMethod) {
    ctx.addIssue({
      code: "custom",
      message: 'surface.rpc requires bindings.rpcMethod',
      path: ['bindings', 'rpcMethod'],
    });
  }
  if (value.surfaces.mcp && !value.outputSchema) {
    ctx.addIssue({
      code: "custom",
      message: 'surface.mcp requires outputSchema',
      path: ['outputSchema'],
    });
  }
  if (value.surfaces.plugin && !value.outputSchema) {
    ctx.addIssue({
      code: "custom",
      message: 'surface.plugin requires outputSchema',
      path: ['outputSchema'],
    });
  }
  if (value.surfaces.plugin && value.inputSchema instanceof z.ZodMiniUnknown) {
    ctx.addIssue({
      code: "custom",
      message: 'surface.plugin requires a representable input schema',
      path: ['inputSchema'],
    });
  }
  if (value.surfaces.plugin && value.outputSchema instanceof z.ZodMiniUnknown) {
    ctx.addIssue({
      code: "custom",
      message: 'surface.plugin requires a representable output schema',
      path: ['outputSchema'],
    });
  }
  const nonSafePluginAction = value.surfaces.plugin && value.safety !== 'safe';
  if (nonSafePluginAction && !value.pluginCallerPolicy) {
    ctx.addIssue({
      code: "custom",
      message: 'non-safe surface.plugin requires pluginCallerPolicy',
      path: ['pluginCallerPolicy'],
    });
  }
  if (!value.surfaces.plugin && value.pluginCallerPolicy) {
    ctx.addIssue({
      code: "custom",
      message: 'pluginCallerPolicy requires a surface.plugin Action',
      path: ['pluginCallerPolicy'],
    });
  }
  if (value.surfaceBindings?.rpc && !value.surfaces.rpc) {
    ctx.addIssue({
      code: "custom",
      message: 'surfaceBindings.rpc requires surface.rpc',
      path: ['surfaceBindings', 'rpc'],
    });
  }
  if (value.surfaceBindings?.plugin && !value.surfaces.plugin) {
    ctx.addIssue({
      code: "custom",
      message: 'surfaceBindings.plugin requires surface.plugin',
      path: ['surfaceBindings', 'plugin'],
    });
  }
  if (value.cli && !value.surfaces.cli) {
    ctx.addIssue({
      code: "custom",
      message: 'cli requires surface.cli',
      path: ['surfaces', 'cli'],
    });
  }
  if (value.cli) {
    // Positionals name the effective CLI caller shape, which is the declared
    // caller schema when one exists and the canonical Action input otherwise.
    const callerShape = value.cli.inputSchema ?? value.inputSchema;
    const declaredFields = readActionSchemaTopLevelFieldNames(callerShape);
    if (declaredFields) {
      for (const [index, command] of value.cli.commands.entries()) {
        for (const [positionalIndex, positional] of (command.positionals ?? []).entries()) {
          if (!declaredFields.has(positional)) {
            ctx.addIssue({
              code: "custom",
              message: `cli positional "${positional}" is not a field of the effective CLI caller schema`,
              path: ['cli', 'commands', index, 'positionals', positionalIndex],
            });
          }
        }
        if (command.variadicPositional && !declaredFields.has(command.variadicPositional)) {
          ctx.addIssue({
            code: "custom",
            message: `cli variadic positional "${command.variadicPositional}" is not a field of the effective CLI caller schema`,
            path: ['cli', 'commands', index, 'variadicPositional'],
          });
        }
      }
      for (const [index, entry] of (value.cli.flagAliases ?? []).entries()) {
        if (!declaredFields.has(entry.path)) {
          ctx.addIssue({
            code: "custom",
            message: `cli flag alias target "${entry.path}" is not a field of the effective CLI caller schema`,
            path: ['cli', 'flagAliases', index, 'path'],
          });
        }
      }
    }
  }
  if (value.surfaceBindings?.plugin?.bindInput && !value.surfaceBindings.plugin.inputSchema) {
    ctx.addIssue({
      code: "custom",
      message: 'surfaceBindings.plugin.bindInput requires a caller input schema',
      path: ['surfaceBindings', 'plugin', 'inputSchema'],
    });
  }
})));

export type ActionSpec = z.infer<typeof ActionSpecSchema> & Readonly<{
  placements: readonly ActionUiPlacement[];
  requiredAuthority: ActionRequiredAuthority;
  executionPlacement: ActionExecutionPlacement;
}>;

/**
 * Evaluates the declaration-owned policy against host-stamped caller
 * provenance. Action input never manufactures, widens, or narrows caller
 * authority: it is read only to name the plugin the call *targets*, and the
 * target is then compared against the stamped caller.
 */
export function isPluginActionCallerPolicySatisfied(
  policy: ActionPluginCallerPolicy | undefined,
  input: unknown,
  caller: ActionCaller | undefined,
): boolean {
  if (!policy || caller?.kind !== 'plugin') return false;
  if (policy.kind === 'caller') return true;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;

  const targetPluginId = (input as Readonly<Record<string, unknown>>)[policy.targetPluginIdField];
  if (typeof targetPluginId !== 'string') return false;
  if (targetPluginId === caller.pluginId) return true;

  return policy.administrativeCallers.some((administrator) => (
    administrator.pluginId === caller.pluginId
    && administrator.contributionLocalId === caller.contributionLocalId
  ));
}

type ParsedActionSpec = z.infer<typeof ActionSpecSchema>;
export type ActionSpecWithoutApproval = Readonly<{
  id: ParsedActionSpec['id'];
  approval: ParsedActionSpec['approval'];
  approvalPolicy?: ParsedActionSpec['approvalPolicy'];
  title: ParsedActionSpec['title'];
  confirmVerb?: ParsedActionSpec['confirmVerb'];
  irreversible?: ParsedActionSpec['irreversible'];
  description?: ParsedActionSpec['description'];
  safety: ParsedActionSpec['safety'];
  safetyForInput?: ParsedActionSpec['safetyForInput'];
  placements: readonly ActionUiPlacement[];
  slash?: ParsedActionSpec['slash'];
  bindings?: ParsedActionSpec['bindings'];
  surfaceBindings?: ParsedActionSpec['surfaceBindings'];
  outputSchema?: ParsedActionSpec['outputSchema'];
  completion?: ParsedActionSpec['completion'];
  projectObservationInput?: ParsedActionSpec['projectObservationInput'];
  approvalPresentation?: ParsedActionSpec['approvalPresentation'];
  projectObservationOutput?: ParsedActionSpec['projectObservationOutput'];
  approvalResultCustody?: ParsedActionSpec['approvalResultCustody'];
  accountAuthorityRetirementStatuses?: ParsedActionSpec['accountAuthorityRetirementStatuses'];
  approvalInputCustody?: ParsedActionSpec['approvalInputCustody'];
  approvalNarrowing?: ParsedActionSpec['approvalNarrowing'];
  projectSessionConfirmation?: ParsedActionSpec['projectSessionConfirmation'];
  execution?: ParsedActionSpec['execution'];
  sideEffectClass?: ParsedActionSpec['sideEffectClass'];
  workspaceWrite?: ParsedActionSpec['workspaceWrite'];
  examples?: ParsedActionSpec['examples'];
  prompting?: ParsedActionSpec['prompting'];
  toolExposure?: ParsedActionSpec['toolExposure'];
  contextualDefaults?: ParsedActionSpec['contextualDefaults'];
  sessionTarget?: ParsedActionSpec['sessionTarget'];
  operation?: ParsedActionSpec['operation'];
  operationReentry?: ParsedActionSpec['operationReentry'];
  requiredAuthority?: ParsedActionSpec['requiredAuthority'];
  executionPlacement?: ParsedActionSpec['executionPlacement'];
  executionPlacementForInput?: ParsedActionSpec['executionPlacementForInput'];
  executionPlacements?: ParsedActionSpec['executionPlacements'];
  originalExecution?: ParsedActionSpec['originalExecution'];
  pluginCallerPolicy?: ParsedActionSpec['pluginCallerPolicy'];
  surfaces: ParsedActionSpec['surfaces'];
  inputSchema: ParsedActionSpec['inputSchema'];
  inputHints?: ParsedActionSpec['inputHints'];
  cli?: ParsedActionSpec['cli'];
  serverTransport?: ParsedActionSpec['serverTransport'];
}>;

/**
 * API and Plugin admission are derived by normalizeActionPublicExposure. A
 * declaration may retain an API exclusion, but cannot grant API admission.
 */
export type PreNormalizedActionSurfaces = Omit<ActionSurfaces, 'api' | 'plugin'> & Readonly<{
  api?: false;
  plugin?: never;
}>;
export type ActionSpecDefinition = Omit<ActionSpecWithoutApproval, 'surfaces'> & Readonly<{
  surfaces: PreNormalizedActionSurfaces;
}>;
export type PreNormalizedActionSpec = ActionSpecDefinition;
type NormalizedActionSpec = ActionSpecWithoutApproval;

type ActionSpecProjectionKey = 'id' | 'approval' | 'inputSchema' | 'outputSchema' | 'surfaceBindings' | 'requiredAuthority';
export type ActionSpecProjectionMetadata = Omit<PreNormalizedActionSpec, ActionSpecProjectionKey>;

/**
 * Keeps each registry row's literal id and concrete Zod schema types intact.
 * Runtime validation still goes through ActionSpecSchema; this helper exists so
 * generated author projections do not widen back to ActionId/ZodTypeAny.
 */
export function defineActionSpecs<const TSpecs extends readonly PreNormalizedActionSpec[]>(
  specs: TSpecs,
): {
  readonly [Index in keyof TSpecs]: ActionSpecProjectionMetadata & {
    readonly [Key in keyof TSpecs[Index] as Key extends ActionSpecProjectionKey ? Key : never]: TSpecs[Index][Key];
  } & (TSpecs[Index]['surfaces'] extends Readonly<{ api: false }> ? Readonly<{
    // API exclusions affect public type membership; other surface metadata may stay broad.
    surfaces: PreNormalizedActionSurfaces & Readonly<{ api: false }>;
  }> : unknown);
};
export function defineActionSpecs(
  specs: readonly PreNormalizedActionSpec[],
): readonly PreNormalizedActionSpec[] {
  return specs;
}

const DAEMON_ADMIN_RPC_SURFACES = Object.freeze({
  ui: false,
  voice: false,
  agent: false,
  mcp: false,
  cli: false,
  rpc: true,
} satisfies PreNormalizedActionSurfaces);

const DAEMON_ADMIN_INPUT_HINTS = Object.freeze({
  fields: [],
} satisfies ActionInputHints);

const EmptyObjectSchema = lazyZodSchema(() => z.strictObject({}));
const BugReportGetLogTailInputSchema = lazyZodSchema(() => z.looseObject({
  path: z.optional(z.string().check(z.minLength(1))),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1024), z.maximum(1_000_000))),
}));
const BugReportUploadArtifactInputSchema = lazyZodSchema(() => z.looseObject({
  uploadUrl: z.optional(z.string()),
}));
const OptionalSessionIdInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
}));

const SessionIdRequiredInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
}));

const SessionTargetRequiredInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: SessionTargetV1Schema,
}));

const SessionTurnCancelInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
}));

const SessionPermissionModeSetInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)),
  permissionMode: SessionPermissionModeInputSchema,
  applyTiming: z.optional(SessionPermissionModeSetApplyTimingSchema),
}));

export const SessionModelSetInputSchema = lazyZodSchema(() => z.looseObject({
  applyTiming: z.optional(z.enum(['immediate', 'next_prompt'])),
  sessionId: z.string().check(z.minLength(1)),
  modelId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  providerConnectionId: z.optional(z.nullable(ProviderConnectionIdSchema)),
  teamCredentialModel: z.optional(TeamCredentialProviderModelSelectionV1Schema),
  teamVisibilityGrantConsent: z.optional(z.strictObject({ teamId: z.string().check(z.minLength(1)) })),
  captureBefore: z.optional(z.boolean()),
  expected: z.optional(SessionModelMutationExpectedV1Schema),
}).check(z.superRefine((value, context) => {
  const hasTeamSelection = value.teamCredentialModel !== undefined;
  const hasLegacySelection = value.modelId !== undefined || value.providerConnectionId !== undefined;
  if (hasTeamSelection === hasLegacySelection) {
    context.addIssue({
      code: "custom",
      path: ['teamCredentialModel'],
      message: 'Select exactly one model source',
    });
  }
  if (!hasTeamSelection && value.modelId === undefined) {
    context.addIssue({ code: "custom", path: ['modelId'], message: 'modelId is required' });
  }
  if (value.teamVisibilityGrantConsent && value.teamVisibilityGrantConsent.teamId !== value.teamCredentialModel?.teamId) {
    context.addIssue({ code: "custom", path: ['teamVisibilityGrantConsent'], message: 'Consent must match the selected Team' });
  }
})));

const SessionStatusGetInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: SessionTargetV1Schema,
  live: z.optional(z.boolean()),
  readiness: z.optional(z.boolean()),
  operation: z.optional(z.enum(['conversation', 'credential'])),
  credentialPurpose: z.optional(QualifiedConnectedAccountPurposeV1Schema),
  credentialTeamSelection: z.optional(QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema),
}));

const SessionHistoryGetInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(250))),
  format: z.optional(z.enum(['compact', 'raw'])),
  includeMeta: z.optional(z.boolean()),
  includeStructuredPayload: z.optional(z.boolean()),
}));

const SessionTranscriptRoleSchema = lazyZodSchema(() => z.enum(['user', 'assistant']));
const SessionStoredTranscriptRoleSchema = lazyZodSchema(() => z.enum(['user', 'agent', 'event', 'unknown']));

const SessionTranscriptGetExternalShareableProjectionSchema = lazyZodSchema(() => z.literal('externalShareableV1'));

/**
 * The largest page `session.transcript.get` will return for one request.
 *
 * Named here because the bound has consumers outside the schema: the reader
 * clamps to it, and a caller that wants the fewest possible round trips asks
 * for exactly it. Each of those was carrying its own copy of the number, so
 * lowering the bound left them confidently over-asking.
 */
export const SESSION_TRANSCRIPT_GET_MAX_LIMIT = 100;

const SessionTranscriptGetInputShape = {
  sessionId: z.string().check(z.minLength(1)),
  messageId: z.optional(z.string().check(z.minLength(1))),
  projection: z.optional(SessionTranscriptGetExternalShareableProjectionSchema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(SESSION_TRANSCRIPT_GET_MAX_LIMIT))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  direction: z.optional(z.enum(['before', 'after'])),
  scope: z.optional(z.enum(['main', 'sidechain', 'all'])),
  sidechainId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  roles: z.optional(z.array(SessionTranscriptRoleSchema)),
  includeTools: z.optional(z.boolean()),
  includeReasoning: z.optional(z.boolean()),
  includeEvents: z.optional(z.boolean()),
  includeMeta: z.optional(z.boolean()),
  includeStructuredPayload: z.optional(z.boolean()),
  includeRaw: z.optional(z.boolean()),
  maxCharsPerMessage: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(50_000)))),
  maxRawPayloadChars: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(32768)))),
};

function isSessionTranscriptSelectionValid(value: Readonly<{
  messageId?: string; cursor?: string | null; direction?: string; limit?: number; projection?: string;
}>): boolean {
  return value.messageId === undefined || (value.cursor === undefined && value.direction === undefined
    && value.limit === undefined && value.projection === undefined);
}
const exactTranscriptSelectionMessage = 'messageId cannot be combined with cursor, direction, limit or projection';

/** Closed semantic transcript input exposed to PAT/API/SDK callers. */
const SessionTranscriptGetPublicInputSchema = lazyZodSchema(() => z.omit(z.strictObject(SessionTranscriptGetInputShape),
  { projection: true }).check(z.refine(isSessionTranscriptSelectionValid, { message: exactTranscriptSelectionMessage })));

/** Exact public input for the closed external-shareable transcript projection. */
export const SessionTranscriptGetExternalShareableInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTranscriptGetInputShape.sessionId,
  projection: SessionTranscriptGetExternalShareableProjectionSchema,
  limit: SessionTranscriptGetInputShape.limit,
  cursor: SessionTranscriptGetInputShape.cursor,
}));
export type SessionTranscriptGetExternalShareableInputV1 = z.infer<
  typeof SessionTranscriptGetExternalShareableInputV1Schema
>;

export const SessionTranscriptGetInputSchema = lazyZodSchema(() => z.looseObject(SessionTranscriptGetInputShape).check(
  z.refine(isSessionTranscriptSelectionValid, { message: exactTranscriptSelectionMessage }), z.superRefine((value, context) => {
  if (value.projection !== 'externalShareableV1') return;
  const allowedKeys = new Set(['sessionId', 'projection', 'cursor', 'limit']);
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) continue;
    context.addIssue({
      code: 'custom',
      path: [key],
      message: `${key} is not accepted by the externalShareableV1 projection`,
    });
  }
})));
export type SessionTranscriptGetInput = z.infer<typeof SessionTranscriptGetInputSchema>;
const SessionTranscriptSemanticRoleSchema = lazyZodSchema(() => z.enum([
  'user',
  'assistant',
  'tool',
  'event',
  'reasoning',
  'unknown',
]));
const SessionTranscriptStoredMessageRoleSchema = lazyZodSchema(() => z.enum(['user', 'agent', 'event', 'unknown']));
const SessionTranscriptGetItemSchema = lazyZodSchema(() => z.strictObject({
  id: z.string(),
  seq: z.optional(z.number().check(z.int(), z.nonnegative())),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  storedMessageRole: z.optional(SessionTranscriptStoredMessageRoleSchema),
  semanticRole: SessionTranscriptSemanticRoleSchema,
  role: SessionTranscriptSemanticRoleSchema,
  kind: z.string(),
  origin: z.optional(ConversationTurnOriginV1Schema),
  provider: z.optional(z.string()),
  text: z.optional(z.string()),
  summary: z.optional(z.string()),
  toolName: z.optional(z.string()),
  callId: z.optional(z.string()),
  raw: z.optional(z.unknown()),
  truncated: z.optional(z.boolean()),
  rawTruncated: z.optional(z.boolean()),
}));
export type SessionTranscriptGetItem = z.infer<typeof SessionTranscriptGetItemSchema>;

const SessionTranscriptGetSemanticSuccessSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  sessionId: z.string().check(z.minLength(1)),
  items: z.readonly(z.array(SessionTranscriptGetItemSchema)),
  nextCursor: z.nullable(z.string().check(z.minLength(1))),
  hasMore: z.boolean(),
  diagnostics: z.strictObject({
    rawRowsScanned: z.number().check(z.int(), z.nonnegative()),
    pagesFetched: z.number().check(z.int(), z.nonnegative()),
    scanLimitReached: z.boolean(),
    payloadTruncations: z.number().check(z.int(), z.nonnegative()),
  }),
}));

export const SessionTranscriptGetExternalShareableResultV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalShareableTranscriptPageV1Schema, {
  ok: z.literal(true),
  sessionId: z.string().check(z.minLength(1)),
  projection: z.literal('externalShareableV1'),
})));

const SessionTranscriptGetErrorSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  errorCode: z.string().check(z.minLength(1)),
  errorMessage: z.string().check(z.minLength(1)),
  candidates: z.optional(z.readonly(z.array(z.string().check(z.minLength(1))))),
}));

/** Canonical strict result envelope for every session.transcript.get Action path. */
export const SessionTranscriptGetResultSchema = lazyZodSchema(() => z.union([
  SessionTranscriptGetSemanticSuccessSchema,
  SessionTranscriptGetExternalShareableResultV1Schema,
  SessionTranscriptGetErrorSchema,
]));
export type SessionTranscriptGetResult = z.infer<typeof SessionTranscriptGetResultSchema>;
export type SessionTranscriptGetExternalShareableResultV1 = z.infer<
  typeof SessionTranscriptGetExternalShareableResultV1Schema
>;
export type SessionTranscriptGetOutput = SessionTranscriptGetResult;

export const SessionEventsGetInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  direction: z.optional(z.enum(['before', 'after'])),
  scope: z.optional(z.enum(['main', 'sidechain', 'all'])),
  sidechainId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  roles: z.optional(z.array(SessionStoredTranscriptRoleSchema)),
  kinds: z.optional(z.array(z.string().check(z.minLength(1)))),
  format: z.optional(z.enum(['compact', 'raw'])),
  includeMeta: z.optional(z.boolean()),
  includeStructuredPayload: z.optional(z.boolean()),
  includeRaw: z.optional(z.boolean()),
  maxTextChars: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(4000))),
  maxPayloadChars: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(32768))),
}).check(z.superRefine((value, ctx) => {
  if (value.sidechainId && value.scope !== 'sidechain') {
    ctx.addIssue({
      code: "custom",
      message: 'scope must be sidechain when sidechainId is provided',
      path: ['scope'],
    });
  }
})));
export type SessionEventsGetInput = z.infer<typeof SessionEventsGetInputSchema>;
export type SessionEventsGetItem = Readonly<{
  id: string;
  seq?: number;
  createdAt: number;
  storedMessageRole?: 'user' | 'agent' | 'event' | 'unknown';
  semanticRole: 'user' | 'assistant' | 'tool' | 'event' | 'reasoning' | 'unknown';
  kind: string;
  origin?: ConversationTurnOriginV1;
  provider?: string;
  text?: string;
  summary?: string;
  toolName?: string;
  callId?: string;
  raw?: unknown;
  truncated?: boolean;
  rawTruncated?: boolean;
}>;
export type SessionEventsGetOutput =
  | Readonly<{
      ok: true;
      sessionId: string;
      items: readonly SessionEventsGetItem[];
      nextCursor: string | null;
      hasMore: boolean;
      diagnostics?: Readonly<{
        rawRowsScanned: number;
        pagesFetched: number;
        scanLimitReached: boolean;
        payloadTruncations: number;
      }>;
    }>
  | Readonly<{
      ok: false;
      errorCode: string;
      errorMessage: string;
      candidates?: readonly string[];
    }>;

const SessionWaitIdleInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  timeoutSeconds: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(3600))),
}));

const SessionWaitIdlePublicInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(SessionWaitIdleInputSchema));

/** Exact result returned by the canonical Session idle waiter. */
export const SessionWaitIdleResultSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    sessionId: z.string().check(z.minLength(1)),
    idle: z.literal(true),
    observedAt: z.number().check(z.nonnegative()),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      'session_not_found',
      'session_id_ambiguous',
      'session_lookup_timeout',
      'unsupported',
      'encryption_material_unavailable',
      'timeout',
    ]),
    candidates: z.optional(z.readonly(z.array(z.string().check(z.minLength(1))))),
  }),
]));

const SessionGoalSetInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: SessionTargetV1Schema,
  objective: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4000))),
  status: z.optional(SessionWorkStateStatusV1Schema),
  tokenBudget: z.optional(z.nullable(z.number().check(z.positive()))),
  resumeInactiveWithInitialGoal: z.optional(z.boolean()),
}).check(z.refine((value) => (
  typeof value.objective === 'string'
  || typeof value.status === 'string'
  || Object.prototype.hasOwnProperty.call(value, 'tokenBudget')
), { message: 'At least one goal mutation field is required' })));

const SessionFollowPreferencesCliInputSchema = lazyZodSchema(() => z.strictObject({
  assigned: z.enum(['on', 'off']),
  direct: z.enum(['on', 'off']),
  team: z.enum(['on', 'off']),
  group: z.enum(['on', 'off']),
  managerPolicy: SessionFollowActionInputSchemasV1['follow.preferences.set'].shape.managerPolicy,
  runReportPolicy: SessionFollowActionInputSchemasV1['follow.preferences.set'].shape.runReportPolicy,
  discussionReceivePolicy: SessionFollowActionInputSchemasV1['follow.preferences.set'].shape.discussionReceivePolicy,
}));

const SessionCatalogListInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  cwd: z.optional(z.string().check(z.minLength(1))),
}));

const SessionVendorPluginCatalogListOutputSchema = lazyZodSchema(() => z.looseObject({
  supported: z.optional(z.boolean()),
  unsupported: z.optional(z.literal(true)),
  vendorPlugins: z.readonly(z.array(VendorPluginCatalogItemV1Schema)),
  catalog: z.optional(VendorPluginCatalogV1Schema),
  diagnostic: z.optional(z.string().check(z.minLength(1))),
}));

const SessionSkillCatalogListOutputSchema = lazyZodSchema(() => z.looseObject({
  supported: z.optional(z.boolean()),
  unsupported: z.optional(z.literal(true)),
  skills: z.readonly(z.array(SkillCatalogItemV1Schema)),
  catalog: z.optional(SkillCatalogV1Schema),
  diagnostic: z.optional(z.string().check(z.minLength(1))),
}));

const BackendTargetKeyInputSchema = lazyZodSchema(() => z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]));

const IntentStartCommonSchema = lazyZodSchema(() => z.looseObject({
  roleId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  launchProfileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sessionId: z.optional(z.string().check(z.minLength(1))),
  backendTargetKeys: z.array(BackendTargetKeyInputSchema).check(z.minLength(1)),
  instructions: z.string().check(z.trim(), z.minLength(1)),
  permissionMode: z.optional(ExecutionRunActionPermissionModeSchema),
  retentionPolicy: z.optional(z.enum(['ephemeral', 'resumable'])),
  runClass: z.optional(z.enum(['bounded', 'long_lived'])),
  ioMode: z.optional(z.enum(['request_response', 'streaming'])),
  notifyParentOnCompletion: z.optional(z.boolean()),
  /**
   * Optional model selection applied to EVERY started run, reusing the canonical session-spawn
   * `modelId` vocabulary. Attached omission inherits at host admission;
   * independent starts use their default model.
   */
  modelId: z.optional(z.string().check(z.minLength(1))),
  modelSelection: ExecutionRunStartRequestBaseSchema.shape.modelSelection,
  /** Exact recipient-safe Team resource/model selection for the one selected Agent target. */
  teamCredentialModel: z.optional(TeamCredentialProviderModelSelectionV1Schema),
  teamCredentialSessionBindingConsent: z.optional(ExecutionRunTeamCredentialSessionBindingConsentV1Schema),
  /** Value-free Saved Secret binding overrides for this launch only. */
  secretReferenceOverlay: z.optional(SecretReferenceOverlayV1Schema),
  /**
   * Optional canonical agent config-option overrides (e.g. reasoning effort) applied to every
   * started run — the SAME `AcpConfigOptionOverridesV1` shape session spawn uses.
   */
  sessionConfigOptionOverrides: z.optional(AcpConfigOptionOverridesV1Schema),
  /**
   * Ergonomic shorthand for `sessionConfigOptionOverrides` (id → value). Merged into the canonical
   * overrides at the action boundary; a value conflicting with `sessionConfigOptionOverrides`
   * fails with `invalid_parameters`.
   */
  configOptions: z.optional(z.record(z.string(), SpawnConfigOptionValueSchema)),
  /** Blanket connected-services selection; an exact per-target entry overrides it. */
  connectedServices: z.optional(StrictJsonValueSchema),
  /**
   * Optional per-backend-target connected-services selection, keyed by the SAME backend target
   * key strings passed in `backendTargetKeys`. Each value may be an agent-friendly simple string
   * (`"<service>:group:<id>"`, `"<service>:<profileId>"`, `"<service>:native"`), an array of those,
   * or the full current connected-service bindings object — normalized at the action boundary. Targets
   * without an entry use the blanket choice, attached host inheritance, or independent
   * Account defaults; connected selections fail closed at run start.
   */
  connectedServicesByBackendTargetKey: z.optional(z
    .record(z.string(), StrictJsonValueSchema)),
}));

const PlanStartInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(IntentStartCommonSchema, {
  target: z.optional(z.strictObject({ kind: z.literal('detached') })),
  permissionMode: z._default(ExecutionRunActionPermissionModeSchema, 'read_only'),
  retentionPolicy: z._default(z.enum(['ephemeral', 'resumable']), 'ephemeral'),
  runClass: z._default(z.enum(['bounded', 'long_lived']), 'bounded'),
  ioMode: z._default(z.enum(['request_response', 'streaming']), 'request_response'),
})).check(z.refine((input) => !input.target || input.sessionId === undefined, {
  path: ['sessionId'], message: 'A detached plan cannot target a Session',
})));

const DelegateStartInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(IntentStartCommonSchema, {
  permissionMode: z.optional(ExecutionRunActionPermissionModeSchema),
  retentionPolicy: z._default(z.enum(['ephemeral', 'resumable']), 'ephemeral'),
  runClass: z._default(z.enum(['bounded', 'long_lived']), 'bounded'),
  ioMode: z._default(z.enum(['request_response', 'streaming']), 'request_response'),
})));

const VoiceAgentStartInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(IntentStartCommonSchema, {
  permissionMode: z._default(ExecutionRunActionPermissionModeSchema, 'read_only'),
  retentionPolicy: z._default(z.enum(['ephemeral', 'resumable']), 'ephemeral'),
  runClass: z._default(z.enum(['bounded', 'long_lived']), 'long_lived'),
  ioMode: z._default(z.enum(['request_response', 'streaming']), 'streaming'),
})));

/**
 * Scope is intentionally tri-state: an omitted field resolves to the caller's
 * current Session when one exists; explicit `null` means detached; and a string
 * identifies one exact Session. Keep the property optional so the action owner
 * can distinguish omission from explicit `null` by property presence.
 */
const ExecutionRunScopeSessionIdSchema = lazyZodSchema(() => z.optional(z.nullable(z.string().check(z.minLength(1), z.refine((sessionId) => sessionId.trim().length > 0, { message: 'sessionId must not be whitespace only' })))));

const ExecutionRunIdInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: ExecutionRunScopeSessionIdSchema,
  runId: z.string().check(z.minLength(1)),
}));

type ExecutionRunStartActionRawInput = z.input<typeof ExecutionRunStartPluginInputSchema>;

/**
 * Normalize the agent-friendly `connectedServices` simple-form (string / array) into the canonical
 * current bindings object BEFORE the strict run-request schema validates it. A malformed
 * value is left untouched so the strict schema rejects it (→ `invalid_parameters`). Non-simple
 * (already-object) values pass through unchanged. This keeps the run REQUEST schema strict while the
 * action input accepts the ergonomic forms an agent can produce from the spec alone.
 */
function preprocessRunStartConnectedServicesInput(raw: ExecutionRunStartActionRawInput): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const selection = record.connectedServices;
  if (typeof selection !== 'string' && !Array.isArray(selection)) return raw;
  const normalized = normalizeConnectedServiceSelectionInput(selection);
  if (!normalized.ok) return raw;
  return { ...record, connectedServices: normalized.bindings };
}

const ExecutionRunStartActionRequestSchema = lazyZodSchema(() => z.extend(ExecutionRunStartRequestBaseSchema, {
  // Action callers use the canonical permission-intent vocabulary. The
  // execution-run RPC retains its historical wire tokens, so this shared
  // Action-boundary schema projects `safe-yolo` → `workspace_write` once,
  // before it reaches the run owner.
  permissionMode: ExecutionRunActionPermissionModeSchema,
  sessionId: ExecutionRunScopeSessionIdSchema,
  waitForCompletion: z.optional(z.boolean()),
  waitTimeoutSeconds: z.optional(z.number().check(z.int(), z.minimum(1))),
  /**
   * Ergonomic shorthand for `sessionConfigOptionOverrides` (id → value). Merged into the canonical
   * overrides at the action boundary; conflicting values fail with `invalid_parameters`.
   */
  configOptions: z.optional(z.record(z.string(), SpawnConfigOptionValueSchema)),
}).check(z.superRefine(refineExecutionRunStartRequest), z.superRefine((value, ctx) => {
  if (
    value.teamCredentialSessionBindingConsent
    && (
      value.sessionId === null
      || value.teamCredentialSessionBindingConsent.sessionId !== value.sessionId
    )
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'Session binding consent requires and must match an attached Session',
      path: ['teamCredentialSessionBindingConsent', 'sessionId'],
    });
  }
  if (value.waitTimeoutSeconds !== undefined && value.waitForCompletion !== true) {
    ctx.addIssue({
      code: "custom",
      message: 'waitTimeoutSeconds requires waitForCompletion=true',
      path: ['waitTimeoutSeconds'],
    });
  }
})));

const ExecutionRunStartPluginInputSchema = lazyZodSchema(() => z.extend(ExecutionRunStartRequestBaseSchema, {
  // Trusted plugins share the public Action contract; do not let them carry
  // a second, unnormalized permission-mode vocabulary into execution runs.
  permissionMode: ExecutionRunActionPermissionModeSchema,
  sessionId: ExecutionRunScopeSessionIdSchema,
  waitForCompletion: z.optional(z.boolean()),
  waitTimeoutSeconds: z.optional(z.number().check(z.int(), z.minimum(1))),
  configOptions: z.optional(z.record(z.string(), SpawnConfigOptionValueSchema)),
  connectedServices: z.optional(z.union([
    ConnectedServiceBindingsV2IngressSchema,
    z.string(),
    z.array(z.string()),
  ])),
}).check(z.superRefine(refineExecutionRunStartRequest), z.superRefine((value, ctx) => {
  if (
    value.teamCredentialSessionBindingConsent
    && (
      value.sessionId === null
      || value.teamCredentialSessionBindingConsent.sessionId !== value.sessionId
    )
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'Session binding consent requires and must match an attached Session',
      path: ['teamCredentialSessionBindingConsent', 'sessionId'],
    });
  }
  if (value.waitTimeoutSeconds !== undefined && value.waitForCompletion !== true) {
    ctx.addIssue({
      code: "custom",
      message: 'waitTimeoutSeconds requires waitForCompletion=true',
      path: ['waitTimeoutSeconds'],
    });
  }
})));

const ExecutionRunStartInputSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(preprocessRunStartConnectedServicesInput), ExecutionRunStartActionRequestSchema));

const ExecutionRunGetInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  includeStructured: z.optional(z.boolean()),
  waitForInputId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  waitForOutput: z.optional(ExecutionRunOutputObservationSchema),
})));

export const DetachedExecutionRunSendInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.null(),
  runId: z.string().check(z.minLength(1)),
  message: z.string().check(z.minLength(1)),
  localInputId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  resultContract: z.optional(ExecutionRunResultContractV1Schema),
  resume: z.optional(z.boolean()),
  delivery: z.optional(z.enum(['prompt', 'steer_if_supported', 'interrupt'])),
}).check(z.superRefine((value, ctx) => {
  if (value.resultContract && !value.localInputId) {
    ctx.addIssue({
      code: "custom",
      path: ['localInputId'],
      message: 'resultContract requires exact localInputId correspondence',
    });
  }
})));

const ExecutionRunEnsureInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  resume: z.optional(z.boolean()),
})));

const ExecutionRunEnsureOrStartInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: ExecutionRunScopeSessionIdSchema,
  runId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  start: z.optional(ExecutionRunStartRequestSchema),
  resume: z.optional(z.boolean()),
}).check(z.superRefine((value, ctx) => {
  const runId = typeof value.runId === 'string' ? value.runId.trim() : '';
  if (!runId && !value.start) {
    ctx.addIssue({ code: "custom", message: 'start is required when runId is missing' });
  }
})));

const ExecutionRunStreamStartInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  message: z.string().check(z.minLength(1)),
  displayMessage: z.optional(z.string().check(z.minLength(1))),
  resume: z.optional(z.boolean()),
})));

const ExecutionRunStreamReadInputSchema = lazyZodSchema(() => z.extend(ExecutionRunTurnStreamReadRequestSchema, {
  sessionId: ExecutionRunScopeSessionIdSchema,
}));

const ExecutionRunStreamCancelInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  streamId: z.string().check(z.minLength(1)),
})));

const ExecutionRunActionInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  actionId: z.string().check(z.minLength(1)),
  input: z.optional(StrictJsonValueSchema),
})));

export const ExecutionRunPermissionRespondInputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ runId: z.string().check(z.trim(), z.minLength(1)), requestId: z.string().check(z.trim(), z.minLength(1)), approved: z.boolean() }),
  z.strictObject({ runId: z.string().check(z.trim(), z.minLength(1)), requestId: z.string().check(z.trim(), z.minLength(1)), answers: StructuredQuestionAnswersV1Schema }),
]));

export type ExecutionRunPermissionRespondActionInput = z.input<typeof ExecutionRunPermissionRespondInputSchema>;

const ExecutionRunWaitInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(ExecutionRunIdInputSchema, {
  timeoutSeconds: z.optional(z.number().check(z.int(), z.minimum(1))),
  condition: z.optional(ExecutionRunWaitConditionSchema),
  after: z.optional(ExecutionRunGetResponseSchema),
})));

const ExecutionRunWaitPublicInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ExecutionRunWaitInputSchema));

const SessionOpenInputSchema = lazyZodSchema(() => z.strictObject({
  tabId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sessionId: z.optional(SessionTargetV1Schema),
  sessionTitle: z.optional(z.string().check(z.trim(), z.minLength(1))),
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  approvedNewDirectoryCreation: z.optional(z.boolean()),
  intent: z.optional(z.literal('resume')),
  resumeRequest: z.optional(SessionResumeRequestV1Schema),
  destination: z.optional(z.strictObject({
    kind: z.literal('scmReview'),
    comparison: ScmComparisonSourceSchema,
    view: z.enum(SCM_COMPARISON_VIEWS),
    explain: z.optional(z.boolean()),
    comparisonId: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
  })),
}).check(z.superRefine((value, ctx) => {
  if (value.resumeRequest && (value.intent !== 'resume' || value.tabId || value.destination
    || value.resumeRequest.sessionId !== value.sessionId)) ctx.addIssue({
      code: 'custom', path: ['resumeRequest'], message: 'Resume request requires its exact headless Session address',
    });
  if ((value.sessionId === undefined || typeof value.sessionId === 'string' && !value.sessionId.trim())
    && !(typeof value.sessionTitle === 'string' && value.sessionTitle.trim().length > 0)) {
    ctx.addIssue({
      code: "custom",
      message: 'sessionId or sessionTitle is required',
      path: ['sessionId'],
    });
  }
})));

const SessionForkInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(SessionForkRpcParamsSchema, {
  v: true,
  parentSessionId: true,
}), {
  sessionId: z.optional(z.string().check(z.minLength(1))),
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  forkPoint: z.optional(SessionForkRpcParamsSchema.shape.forkPoint),
})));

const SessionRollbackInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  target: z.optional(SessionRollbackTargetSchema),
}));

/**
 * Outcome-oriented public handoff input. Workspace endpoint identity and the
 * settings version that proves it are daemon-owned: the coordinator resolves or
 * materializes both `WorkspaceRef` values from the Account settings owner, so a
 * caller can neither name nor pin them here.
 */
const SessionHandoffInputFieldsSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(SessionTargetV1Schema),
  sourceMachineId: z.optional(z.string().check(z.minLength(1))),
  targetMachineId: z.optional(z.string().check(z.minLength(1))),
  targetPath: z.optional(z.string().check(z.minLength(1))),
  sessionStorageMode: z.optional(z.enum(['direct', 'persisted'])),
  targetSessionStorageMode: z.optional(z.enum(['direct', 'persisted'])),
  stateTransfer: z.optional(SessionHandoffStateTransferSchema),
  preferredTransportStrategies: z.optional(z.array(z.enum(['direct_peer', 'server_routed_stream'])).check(z.maxLength(2))),
  workspaceAction: z.optional(HandoffWorkspaceActionV1Schema),
  accountServerId: z.optional(z.string().check(z.minLength(1))),
  actionRequestId: z.optional(z.string().check(z.minLength(1), z.maxLength(2_000))),
  handoffTargetReplacementApproval: z.optional(HandoffTargetReplacementApprovalV1Schema),
  handoffTargetReplacementApprovalReceiptId: z.optional(z.string().check(z.minLength(1), z.maxLength(2_000))),
  handoffTargetReplacementApprovalActionInput: z.optional(z.unknown()),
}));

const SessionHandoffInputSchema = lazyZodSchema(() => SessionHandoffInputFieldsSchema.check(z.superRefine(refineSessionHandoffStateTransferV3)));

const SessionHandoffPublicInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(SessionHandoffInputFieldsSchema, {
  sourceMachineId: true,
  sessionStorageMode: true,
  preferredTransportStrategies: true,
  accountServerId: true,
  actionRequestId: true,
  handoffTargetReplacementApproval: true,
  handoffTargetReplacementApprovalReceiptId: true,
  handoffTargetReplacementApprovalActionInput: true,
})).check(z.superRefine(refineSessionHandoffStateTransferV3)));

const SessionSpawnNewInputSchema = SessionSpawnNewInputV2Schema;
const SessionSpawnNewApiInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(SessionSpawnNewInputV2BaseSchema, {
  executionTarget: true,
})).check(z.superRefine(refineSessionDirectoryIntentCheckoutV1)));
const SessionSpawnNewInputHints = {
  title: 'Create a new session',
  description: 'Start a session with an agent on one of your machines.',
  fields: [
    { path: 'creationKey', title: 'Creation key', widget: 'text' },
    { path: 'executionTarget.serverId', title: 'Server id', widget: 'text', required: true, optionsSourceId: 'sessions.spawn.servers.available' },
    { path: 'executionTarget.machineId', title: 'Machine id', widget: 'text', required: true, optionsSourceId: 'sessions.spawn.machines.available' },
    { path: 'directory', title: 'Directory intent', widget: 'json', required: true, optionsSourceId: 'sessions.spawn.paths.recent' },
    { path: 'organizationPlacement', title: 'Organization placement', widget: 'json' },
    { path: 'agentTarget', title: 'Agent target', description: 'Backend options carry target keys. For agent:<pluginId>/<localId>, use {kind:"agent",identity:{pluginId,localId}}; retain definitionId for a configured Agent.', widget: 'json', required: true, optionsSourceId: 'agents.backends.enabled' },
    { path: 'modelSelection', title: 'Model selection', description: 'Native model options carry a model id in option.value. Use {v:1,ref:{agentTargetKey,providerConnectionId:null,modelId:option.value},updatedAt:<milliseconds>}, with the selected Agent target key. Provider catalog choices retain their structured ref. A Connected Account profile is not a providerConnectionId.', widget: 'json', optionsSourceId: 'agents.models.available' },
    { path: 'title', title: 'Title', widget: 'text' },
    { path: 'permissionMode', title: 'Permission mode', description: `Canonical intent: ${AGENT_PERMISSION_INTENTS_V1.join(', ')}. Use "read-only" for read-only access.`, widget: 'text' },
    { path: 'allowedTools', title: 'Allowed tool rules', widget: 'json' },
    { path: 'unlistedTools', title: 'Unlisted tools', widget: 'select',
      options: [{ value: 'ask', label: 'Ask for approval' }, { value: 'deny', label: 'Deny without asking' }] },
    { path: 'agentModeId', title: 'Agent mode', widget: 'text', optionsSourceId: 'agents.session_modes.available' },
    { path: 'configuration', title: 'Configuration', description: 'Optional full snapshot: {mode:{value:null,updatedAtMs:0},model:{value:null,updatedAtMs:0},permissionIntent:{value:null,updatedAtMs:0},options:{}}. Set model.value to a model-id string or null, permissionIntent.value to a canonical intent or null, and options[option.value] to {value:<scalar>,updatedAtMs:<milliseconds>}. For model-scoped choices, first supply draftInput.modelSelection or draftInput.configuration.model; without a selected model the inventory contains only session-wide options. Config-option choices name option ids, not snapshots or selected values; read agents.config_options.list with modelId for their value choices. Omit configuration when no override is needed.', widget: 'json', optionsSourceId: 'agents.config_options.available' },
    { path: 'profileId', title: 'Profile id', widget: 'text', optionsSourceId: 'sessions.spawn.profiles.available' },
    { path: 'connectedServices', title: 'Connected services', description: 'From an Agent Session, omission inherits the parent Connected selection when the child resolves to the same Agent. Root starts and other Agents use Account defaults. Pass an explicit binding object to override; {v:2,bindingsByServiceId:{}} requests native authentication. Read your Session selection through session.status.get. Pass the selected option.value through this schema; a Connected Account profile id is not a modelSelection.ref.providerConnectionId.', widget: 'json', optionsSourceId: 'sessions.spawn.connected_services.available' },
    { path: 'capabilitySelection', title: 'Capability selection', widget: 'json', optionsSourceId: 'sessions.spawn.capabilities.preview' },
    { path: 'transcriptStorage', title: 'Transcript storage', widget: 'text' },
    { path: 'terminal', title: 'Terminal', widget: 'json' },
    { path: 'checkoutCreationDraft', title: 'Checkout creation', widget: 'json' },
    { path: 'initialInput.text', title: 'Initial message', widget: 'textarea' },
    { path: 'initialInput.attachments', title: 'Initial attachments', widget: 'json' },
    { path: 'agentSessionStartupInstructionsV1', title: 'Startup instructions', widget: 'json' },
  ],
} satisfies ActionInputHints;
const SessionSpawnNewApiInputHints = {
  ...SessionSpawnNewInputHints,
  fields: SessionSpawnNewInputHints.fields.filter((field) => (
    field.path !== 'executionTarget.serverId' && field.path !== 'executionTarget.machineId'
  )),
} satisfies ActionInputHints;

/**
 * The sole canonical-to-public projection for a Session creation request that
 * was already admitted on a local Action surface. Execution placement remains
 * transport metadata: the public input cannot carry it, while the selected
 * machine reaches the API envelope as its exact target.
 */
export function projectSessionSpawnNewApiRequest(
  value: unknown,
): Readonly<{
  input: z.input<typeof SessionSpawnNewApiInputSchema>;
  target: Extract<ExternalActionTargetV1, { kind: 'machine' }>;
}> {
  const canonicalInput = SessionSpawnNewInputV2Schema.parse(value);
  const { executionTarget, ...apiInput } = canonicalInput;
  return {
    input: SessionSpawnNewApiInputSchema.parse(apiInput),
    target: {
      kind: 'machine',
      machineId: executionTarget.machineId,
    },
  };
}

// Action invocations may derive a key from their durable request identity, but
// RPC retries have no such identity. The transport therefore requires the
// caller's one logical creation key rather than synthesizing one per attempt.
const SessionSpawnNewRpcInputSchema = lazyZodSchema(() => z.safeExtend(SessionSpawnNewInputV2Schema, {
  creationKey: SessionCreationKeyV1Schema,
}));

function bindApiSessionSpawnNewInput(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const input = SessionSpawnNewApiInputSchema.parse(value);
  const serverId = context.serverId;
  const target = context.externalActionTarget;
  if (
    context.caller.kind !== 'host'
    || typeof serverId !== 'string'
    || serverId.trim().length === 0
    || target?.kind !== 'machine'
  ) {
    throw new Error('API session spawn requires a host-stamped machine target and server id');
  }

  return {
    ...input,
    executionTarget: {
      serverId,
      machineId: target.machineId,
    },
  };
}

function validateAgentIdAndBackendTargetKeySelection(
  value: Readonly<{
    agentId?: string;
    backendTargetKey?: string;
    backendTarget?: z.infer<typeof BackendTargetRefV2Schema>;
    runtimeDescriptorV1?: z.infer<typeof RuntimeDescriptorV1Schema>;
  }>,
  ctx: z.core.$RefinementCtx,
): void {
  const resolved = resolveActionBackendTargetSelection(value);
  if (!resolved.ok) {
    ctx.addIssue({
      code: "custom",
      message: resolved.message,
      path: [resolved.path],
    });
  }
}

function validateStringAliasPair(
  value: Readonly<Record<string, unknown>>,
  ctx: z.core.$RefinementCtx,
  params: Readonly<{ primary: string; alias: string }>,
): void {
  const primaryValue = value[params.primary];
  const aliasValue = value[params.alias];
  if (typeof primaryValue !== 'string' || typeof aliasValue !== 'string') return;
  if (primaryValue.trim() === aliasValue.trim()) return;
  ctx.addIssue({
    code: "custom",
    message: `${params.primary} and ${params.alias} must match when both are provided`,
    path: [params.alias],
  });
}

const PathsListRecentInputSchema = lazyZodSchema(() => z.looseObject({
  machineId: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50))),
}));

/**
 * The persisted project registry read.
 *
 * It narrows by Home, machine, visibility and an explicit count. It does not filter by
 * hosting provider or repository name: matching a repository to a checkout is
 * one decision with one owner, and a filter here would make this a second place
 * that rule lives — silently disagreeing with the caller's own matcher the day
 * either one changes. Registry coverage accompanies the result so callers
 * cannot infer uniqueness from a partial answer.
 */
const ProjectsListInputSchema = lazyZodSchema(() => z.strictObject({
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  machineId: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  includeHidden: z.optional(z.boolean()),
}));

/**
 * The Prompt Library invocation inventory read.
 *
 * It returns the invocation entries themselves — stable `id`, user-facing
 * `token`, title, behavior — and never a prompt body: an inventory that
 * expanded every referenced document would fetch every artifact in the Library
 * to answer "which prompts exist".
 */
const PromptInvocationsListInputSchema = lazyZodSchema(() => z.looseObject({
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
}));

/**
 * Resolve ONE Prompt Library invocation to the text it produces.
 *
 * `invocationId` is the entry's stable id, never the renameable slash token:
 * renaming a command must not break a stored reference to it. Rendering the
 * body is the Library's own job, so this is a projection of the incumbent
 * expansion owner rather than a second template renderer.
 */
const PromptInvocationResolveInputSchema = lazyZodSchema(() => z.looseObject({
  invocationId: z.string().check(z.minLength(1)),
  argsText: z.optional(z.string()),
}));

const MachinesListInputSchema = lazyZodSchema(() => z.strictObject({
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  refresh: z.optional(z.boolean()),
}));

const MachineAgentInstallCliInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.optional(z.string().check(z.minLength(1))), agentId: z.string().check(z.minLength(1)), definitionId: z.optional(z.string().check(z.minLength(1))),
  intent: z.optional(z.enum(['install', 'update'])), consent: z.optional(DaemonAgentInstallStartRequestSchema.shape.consent),
  force: z.optional(z.boolean()), yes: z.optional(z.boolean()), allowVendorRecipe: z.optional(z.boolean()), dryRun: z.optional(z.boolean()),
  version: z.optional(z.string().check(z.minLength(1))),
}));

/**
 * The friendly `happier machines list` bound has always been the whole page. It
 * is a caller default, not an Action default: another surface may page.
 */
const MACHINES_LIST_CLI_DEFAULT_LIMIT = 200;
const MachinesListCliInputSchema = lazyZodSchema(() => z.strictObject({
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(MACHINES_LIST_CLI_DEFAULT_LIMIT))),
  refresh: z.optional(z.boolean()),
}));

const ServersListInputSchema = lazyZodSchema(() => z.looseObject({
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
}));

const ReviewEnginesListInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  includeDisabled: z.optional(z.boolean()),
  scope: z.optional(z.literal('paths')),
}));

/**
 * `machineId` scopes the answer to the installed/external Agents one machine's
 * daemon projection admits. The executor forwards it to the host inventory
 * owner, so it is part of this canonical contract rather than passthrough
 * residue: an input the schema does not name is a contract the schema lies
 * about.
 */
const AgentsBackendsListInputSchema = lazyZodSchema(() => z.looseObject({
  includeDisabled: z.optional(z.boolean()),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  machineId: z.optional(z.string().check(z.minLength(1))),
}));

export const AgentInventoryProbeInputSchema = lazyZodSchema(() => z.strictObject({
  cwd: z.optional(z.string().check(z.trim(), z.minLength(1))),
  timeoutMs: z.optional(z.number().check(z.positive())),
  transportTimeoutMs: z.optional(z.number().check(z.positive())),
  bypassCache: z.optional(z.boolean()),
  profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  runtimeDescriptorV1: z.optional(RuntimeDescriptorV1Schema),
  connectedServices: z.optional(ConnectedServiceBindingsV2IngressSchema),
}));
export type AgentInventoryProbeInput = z.output<typeof AgentInventoryProbeInputSchema>;

function inventoryOutputWithProbeObservation(observationSchema: z.ZodMiniType) {
  return lazyZodSchema(() => StrictJsonValueSchema.check(z.superRefine((value, ctx) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'probeObservation')) return;
    const rawObservation: unknown = Reflect.get(value, 'probeObservation');
    const observation = observationSchema.safeParse(rawObservation);
    if (!observation.success) for (const issue of observation.error.issues) {
      ctx.addIssue({ ...issue, path: ['probeObservation', ...issue.path] });
    }
  })));
}

const AgentsModelsListInputSchema = lazyZodSchema(() => z.strictObject({
  purpose: z.optional(z.literal('scm_diff_summary')),
  discoveryTargetKey: z.optional(BackendTargetKeyV2Schema),
  modelSelector: z.optional(ScmDiffSummaryModelSelectorSchema),
  agentId: z.optional(z.string().check(z.minLength(1))),
  backendTargetKey: z.optional(z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema])),
  machineId: z.optional(z.string().check(z.minLength(1))),
  // Home routing is bound by the authenticated host, never authored inventory input.
  serverId: z.optional(z.never()),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  probe: z.optional(AgentInventoryProbeInputSchema),
}).check(z.superRefine((value, ctx) => {
  if (value.purpose === 'scm_diff_summary') {
    if (!value.machineId || value.agentId || value.backendTargetKey || value.probe || value.limit !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'Summary catalog requires only an exact machine target', path: ['machineId'] });
    }
    return;
  }
  if (value.discoveryTargetKey || value.modelSelector) ctx.addIssue({ code: 'custom', message: 'Summary catalog purpose is required', path: ['purpose'] });
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: "custom",
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
})));

const AgentSpawnOptionsListInputBaseSchema = lazyZodSchema(() => z.object({
  agentId: z.optional(z.string().check(z.minLength(1))),
  backendTargetKey: z.optional(z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema])),
  machineId: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
}));

const AgentSpawnOptionsListInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSpawnOptionsListInputBaseSchema, {
  serverId: z.optional(z.never()),
  probe: z.optional(AgentInventoryProbeInputSchema),
})).check(z.superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: "custom",
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
})));

/**
 * `sessions.spawn.profiles.list` is the one spawn-option source whose agent
 * scope is a FILTER, not a requirement.
 *
 * Models, config options and session modes cannot be enumerated without knowing
 * whose they are, so the shared schema demands an agent. A Launch Profile is the
 * other way round: `LaunchProfileListItemV1.supportedAgentIds` rides every row,
 * so an unscoped list loses no information, and a caller that selects a profile
 * FIRST — a Triage action does exactly that, and the profile then supplies the
 * agent — has no agent to scope by. Requiring one made that read fail input
 * validation, which the caller could only observe as "the catalog did not
 * answer": the selector stayed empty and every profile-configured press refused
 * forever.
 *
 * A contradictory pair is still refused, because half an agent scope is not a
 * weaker filter.
 */
const SpawnProfilesListInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(AgentSpawnOptionsListInputBaseSchema).check(z.superRefine((value, ctx) => {
    validateAgentIdAndBackendTargetKeySelection(value, ctx);
  })));

const AgentsConfigOptionsListInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSpawnOptionsListInputBaseSchema, {
  modelId: z.optional(z.string().check(z.minLength(1))),
  serverId: z.optional(z.never()),
  probe: z.optional(AgentInventoryProbeInputSchema),
})).check(z.superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: "custom",
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
})));

const SpawnConnectedServicesListInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(AgentSpawnOptionsListInputBaseSchema, {
  includeUnavailable: z.optional(z.boolean()),
  serverId: z.optional(z.never()),
})).check(z.superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: "custom",
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
})));

const SpawnMcpServersPreviewInputSchema = lazyZodSchema(() => z.looseObject({
  agentId: z.optional(z.string().check(z.minLength(1))),
  backendTargetKey: z.optional(z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema])),
  machineId: z.optional(z.string().check(z.minLength(1))),
  directory: z.optional(z.string().check(z.minLength(1))),
  path: z.optional(z.string().check(z.minLength(1))),
  selection: z.optional(SessionMcpSelectionV1Schema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
}).check(z.superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: "custom",
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
})));

const ActionSpecSearchInputSchema = lazyZodSchema(() => z.looseObject({
  query: z.optional(z.string().check(z.trim())),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
}));

const ActionSpecSearchCliInputSchema = lazyZodSchema(() => z.strictObject({
  query: z._default(z.array(z.string()), []),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
}));

const ActionSpecGetInputSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.minLength(1)),
  includeOutputSchema: z.optional(z.boolean()),
  schemaPath: z.optional(z.string().check(z.startsWith('/'))),
}));

const ActionSpecSearchResultSchema = lazyZodSchema(() => z.strictObject({
  actionSpecs: z.array(ActionDiscoveryDefinitionSummaryV1Schema),
}));

const ActionSpecGetResultSchema = lazyZodSchema(() => z.strictObject({
  actionSpec: ActionDiscoveryDefinitionV1Schema,
  schemaSections: z.optional(z.array(z.strictObject({ path: z.string(), description: z.string() }))),
  schemaSection: z.optional(z.strictObject({ path: z.string(), schema: z.record(z.string(), z.unknown()) })),
  invocationContext: z.optional(z.strictObject({
    sessionId: z.optional(z.string()),
    widgetSurface: z.optional(WidgetSurfaceRefV1Schema),
  })),
}));

const ActionOptionsResolveInputSchema = lazyZodSchema(() => z.looseObject({
  actionId: z.optional(z.string().check(z.minLength(1))),
  fieldPath: z.optional(z.string().check(z.minLength(1))),
  consumer: z.optional(InputOptionsConsumerV1Schema),
  optionsSourceId: z.optional(z.string().check(z.minLength(1))),
  sessionId: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  query: z.optional(z.string().check(z.trim())),
  values: z.optional(z.array(StrictJsonValueSchema)),
  draftInput: z.optional(z.record(z.string(), z.unknown())),
}).check(z.superRefine((value, ctx) => {
  const actionId = typeof value.actionId === 'string' ? value.actionId.trim() : '';
  const fieldPath = typeof value.fieldPath === 'string' ? value.fieldPath.trim() : '';
  const optionsSourceId = typeof value.optionsSourceId === 'string' ? value.optionsSourceId.trim() : '';
  if (!optionsSourceId && !(actionId && fieldPath) && !(value.consumer && fieldPath)) {
    ctx.addIssue({
      code: "custom",
      message: 'Provide actionId + fieldPath, consumer + fieldPath, or optionsSourceId',
      path: ['fieldPath'],
    });
  }
})));

const ActionOptionsResolveResultSchema = lazyZodSchema(() => z.strictObject({
  actionId: z.nullable(z.string().check(z.minLength(1))),
  fieldPath: z.nullable(z.string().check(z.minLength(1))),
  optionsSourceId: z.nullable(z.string().check(z.minLength(1))),
  options: z.readonly(z.array(ActionInputOptionSchema)),
  modelCatalog: z.optional(z.strictObject({
    nativeModels: z.readonly(z.array(z.strictObject({
      value: z.string().check(z.minLength(1)),
      label: ActionInputOptionSchema.shape.label,
      description: ActionInputOptionSchema.shape.description,
    }))),
    providerProjection: z.nullable(DaemonProviderModelProjectionResponseV1Schema._zod.def.options[0]),
  })),
}).check(z.superRefine((value, ctx) => {
  if (value.modelCatalog !== undefined
    && (value.actionId !== 'session.spawn_new' || value.fieldPath !== 'modelSelection')) {
    ctx.addIssue({ code: 'custom', path: ['modelCatalog'], message: 'Model catalog belongs to Session spawn model selection' });
  }
})));

/** Current-UI semantic payloads stay behind the ephemeral opaque command handle. */
const CurrentUiContextCommandInvokeInputSchema = lazyZodSchema(() => z.strictObject({
  commandId: z.string().check(z.trim(), z.minLength(1)),
}));

const SessionSendUserTextInputFieldsSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(SessionTargetV1Schema),
  recipient: PluginSessionUserTextAuthoredFieldSchemasV1.recipient,
  // The executor re-admits a plugin-bound input through this canonical shape
  // before dispatch. Keep the content rule here too: attachment-only is valid,
  // while the executor still rejects authored attachments from non-plugin
  // callers before the writer.
  message: z.string(),
  /** Raw Composer context; the target's existing input owner admits it before commit. */
  structuredInput: z.optional(RawIngressStructuredInputV1Schema),
  requestedAction: z.optional(PendingRequestedActionV1Schema),
  /**
   * The caller-retained stable identity for this durable input. Resubmitting
   * the same localId rejoins the existing pending input instead of queueing a
   * second message, so an ambiguous send can be retried safely. Plugin callers
   * cannot supply it: their identity is host-derived from `idempotencyKey`.
   */
  localId: z.optional(PendingLocalIdSchema),
  idempotencyKey: z.optional(PluginSessionUserTextAuthoredFieldSchemasV1.idempotencyKey),
  source: PluginSessionUserTextAuthoredFieldSchemasV1.source,
  attachments: PluginSessionUserTextAuthoredFieldSchemasV1.attachments,
  toolAnswerDelivery: PluginSessionUserTextAuthoredFieldSchemasV1.toolAnswerDelivery,
  permissionModeOverride: z.optional(z.string().check(z.trim(), z.minLength(1))),
  modelOverride: z.optional(z.union([z.string().check(z.trim(), z.minLength(1)), z.null()])),
  providerConnectionId: z.optional(z.nullable(ProviderConnectionIdSchema)),
  wait: z.optional(z.boolean()),
  reply: z.optional(z.enum(['none', 'wait', 'return'])),
  /** Exact destination for a person's Ask; never an Agent causal-turn assertion. */
  returnToSessionId: z.optional(asProtocolZod(SessionIdSchema)),
  timeoutSeconds: z.optional(z.number().check(z.int(), z.minimum(1))),
}));

function validateSessionSendProviderSelection(
  value: z.infer<typeof SessionSendUserTextInputFieldsSchema>,
  ctx: z.core.$RefinementCtx,
): void {
  if (value.reply !== undefined && value.wait !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['reply'], message: 'reply and legacy wait cannot be combined' });
  }
  if (value.returnToSessionId !== undefined && value.reply !== 'return') {
    ctx.addIssue({ code: 'custom', path: ['returnToSessionId'], message: 'A human return destination requires return reply mode' });
  }
  if (value.providerConnectionId === undefined) return;
  // A Provider connection is only ever applied together with the model
  // selection it sources. Without a `modelOverride` the send path composes no
  // selection at all, so the connection — including the explicit native `null`
  // — would be accepted and then silently discarded.
  if (value.modelOverride === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ['modelOverride'],
      message: 'modelOverride must be provided when providerConnectionId is set',
    });
    return;
  }
  if (value.providerConnectionId !== null && typeof value.modelOverride !== 'string') {
    ctx.addIssue({
      code: "custom",
      path: ['modelOverride'],
      message: 'modelOverride must be a concrete model id when providerConnectionId is set',
    });
  }
}

const SessionSendUserTextInputSchema = lazyZodSchema(() => SessionSendUserTextInputFieldsSchema.check(z.superRefine(requireSessionInputContent), z.superRefine(validateSessionSendProviderSelection)));

// Public callers author text and routing intent, never plugin source or attachment authority.
const SessionSendUserTextPublicInputSchema = lazyZodSchema(() => z.omit(SessionSendUserTextInputFieldsSchema, { idempotencyKey: true, source: true, attachments: true, toolAnswerDelivery: true }).check(z.superRefine(requireSessionInputContent), z.superRefine(validateSessionSendProviderSelection)));

/** Plugin Session messages carry only host-attributed admission intent. */
const SessionSendUserTextPluginInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
  // Blank only when an attachment carries the input, decided by the one
  // `requireSessionInputContent` owner this binding shares with
  // `PluginSessionInputRequestV1Schema`. A `.min(1)` here would let the Action
  // surface refuse an attachment-only input the seam beneath it admits.
  message: z.string(),
  ...PluginSessionUserTextAuthoredFieldSchemasV1,
  ...z.pick(SessionSendUserTextInputFieldsSchema, { reply: true, wait: true, timeoutSeconds: true }).shape,
}).check(z.superRefine(requireSessionInputContent), z.superRefine((value, ctx) => {
  if (value.reply !== undefined && value.wait !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['reply'], message: 'reply and legacy wait cannot be combined' });
  }
})));

const SessionSendSubagentLaunchPluginInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
  kind: z.literal('sessionSubagentLaunch'),
  launch: SubagentLaunchV1Schema,
  idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema,
}));

const SessionSendSubagentCommandInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
  kind: z.literal('sessionSubagentCommand'),
  command: SubagentCommandV1Schema,
  idempotencyKey: z.optional(PluginSessionInputIdempotencyKeyV1Schema),
  localId: z.optional(PendingLocalIdSchema),
}));

const SessionSendSubagentCommandPluginInputV1Schema = lazyZodSchema(() => z.extend(z.omit(SessionSendSubagentCommandInputSchema, { localId: true }), { idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema }));

const SessionSendMessagePublicInputSchema = lazyZodSchema(() => z.union([
  SessionSendUserTextPublicInputSchema,
  SessionSendSubagentCommandInputSchema,
]));

const SessionSendMessagePluginInputV1Schema = lazyZodSchema(() => z.union([
  SessionSendUserTextPluginInputV1Schema,
  SessionSendSubagentLaunchPluginInputV1Schema,
  SessionSendSubagentCommandPluginInputV1Schema,
]));

export const SessionSendMessageInputSchema = lazyZodSchema(() => z.union([
  SessionSendUserTextInputSchema,
  SessionSendSubagentLaunchPluginInputV1Schema,
  SessionSendSubagentCommandInputSchema,
]));
export type SessionMessageSendAuthoredInput = z.infer<typeof SessionSendMessageInputSchema>;

const SessionMessageReplyInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
  requestLocalId: PendingLocalIdSchema,
  reply: SessionMessageExplicitReplyV1Schema,
}));

const sessionExchangeControlInputArms = <TExtra extends z.core.$ZodShape>(extra: TExtra) => {
  const common = { sessionId: SessionTargetV1Schema, originInputLocalId: PendingLocalIdSchema,
    ...extra };
  return z.union([
    z.strictObject({ ...common, decision: z.literal('continue') }),
    z.strictObject({ ...common, decision: z.literal('continue_more'), additionalTurns: z.optional(z.literal(10)) }),
    z.strictObject({ ...common, decision: z.literal('stop') }),
  ]);
};
const SessionExchangeControlInputSchema = lazyZodSchema(() => sessionExchangeControlInputArms({
  observedRevision: z.optional(AutonomousExchangeObservedRevisionV1Schema),
}));
const SessionExchangeControlPublicInputSchema = lazyZodSchema(() => sessionExchangeControlInputArms({}));

const SessionPermissionRespondInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  decision: SessionPermissionRespondActionDecisionV1Schema,
  requestId: z.optional(z.string().check(z.minLength(1))),
  // Optional only at the released action compatibility boundary. Current UI
  // producers stamp it and current host requests require an exact match.
  turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  reason: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.reason,
  mode: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.mode,
  allowedTools: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.allowedTools,
  execPolicyAmendment: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.execPolicyAmendment,
  updatedPermissions: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.updatedPermissions,
  answers: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.answers,
}));

const SessionUserActionAnswerItemSchema = lazyZodSchema(() => z.strictObject({
  question: z.string().check(z.minLength(1), z.refine((value) => value.trim().length > 0, {
    message: 'question must not be blank',
  })),
  values: z.optional(z.array(z.string()).check(z.minLength(1))),
  // Compatibility for clients through the released 0.2.2 preview. Remove `answer`
  // after that preview leaves the supported mixed-version window.
  answer: z.optional(z.string().check(z.minLength(1))),
}).check(z.superRefine((value, ctx) => {
  if (value.answer !== undefined && value.values !== undefined) {
    ctx.addIssue({ code: "custom", message: 'answer and values cannot both be provided' });
  }
  if (value.answer === undefined && value.values === undefined) {
    ctx.addIssue({ code: "custom", message: 'answer or values is required' });
  }
})));

function validateSessionUserActionAnswer(
  value: Readonly<{
    decision?: 'approve' | 'reject' | 'request_changes';
    disposition?: 'pass_up';
    updatedPermissions?: unknown;
    reason?: string;
    answers?: readonly Readonly<{
      question: string;
      values?: readonly string[];
      answer?: string;
    }>[];
  }>,
  ctx: z.core.$RefinementCtx,
): void {
  if (value.disposition === 'pass_up') {
    if (value.decision !== undefined || value.answers !== undefined || value.updatedPermissions !== undefined
      || ['allowedTools', 'execPolicyAmendment', 'mode', 'approved'].some(key => Object.prototype.hasOwnProperty.call(value, key))) {
      ctx.addIssue({ code: 'custom', message: 'pass_up cannot include an answer or permission decision' });
    }
    return;
  }
  const hasAnswers = Array.isArray(value.answers) && value.answers.length > 0;
  const structuredAnswers = Object.create(null) as Record<string, readonly string[]>;
  for (const [index, entry] of (value.answers ?? []).entries()) {
    if (Object.prototype.hasOwnProperty.call(structuredAnswers, entry.question)) {
      ctx.addIssue({
        code: "custom",
        message: 'duplicate question',
        path: ['answers', index, 'question'],
      });
      continue;
    }
    structuredAnswers[entry.question] = entry.values ?? [entry.answer!];
  }
  if (hasAnswers && !StructuredQuestionAnswersV1Schema.safeParse(structuredAnswers).success) {
    ctx.addIssue({
      code: "custom",
      message: 'invalid structured answers',
      path: ['answers'],
    });
  }
  if (!hasAnswers && value.decision === undefined) {
    ctx.addIssue({
      code: "custom",
      message: 'decision or answers is required',
      path: ['decision'],
    });
  }
  if (value.decision === 'request_changes'
    && !(typeof value.reason === 'string' && value.reason.trim().length > 0)) {
    ctx.addIssue({
      code: "custom",
      message: 'reason is required when decision=request_changes',
      path: ['reason'],
    });
  }
}

const SessionUserActionAnswerInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  requestId: z.optional(z.string().check(z.minLength(1))),
  decision: z.optional(z.enum(['approve', 'reject', 'request_changes'])),
  disposition: z.optional(z.literal('pass_up')),
  reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
  answers: z.optional(z.array(SessionUserActionAnswerItemSchema).check(z.minLength(1))),
  updatedPermissions: z.optional(StrictJsonValueSchema),
}).check(z.superRefine(validateSessionUserActionAnswer)));

const SessionUserActionAnswerPluginInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(SessionTargetV1Schema),
  requestId: z.string().check(z.minLength(1)),
  decision: z.optional(z.enum(['approve', 'reject', 'request_changes'])),
  disposition: z.optional(z.literal('pass_up')),
  reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
  answers: z.optional(z.array(SessionUserActionAnswerItemSchema).check(z.minLength(1))),
}).check(z.superRefine(validateSessionUserActionAnswer)));

const SessionInteractionResponseSuccessSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
}));

const SessionModeSetInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  modeId: z.string(),
}));

const SessionControlSwitchInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  to: z.enum(['remote', 'local']),
}));
const SessionControlSwitchOutputSchema = lazyZodSchema(() => z.strictObject({ switched: z.literal(true) }));

const SessionConfigOptionSetInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  configId: z.string().check(z.trim(), z.minLength(1)),
  valueId: z.string(),
}));

const SessionConnectedServicesAuthSetInputSchema = lazyZodSchema(() => z.extend(SessionConnectedServiceAuthSwitchRpcParamsSchema, {
  machineId: z.string().check(z.trim(), z.minLength(1)),
  serverId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
}));

const SessionPrimaryTargetInputSchema = lazyZodSchema(() => z.union([
  VoiceTrackedSessionAddressV1Schema,
  z.strictObject({ sessionId: z.null() }),
]));

// Uncapped like the canonical Account Voice replace API it forwards to: a
// complete exact-Home replacement must reach the Follow owner and settle.
const SessionTrackedTargetsInputSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    sessionAddresses: z.array(VoiceTrackedSessionAddressV1Schema),
  }),
  // Released 0.2 clients sent Home-local ids. Keep this as an input-only
  // compatibility arm; the executing client must qualify them before mutation.
  z.strictObject({
    sessionIds: z.array(z.string().check(z.trim(), z.minLength(1))),
  }),
]));

/**
 * The one typed `session.list` caller contract. Exported so the Action executor parses the
 * admitted input through this owner instead of casting an untyped record into the listing
 * dependency's `SessionListQueryV1` parameter.
 */
export const SessionListActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  project: z.optional(QualifiedProjectKeyV1Schema),
  query: z.optional(z.lazy(() => SessionListQueryV1Schema)),
  underSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  view: z.optional(SessionListViewV1Schema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  includeLastMessagePreview: z.optional(z.boolean()),
  activeOnly: z.optional(z.boolean()),
  archivedOnly: z.optional(z.boolean()),
  includeSystem: z.optional(z.boolean()),
  resumableOnly: z.optional(z.boolean()),
  includeRows: z.optional(z.boolean()),
}).check(z.superRefine((value, ctx) => {
  if (value.query !== undefined) {
    for (const field of ['underSessionId', 'limit', 'cursor', 'activeOnly', 'archivedOnly', 'resumableOnly'] as const) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} cannot be combined with query` });
      }
    }
  }
  if (value.view === 'awareness' && Object.prototype.hasOwnProperty.call(value, 'includeLastMessagePreview')) {
    ctx.addIssue({ code: 'custom', path: ['includeLastMessagePreview'], message: 'Awareness does not include message previews' });
  }
})));

/**
 * The compatibility activity read shares `session.list`'s representation selector so Voice, agent,
 * MCP, UI and trusted plugin callers can ask this stable Action ID for canonical awareness instead
 * of reconstructing it. Omission keeps the released digest.
 */
const SessionActivityInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)),
  view: z.optional(SessionListViewV1Schema),
  windowSeconds: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(86_400))),
}).check(z.superRefine((value, ctx) => {
  if (value.view === SESSION_LIST_AWARENESS_VIEW_V1 && value.windowSeconds !== undefined) {
    // `windowSeconds` only narrows the released retained-window message counts, and awareness has
    // no counts. Accepting both would silently ignore the window the caller asked for.
    ctx.addIssue({
      code: 'custom',
      path: ['windowSeconds'],
      message: 'Awareness does not include retained-window message counts',
    });
  }
})));

const SessionRecentMessagesInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: SessionTargetV1Schema,
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  includeUser: z.optional(z.boolean()),
  includeAssistant: z.optional(z.boolean()),
  maxCharsPerMessage: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(50_000)))),
}));

const SessionLogTailInputSchema = lazyZodSchema(() => z.looseObject({
  path: z.string().check(z.minLength(1)),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1_000_000))),
  offset: z.optional(z.number().check(z.int(), z.minimum(0))),
}));

const TranscriptPageInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1_000_000))),
  maxItems: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
}));

const TranscriptReadAfterInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  cursor: z.string().check(z.minLength(1)),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1_000_000))),
  maxItems: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
}));

const TranscriptFollowInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TranscriptReadAfterInputSchema, {
  waitForChanges: z.optional(z.boolean()),
  leaseId: z.optional(z.string().check(z.minLength(1))),
  idleTtlMs: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(3_600_000))),
  projection: z.optional(z.literal('openedMessagesV1')),
  agentStateVersion: z.optional(z.number().check(z.int(), z.minimum(-1))),
  sharedMetadataVersion: z.optional(z.number().check(z.int(), z.minimum(-1))),
})));

const TranscriptUnfollowInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  leaseId: z.string().check(z.minLength(1)),
}));

const TranscriptImportInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  importId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  items: z.array(StrictJsonValueSchema).check(z.minLength(1), z.maxLength(500)),
  maxItems: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
}));

const TranscriptSearchInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  query: z.string().check(z.trim(), z.minLength(1)),
  cursor: z.optional(z.string().check(z.minLength(1))),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1_000_000))),
  maxItems: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
  maxReads: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50))),
}));

const TranscriptPageOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.optional(z.boolean()),
  items: z.array(StrictJsonValueSchema),
  nextCursor: z.nullable(z.string()),
  hasMore: z.optional(z.boolean()),
  tailCursor: z.optional(z.nullable(z.string())),
  truncated: z.boolean(),
}));

const TranscriptReadAfterOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.optional(z.boolean()),
  items: z.array(StrictJsonValueSchema),
  nextCursor: z.nullable(z.string()),
  truncated: z.boolean(),
}));

/** Closed authoritative version envelope; the opened Agent-native JSON is opaque preserved content. */
export const TranscriptOpenedAgentStateV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.number().check(z.int(), z.minimum(0)),
  value: z.nullable(z.record(z.string(), StrictJsonValueSchema)),
}));
export type TranscriptOpenedAgentStateV1 = z.infer<typeof TranscriptOpenedAgentStateV1Schema>;

/** Only the canonical recipient-safe metadata envelope may cross this opened read. */
export const TranscriptOpenedSharedMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.number().check(z.int(), z.minimum(0)),
  value: SessionSharedMetadataV1Schema,
}));
export type TranscriptOpenedSharedMetadataV1 = z.infer<typeof TranscriptOpenedSharedMetadataV1Schema>;

// Reuse the canonical row projection. Only its stored-content arm changes for this daemon-opened read.
const TranscriptOpenedMessageV1Schema = lazyZodSchema(() => z.union([
  z.extend(SessionMessageV1Schema, {
    content: z.extend(StrictSessionStoredMessageContentEnvelopeSchema._zod.def.options[1], {
      v: z.record(z.string(), StrictJsonValueSchema),
    }),
    openFailure: z.optional(z.never()),
  }),
  z.extend(SessionMessageV1Schema, {
    content: z.strictObject({ t: z.literal('plain'), v: z.null() }),
    openFailure: z.enum(['mode_mismatch', 'corrupt_or_unopenable']),
  }),
]));

/** Closed follow/cursor envelope; its canonical rows drop unknown presentation fields. */
export const TranscriptFollowChangeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('append') }),
  z.strictObject({ kind: z.literal('revision'), messageId: z.string().check(z.minLength(1)), seq: z.number().check(z.int(), z.minimum(1)) }),
  z.strictObject({ kind: z.literal('session') }),
  z.strictObject({ kind: z.literal('reset') }),
]));
export type TranscriptFollowChangeV1 = z.infer<typeof TranscriptFollowChangeV1Schema>;

export const TranscriptOpenedFollowOutputV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  leaseId: z.string().check(z.minLength(1)),
  projection: z.literal('openedMessagesV1'),
  items: z.array(TranscriptOpenedMessageV1Schema),
  nextCursor: z.nullable(z.string()),
  truncated: z.boolean(),
  agentState: z.nullable(TranscriptOpenedAgentStateV1Schema),
  sharedMetadata: z.nullable(TranscriptOpenedSharedMetadataV1Schema),
  changes: z.optional(z.array(TranscriptFollowChangeV1Schema)),
}));
export type TranscriptOpenedFollowOutputV1 = z.infer<typeof TranscriptOpenedFollowOutputV1Schema>;

const TranscriptFollowOutputSchema = lazyZodSchema(() => z.union([(<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(TranscriptReadAfterOutputSchema, {
  changes: z.optional(z.array(TranscriptFollowChangeV1Schema)),
  leaseId: z.optional(z.string().check(z.minLength(1))),
  projection: z.optional(z.never()),
})), TranscriptOpenedFollowOutputV1Schema]));

const TranscriptUnfollowOutputSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  released: z.boolean(),
}));

const TranscriptImportOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.boolean(),
  imported: z.optional(z.number().check(z.int(), z.minimum(0))),
  cursor: z.optional(z.nullable(z.string())),
}));

const SessionLogTailOutputSchema = lazyZodSchema(() => z.looseObject({
  success: z.optional(z.boolean()),
  ok: z.optional(z.boolean()),
  path: z.optional(z.string()),
  tail: z.optional(z.string()),
  truncated: z.optional(z.boolean()),
  error: z.optional(z.string()),
}));

const SubagentListInputSchema = lazyZodSchema(() => z.looseObject({
  parentSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  groupId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
}));

const SubagentGetInputSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  parentSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

const SubagentWatchInputSchema = lazyZodSchema(() => z.looseObject({
  parentSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  id: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

const SubagentStatusUpdateInputSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  parentSessionId: z.string().check(z.trim(), z.minLength(1)),
  status: SubagentStatusV1Schema,
  lifecycleDetail: z.optional(SubagentLifecycleDetailV1Schema),
  completedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
}));

const SubagentCompleteInputSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  parentSessionId: z.string().check(z.trim(), z.minLength(1)),
  status: z.optional(z.enum(['completed', 'failed', 'aborted'])),
  lifecycleDetail: z.optional(SubagentLifecycleDetailV1Schema),
  completedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
}));

const SubagentWatchSnapshotOutputSchema = lazyZodSchema(() => z.looseObject({
  kind: z.literal('snapshot'),
  subagents: z.array(SubagentRefV1Schema),
}));

const MemorySearchInputSchema = lazyZodSchema(() => z.looseObject({
  machineId: z.string().check(z.minLength(1)),
  query: MemorySearchQueryV1Schema,
}));

const MemoryMachineInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
}));
const SearchSettingsSetInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  settings: MemorySettingsV1Schema,
}));
export const SearchConversationsInputV1Schema = lazyZodSchema(() => z.strictObject({
  // Conversation fanout and Home search retain their existing scope contract.
  // Project memory is queried through one selected daemon's memory.search.
  query: z.safeExtend(MemorySearchQueryV1Schema, { scope: z.discriminatedUnion('type', [
    MemorySearchScopeSchema._zod.def.options[0], MemorySearchScopeSchema._zod.def.options[1],
  ]) }),
  machineIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  mode: z._default(z.enum(['auto', 'indexed', 'standard']), 'auto'),
  retryUnreachableMachines: z.optional(z.boolean()),
}));
export type SearchConversationsInputV1 = z.infer<typeof SearchConversationsInputV1Schema>;
export const ConversationSearchSourceFailureV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string(), agentId: z.string(), sourceKey: z.string(),
  errorCode: ExternalSessionsRpcErrorCodeSchema,
  retryable: z.boolean(),
}));
export type ConversationSearchSourceFailureV1 = z.infer<typeof ConversationSearchSourceFailureV1Schema>;
export const SearchConversationsResultV1Schema = lazyZodSchema(() => z.strictObject({
  hits: z.array(z.discriminatedUnion('mode', [
    z.strictObject({ machineId: z.nullable(z.string()), mode: z.literal('indexed'), hit: MemorySearchResultHitV1Schema }),
    z.strictObject({ machineId: z.string(), mode: z.literal('standard'), agentId: z.string(), sourceKey: z.string(),
      source: ExternalSessionsSourceSchema, candidate: ExternalSessionCandidateV1Schema }),
  ])),
  machines: z.array(z.strictObject({ machineId: z.string(), status: z.enum(['ok', 'offline', 'outdated', 'partial', 'disabled-by-settings']),
    standardSearchEnabled: z.optional(z.boolean()), documents: z.optional(MemoryDocumentSearchCoverageV1Schema.shape.state) })),
  sources: z.optional(z.array(z.strictObject({ machineId: z.string(), agentId: z.string(), sourceKey: z.string(),
    source: ExternalSessionsSourceSchema, contentSearch: z.boolean(), indexReady: z.optional(z.boolean()),
    key: z.optional(z.string()), label: z.optional(z.string()), detail: z.optional(z.string()),
  }))),
  homeStatus: z.optional(z.enum(['ok', 'partial', 'unavailable'])),
  failures: z.optional(z.array(ConversationSearchSourceFailureV1Schema)),
  continuations: z.optional(z.array(z.strictObject({ machineId: z.nullable(z.string()), sourceKey: z.optional(z.string()), cursor: z.string() }))),
  resetSources: z.optional(z.array(z.strictObject({ machineId: z.string(), sourceKey: z.string() }))),
  completedStandardSources: z.optional(z.array(z.strictObject({ machineId: z.string(), agentId: z.string(), sourceKey: z.string() }))),
}));
const MemoryClearIndexOutputSchema = lazyZodSchema(() => z.strictObject({ ok: z.literal(true) }));

const MemoryGetWindowInputSchema = lazyZodSchema(() => z.union([
  z.safeExtend(MemoryWindowRequestV1Schema._zod.def.options[0], { machineId: z.string().check(z.minLength(1)) }),
  z.safeExtend(MemoryWindowRequestV1Schema._zod.def.options[1], { machineId: z.string().check(z.minLength(1)) }),
]));

const MemoryEnsureUpToDateInputSchema = lazyZodSchema(() => z.looseObject({
  machineId: z.string().check(z.minLength(1)),
  sessionId: z.optional(z.string().check(z.minLength(1))),
}));

const MemoryEnsureUpToDateOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.boolean(),
}));

const ApprovalRequestCreateInputSchema = lazyZodSchema(() => z.looseObject({
  actionId: ActionIdSchema,
  actionArgs: StrictJsonValueSchema,
  summary: z.string().check(z.minLength(1)),
  createdBy: ApprovalRequestCreatedBySchema,
  origin: z.optional(ApprovalRequestOriginV1Schema),
  preview: z.optional(StrictJsonValueSchema),
}));

/**
 * A trusted plugin may ask the present user to approve an Action it could have
 * invoked itself; it may not borrow the approval queue to reach a host-internal
 * Action the Plugin census excludes. The census set is built from these same
 * rows, so this arm resolves lazily instead of duplicating the exclusion list.
 */
const PluginSurfaceApprovalRequestCreateInputSchema = lazyZodSchema(() => z.extend(ApprovalRequestCreateInputSchema, {
  actionId: z.lazy(() => PluginInvocableActionIdSchema),
}));

const ApprovalRequestListInputSchema = lazyZodSchema(() => z.looseObject({
  status: z.optional(ApprovalRequestV2StatusSchema),
  actionId: z.optional(ActionIdSchema),
  cursor: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
}));

const ApprovalRequestGetInputSchema = lazyZodSchema(() => z.looseObject({
  artifactId: z.string().check(z.minLength(1)),
}));

const ApprovalRequestDecideInputSchema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string().check(z.minLength(1)),
  /** Exact Bot Session carrying the authenticated requester decision, not an execution target. */
  sessionId: z.optional(z.string().check(z.minLength(1))),
  decision: z.enum(['approve', 'reject', 'cancel']),
  /** Reduced input admitted by the requested Action's narrowing declaration. */
  narrowedInput: z.optional(StrictJsonValueSchema),
  /** Immutable creator-local id from the persisted V2 origin; never a route selector. */
  originServerId: z.optional(z.string().check(z.minLength(1))),
  /** Stable Home identity selected by the current device before exact-daemon routing. */
  serverIdentityId: z.optional(z.string().check(z.minLength(1))),
}));

const PromptDocUpdateInputSchema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string().check(z.minLength(1)),
  title: z.string().check(z.minLength(1)),
  markdown: z.string(),
  expectedRevision: z.optional(PromptDocRevisionV1Schema),
  ...PromptLibrarySaveOrganizationFieldsV1,
}).check(z.refine(isPromptLibrarySaveFolderAssignmentV1, { message: 'Folder assignment must match the reviewed folder creation' })));

const PromptRegistryInstallCanonicalInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  sourceId: z.string().check(z.minLength(1)),
  itemId: z.string().check(z.minLength(1)),
  installTarget: z.optional(z.strictObject({
    assetTypeId: z.string().check(z.minLength(1)),
    scope: PromptAssetScopeV1Schema,
    directory: z.optional(z.string().check(z.minLength(1))),
    targetName: z.string().check(z.minLength(1)),
    installMode: z.optional(PromptAssetInstallModeV1Schema),
  })),
}));

export const PromptRegistryInstallInputSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw: z.input<typeof PromptRegistryInstallCanonicalInputSchema>) => {
  // Released 0.2 stored inputs carried source declarations; current authority is the Account row.
  const { configuredSources: _legacyDeclarations, installTarget: _legacyNativeTarget, ...input } = readRecord(raw);
  return input;
}), PromptRegistryInstallCanonicalInputSchema));

const ExternalSessionTakeoverActionInputSchema = ExternalSessionTakeoverInputV1Schema;

type AssertNever<T extends never> = T;

const MANAGED_GITHUB_APP_ACTION_SPECS = MANAGED_GITHUB_APP_ACTION_IDS_V1.map(
  (id): PreNormalizedActionSpec => {
    const metadata: Readonly<Record<ManagedGitHubAppActionIdV1, Readonly<{
      title: string;
      description: string;
      safety: 'safe' | 'danger';
      sideEffectClass: 'read' | 'danger';
      cliPath: readonly string[];
    }>>> = {
      'identity.githubApps.list': {
        title: 'List managed GitHub Apps',
        description: 'List the managed GitHub App registrations visible to one Home or Team owner.',
        safety: 'safe',
        sideEffectClass: 'read',
        cliPath: ['identity', 'github-apps', 'list'],
      },
      'identity.githubApps.create': {
        title: 'Create managed GitHub App',
        description: 'Create a managed GitHub App registration for one Home or Team owner.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'create'],
      },
      'identity.githubApps.manifestSetup.start': {
        title: 'Start GitHub App manifest setup',
        description: 'Create a one-time GitHub.com App manifest handoff for one Home or Team owner.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'manifest-setup', 'start'],
      },
      'identity.githubApps.update': {
        title: 'Update managed GitHub App',
        description: 'Update a managed GitHub App registration and rotate its write-only secrets.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'update'],
      },
      'identity.githubApps.verifyInstallation': {
        title: 'Verify managed GitHub App installation',
        description: 'Verify and bind an exact GitHub App installation and organization.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'verify-installation'],
      },
      'identity.githubApps.remove': {
        title: 'Remove managed GitHub App installation',
        description: 'Remove an unused managed GitHub App installation at its current revision.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'remove'],
      },
    };
    const row = metadata[id];
    // `list` returns the already-redacted registration/installation projection
    // and is the one managed-App operation an automation caller may carry. Every
    // other row either accepts write-only App key material or answers with a
    // one-time browser handoff, so it stays on an authenticated human caller —
    // withholding the Agent tool surface alone would still leave the same spec
    // reachable to an API-token or trusted-plugin caller through the public ABI.
    const isSafeRead = id === 'identity.githubApps.list';
    return {
      id, approval: { result: 'required' },
      ...(['identity.githubApps.remove', 'identity.githubApps.create', 'identity.githubApps.manifestSetup.start',
        'identity.githubApps.verifyInstallation'].includes(id)
        ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
      ...(id === 'identity.githubApps.update' ? { approvalPolicy: {
        uiConfirmation: 'direct' as const,
        uiConfirmationForInput: (input: unknown) => {
          const parsed = MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1['identity.githubApps.update'].safeParse(input);
          // Metadata is reversible; replaced or cleared write-only keys cannot
          // be restored from the Home's redacted registration projection.
          return !parsed.success || Object.keys(parsed.data.patch.secrets ?? {}).length > 0;
        },
      } } : {}),
      title: row.title,
      description: row.description,
      safety: row.safety,
      requiredAuthority: isSafeRead ? 'account_automation' : 'present_user',
      executionPlacement: 'account',
      placements: [],
      surfaces: {
        ui: true,
        voice: false,
        agent: isSafeRead,
        mcp: false,
        cli: true,
        rpc: false,
      },
      sideEffectClass: row.sideEffectClass,
      inputSchema: MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1[id],
      outputSchema: MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1[id],
      inputHints: { fields: [] },
      // Registration and installation state belong to one exact Home. The
      // selector is required so credential lookup cannot borrow the device's
      // ambient active Home for a managed-identity secret owner.
      cli: {
        commands: [{ path: [...row.cliPath], visibility: 'canonical' }],
        acceptsServerId: true,
        requiresServerId: true,
      },
      // App private keys, client secrets and webhook secrets are write-only.
      // Observation reaches every installed plugin's after-hook, so the secret
      // arm is dropped here rather than at each observer.
      ...(id === 'identity.githubApps.create'
        ? { projectObservationInput: redactObservationInputPaths('secrets') }
        : {}),
      ...(id === 'identity.githubApps.update'
        ? { projectObservationInput: redactObservationInputPaths('patch.secrets') }
        : {}),
      // The manifest-setup link carries a one-time launch handle and the
      // installation verification answers with a live OAuth authorize URL plus
      // its attempt id. Both are scoped one-time browser credentials, so the
      // observation the executor hands to every installed plugin's after-hook
      // and to the durable approval record keeps only the fact that a handoff
      // was produced — the same projection the sibling provider-test and Admin
      // Portal handoffs use.
      ...(id === 'identity.githubApps.manifestSetup.start' || id === 'identity.githubApps.verifyInstallation'
        ? { projectObservationOutput: () => ({ redacted: true }) }
        : {}),
      serverTransport: { method: 'POST', path: MANAGED_GITHUB_APP_ACTION_PATHS_V1[id] },
    };
  },
);

const CHECKPOINT_SCOPE_INPUT_OPTIONS: ActionInputOption[] = [
  { value: 'conversation', label: 'Conversation' },
  { value: 'workspace', label: 'Workspace' },
];

const SESSION_VIEW_INPUT_OPTION_LABELS: Readonly<Record<SessionListViewV1, string>> = {
  [SESSION_LIST_SUMMARY_VIEW_V1]: 'Summary',
  [SESSION_LIST_AWARENESS_VIEW_V1]: 'Awareness',
};

/**
 * Every Session read that offers the representation selector offers the same values, derived from
 * the awareness contract that owns them. A spec listing its own literals would drift the moment
 * that enum changes.
 */
const SESSION_VIEW_INPUT_OPTIONS: ActionInputOption[] = SessionListViewV1Schema.options.map((view) => ({
  value: view,
  label: SESSION_VIEW_INPUT_OPTION_LABELS[view],
}));

const CHECKPOINT_SOURCE_INPUT_OPTIONS: ActionInputOption[] = [
  { value: 'provider', label: 'Provider' },
  { value: 'happier_scm', label: 'Happier SCM' },
  { value: 'composed', label: 'Composed' },
];

const REVIEW_COMMENT_ACTION_TITLES: Readonly<Record<ReviewCommentActionIdV1, string>> = Object.freeze({
  'reviews.comments.create': 'Create review comment',
  'reviews.comments.list': 'List review comments',
  'reviews.comments.get': 'Get review comment',
  'reviews.comments.transition': 'Transition review comment',
  'reviews.comments.edit': 'Edit review comment',
  'reviews.comments.reply': 'Reply to review comment',
  'reviews.comments.redact': 'Redact review comment',
  'reviews.comments.setDisposition': 'Set review comment disposition',
  'reviews.comments.attachEvidence': 'Attach review comment evidence',
  'reviews.comments.bulkTransition': 'Bulk transition review comments',
  'reviews.comments.claimPublicationDispatch': 'Claim review comment publication dispatch',
});

const REVIEW_COMMENT_ACTION_SDK_METHODS: Readonly<Record<ReviewCommentActionIdV1, string>> = Object.freeze({
  'reviews.comments.create': 'reviews.comments.create',
  'reviews.comments.list': 'reviews.comments.list',
  'reviews.comments.get': 'reviews.comments.get',
  'reviews.comments.transition': 'reviews.comments.transition',
  'reviews.comments.edit': 'reviews.comments.edit',
  'reviews.comments.reply': 'reviews.comments.reply',
  'reviews.comments.redact': 'reviews.comments.redact',
  'reviews.comments.setDisposition': 'reviews.comments.setDisposition',
  'reviews.comments.attachEvidence': 'reviews.comments.attachEvidence',
  'reviews.comments.bulkTransition': 'reviews.comments.bulkTransition',
  'reviews.comments.claimPublicationDispatch': 'reviews.comments.claimPublicationDispatch',
});

const REVIEW_COMMENT_ACTION_RPC_METHODS: Readonly<Record<ReviewCommentActionIdV1, string>> = Object.freeze({
  'reviews.comments.create': RPC_METHODS.REVIEW_COMMENTS_CREATE,
  'reviews.comments.list': RPC_METHODS.REVIEW_COMMENTS_LIST,
  'reviews.comments.get': RPC_METHODS.REVIEW_COMMENTS_GET,
  'reviews.comments.transition': RPC_METHODS.REVIEW_COMMENTS_TRANSITION,
  'reviews.comments.edit': RPC_METHODS.REVIEW_COMMENTS_EDIT,
  'reviews.comments.reply': RPC_METHODS.REVIEW_COMMENTS_REPLY,
  'reviews.comments.redact': RPC_METHODS.REVIEW_COMMENTS_REDACT,
  'reviews.comments.setDisposition': RPC_METHODS.REVIEW_COMMENTS_SET_DISPOSITION,
  'reviews.comments.attachEvidence': RPC_METHODS.REVIEW_COMMENTS_ATTACH_EVIDENCE,
  'reviews.comments.bulkTransition': RPC_METHODS.REVIEW_COMMENTS_BULK_TRANSITION,
  'reviews.comments.claimPublicationDispatch': RPC_METHODS.REVIEW_COMMENTS_CLAIM_PUBLICATION_DISPATCH,
});

const PluginSessionHookAgentPluginInputSchema = lazyZodSchema(() => z.strictObject({
  localId: asProtocolZod(PluginContributionLocalIdSchema),
}));
const PluginSessionHookStatusPluginInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('intent', [
  z.strictObject({
    intent: z.literal('passive_inventory'),
    agent: z.optional(PluginSessionHookAgentPluginInputSchema),
    cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(4_096))),
    limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS)), PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT),
  }),
  z.strictObject({
    intent: z.literal('install_preview'),
    agent: PluginSessionHookAgentPluginInputSchema,
  }),
  z.strictObject({
    intent: z.literal('installation_recheck'),
    agent: PluginSessionHookAgentPluginInputSchema,
    installationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  }),
]));
const PluginSessionHookInstallPluginInputV1Schema = lazyZodSchema(() => z.strictObject({
  agent: PluginSessionHookAgentPluginInputSchema,
  expectedPreviewId: z.string().check(z.regex(/^hook-install-preview:v1:[0-9a-f]{64}$/u)),
}));
const PluginSessionHookMutationPluginInputV1Schema = lazyZodSchema(() => z.strictObject({
  agent: PluginSessionHookAgentPluginInputSchema,
  installationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
}));

function bindPluginSessionHookAgent(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const caller = requirePluginBindingCaller(context);
  const input = z.looseObject({
    agent: z.optional(PluginSessionHookAgentPluginInputSchema),
  }).parse(value);
  return {
    ...input,
    ...(input.agent
      ? { agent: { pluginId: caller.pluginId, localId: input.agent.localId } }
      : {}),
  };
}

function projectPluginSessionHookStatus(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const caller = requirePluginBindingCaller(context);
  const response = PluginSessionHookStatusResponseV1Schema.parse(value);
  return response.ok
    ? {
        ...response,
        rows: response.rows.filter((row) => row.agent.pluginId === caller.pluginId),
      }
    : response;
}

const PluginSessionHookRpcSurfaceBinding = {
  inputSchema: PluginSessionHookStatusInputV1Schema,
  decodeInput: (value: unknown) => value,
  outputSchema: PluginSessionHookStatusResponseV1Schema,
  encodeOutput: (value: unknown) => value,
} as const;

const PLUGIN_PERMISSION_GRANT_ACTION_TITLES: Readonly<Record<PluginPermissionGrantActionIdV1, string>> = Object.freeze({
  'plugins.permissions.grants.list': 'List plugin permission grants',
  'plugins.permissions.grants.request': 'Request plugin permission grant',
  'plugins.permissions.grants.grant': 'Grant plugin permission',
  'plugins.permissions.grants.revoke': 'Revoke plugin permission',
  'plugins.permissions.grants.dismissRequest': 'Dismiss plugin permission request',
});

const PLUGIN_PERMISSION_GRANT_ACTION_RPC_METHODS: Readonly<Record<PluginPermissionGrantActionIdV1, string>> = Object.freeze({
  'plugins.permissions.grants.list': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_LIST,
  'plugins.permissions.grants.request': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_REQUEST,
  'plugins.permissions.grants.grant': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_GRANT,
  'plugins.permissions.grants.revoke': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_REVOKE,
  'plugins.permissions.grants.dismissRequest': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_DISMISS_REQUEST,
});

const PluginPermissionSubjectPluginInputSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  PluginPermissionSubjectV1Schema._zod.def.options[0],
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PluginPermissionSubjectV1Schema._zod.def.options[1], { contribution: true }), {
    contribution: z.strictObject({ localId: asProtocolZod(PluginContributionLocalIdSchema) }),
  })),
]));
const PluginPermissionGrantListPluginInputSchema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.list'], { pluginId: true, grantId: true, subject: true }), { subject: z.optional(PluginPermissionSubjectPluginInputSchema) })));
const PluginPermissionGrantRequestPluginInputSchema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.request'], {
    pluginId: true,
    requester: true,
    subject: true,
  }), { subject: PluginPermissionSubjectPluginInputSchema })));
const PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS = Object.freeze({
  'plugins.permissions.grants.list': PluginPermissionGrantListPluginInputSchema,
  'plugins.permissions.grants.request': PluginPermissionGrantRequestPluginInputSchema,
  'plugins.permissions.grants.revoke': PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.revoke'],
});

function requirePluginBindingCaller(context: ActionSurfaceBindingContext): Readonly<{
  kind: 'plugin';
  pluginId: string;
}> {
  if (context.caller.kind !== 'plugin') {
    throw new Error('plugin_surface_caller_required');
  }
  return context.caller;
}

function bindPluginSessionInteractionInput(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  requirePluginBindingCaller(context);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugin_session_interaction_input_invalid');
  }
  if ('sessionId' in value && value.sessionId !== undefined) return value;
  const sessionId = typeof context.defaultSessionId === 'string'
    ? context.defaultSessionId.trim()
    : '';
  if (!sessionId) throw new Error('plugin_current_session_required');
  return { ...value, sessionId };
}

function projectPluginSessionInteractionResponse(value: unknown): unknown {
  if (value === undefined || value === null) return { ok: true };
  const parsed = SessionInteractionResponseSuccessSchema.safeParse(value);
  if (!parsed.success) throw new Error('plugin_session_interaction_result_invalid');
  return parsed.data;
}

function bindPluginPermissionSubject(
  subject: z.infer<typeof PluginPermissionSubjectPluginInputSchema> | undefined,
  pluginId: string,
): unknown {
  if (!subject || subject.kind === 'general') return subject;
  return {
    ...subject,
    contribution: {
      pluginId,
      localId: subject.contribution.localId,
    },
  };
}

/**
 * The single vocabulary for the plugin scaffold's UI mode. Every surface that
 * accepts `--ui` (CLI parser, `plugins.scaffold` action input, scaffold engine,
 * and the Settings Create form) resolves the mode through this schema; no
 * consumer may enumerate a second mode list.
 *
 * `declarative` is first because it is the default a scaffold receives when the
 * author expresses no preference: a declarative surface is projected from the
 * manifest, so it needs no bundler, no UI dependency tree and no build step,
 * and a fresh plugin therefore renders its first surface on every platform
 * immediately. The executable arms are opt-in.
 */
export const PluginScaffoldUiModeSchema = lazyZodSchema(() => z.enum(['declarative', 'hostedWeb', 'reactNative']));
export type PluginScaffoldUiMode = z.infer<typeof PluginScaffoldUiModeSchema>;

/**
 * The mode a scaffold receives when the author expresses no preference. The
 * scaffold engine applies it and the Settings Create form preselects it, so the
 * command line and the app cannot start a plugin from different shapes.
 */
export const DEFAULT_PLUGIN_SCAFFOLD_UI_MODE: PluginScaffoldUiMode = 'declarative';

/** Optional first-party starting shape; omission retains the generic scaffold. */
export const PluginScaffoldTemplateSchema = lazyZodSchema(() => z.enum(['session-agent']));
export type PluginScaffoldTemplate = z.infer<typeof PluginScaffoldTemplateSchema>;

const PluginScaffoldActionInputSchema = lazyZodSchema(() => z.strictObject({
  targetDir: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  id: z.string().check(z.trim(), z.minLength(1)),
  name: z.string().check(z.trim(), z.minLength(1)),
  ui: z.optional(PluginScaffoldUiModeSchema),
  template: z.optional(PluginScaffoldTemplateSchema),
}));

const PluginLocalInstallActionInputSchema = lazyZodSchema(() => z.strictObject({
  path: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  kind: z.optional(z.enum(['path', 'archive', 'npm'])),
  selector: z.optional(z.string().check(z.trim(), z.minLength(1))),
  integrity: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sdkRegistryOrigin: z.optional(z.string().check(z.trim(), z.minLength(1))),
  dev: z.optional(z.boolean()),
  dryRun: z.optional(z.boolean()),
  force: z.optional(z.boolean()),
}));

const PluginMarketplaceInstallActionInputSchema = lazyZodSchema(() => z.strictObject({
  source: z.strictObject({
    kind: z.literal('marketplace'),
    sourceId: z.string().check(z.trim(), z.minLength(1)),
    pluginId: z.string().check(z.trim(), z.minLength(1)),
    version: z.string().check(z.trim(), z.minLength(1)),
    packageName: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
  machineId: z.string().check(z.trim(), z.minLength(1)),
}));

const PluginInstallActionInputSchema = lazyZodSchema(() => z.union([
  PluginLocalInstallActionInputSchema,
  PluginMarketplaceInstallActionInputSchema,
  z.strictObject({
    source: z.strictObject({ kind: z.literal('installed'), pluginId: z.string().check(z.trim(), z.minLength(1)) }),
    machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
]));

const PluginInstallCliInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.partial(PluginLocalInstallActionInputSchema), {
  sourceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  pluginId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  version: z.optional(z.string().check(z.trim(), z.minLength(1))),
  packageName: z.optional(z.string().check(z.trim(), z.minLength(1))),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
})));

const PluginUninstallActionInputSchema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
  deleteData: z.optional(z.boolean()),
}));

const PluginLifecycleActionInputSchema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
const PluginDisableActionInputSchema = lazyZodSchema(() => z.strictObject({
  ...PluginLifecycleActionInputSchema.shape,
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
}));
const PluginUpdatePolicyActionInputSchema = lazyZodSchema(() => z.strictObject({
  ...PluginLifecycleActionInputSchema.shape,
  policy: PluginUpdatePolicyV1Schema,
}));

const PluginReloadActionInputSchema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.trim(), z.minLength(1)),
}));

const PluginDevActionInputSchema = lazyZodSchema(() => z.strictObject({
  projectRoot: z.string().check(z.trim(), z.minLength(1)),
  sdkRegistryOrigin: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

const PluginAuthorActionInputSchema = lazyZodSchema(() => z.strictObject({
  projectRoot: z.string().check(z.trim(), z.minLength(1)),
  sdkRegistryOrigin: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

const PluginDoctorActionInputSchema = lazyZodSchema(() => z.strictObject({
  locator: z.string().check(z.trim(), z.minLength(1)),
}));

const PluginPackActionInputSchema = lazyZodSchema(() => z.strictObject({
  locator: z.string().check(z.trim(), z.minLength(1)),
  outPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sdkRegistryOrigin: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

const PluginListActionInputSchema = EmptyObjectSchema;

const PluginChangeStatusActionInputSchema = lazyZodSchema(() => z.strictObject({
  pendingChangeId: z.string().check(z.trim(), z.minLength(1)),
}));

const PluginDevLoopActionInputSchemas = {
  'plugins.scaffold': PluginScaffoldActionInputSchema,
  'plugins.install': PluginInstallActionInputSchema,
  'plugins.uninstall': PluginUninstallActionInputSchema,
  'plugins.enable': PluginLifecycleActionInputSchema,
  'plugins.disable': PluginDisableActionInputSchema,
  'plugins.rollback': PluginLifecycleActionInputSchema,
  'plugins.trust.forget': PluginLifecycleActionInputSchema,
  'plugins.update_policy.set': PluginUpdatePolicyActionInputSchema,
  'plugins.dev.submit': PluginDevActionInputSchema,
  'plugins.dev.unregister': lazyZodSchema(() => z.omit(PluginDevActionInputSchema, { sdkRegistryOrigin: true })),
  'plugins.dev.install': PluginAuthorActionInputSchema,
  'plugins.dev.typecheck': PluginAuthorActionInputSchema,
  'plugins.dev.build': PluginAuthorActionInputSchema,
  'plugins.dev.test': PluginAuthorActionInputSchema,
  'plugins.doctor': PluginDoctorActionInputSchema,
  'plugins.pack': PluginPackActionInputSchema,
  'plugins.reload': PluginReloadActionInputSchema,
  'plugins.list': PluginListActionInputSchema,
  'plugins.change.status': PluginChangeStatusActionInputSchema,
} as const satisfies Readonly<Record<PluginDevLoopActionIdV1, z.ZodMiniType>>;

const PluginDevLoopActionResultKindSchema = lazyZodSchema(() => z.enum([
  'plugins_scaffold',
  'plugins_install',
  'plugins_uninstall',
  'plugins_enable',
  'plugins_disable',
  'plugins_rollback',
  'plugins_trust_forget',
  'plugins_update_policy_set',
  'plugins_dev_submit',
  'plugins_dev_unregister',
  'plugins_dev_install',
  'plugins_dev_typecheck',
  'plugins_dev_build',
  'plugins_dev_test',
  'plugins_doctor',
  'plugins_pack',
  'plugins_reload',
  'plugins_list',
  'plugins_change_status',
]));

const PluginDevLoopPendingReviewSchema = lazyZodSchema(() => z.looseObject({
  kind: z.literal('reviewRequired'),
  reviewKind: z.enum(['projectTrust', 'installation']),
  pendingChangeId: z.string().check(z.trim(), z.minLength(1)),
  // The daemon/CLI change owner retains the review payload contract. Action
  // consumers receive it only as an opaque, nested projection.
  review: z.looseObject({}),
}));

const PluginDevLoopReviewRequiredActionOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.literal(false),
  kind: z.enum(['plugins_install', 'plugins_dev_submit', 'plugins_reload']),
  outcome: z.literal('reviewRequired'),
  // Public/headless callers receive the daemon candidate as one nested value.
  // A human UI host may retain the invocation through its existing private
  // review boundary; neither public input nor this envelope supplies consent.
  pendingReview: PluginDevLoopPendingReviewSchema,
  pendingChangeId: z.optional(z.never()),
  review: z.optional(z.never()),
}));

const PluginDevLoopChangeStatusActionOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.literal(true),
  kind: z.literal('plugins_change_status'),
  // Status is daemon-lifetime state owned by the CLI change client. Keep its
  // state/result payload opaque here instead of introducing a second owner.
  status: z.looseObject({}),
}));

const PluginDevLoopOrdinaryActionOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.boolean(),
  kind: z.enum(PluginDevLoopActionResultKindSchema.options.filter((value): value is Exclude<(typeof PluginDevLoopActionResultKindSchema.options)[number], 'plugins_change_status'> => !(['plugins_change_status'] as readonly string[]).includes(value))),
  // Only install currently emits an ordinary outcome. Keeping this bounded
  // prevents a review-required result from bypassing its typed envelope.
  outcome: z.optional(z.enum(['applied', 'failed'])),
  pendingReview: z.optional(z.never()),
  pendingChangeId: z.optional(z.never()),
  review: z.optional(z.never()),
}));

const PluginDevLoopActionOutputSchema = lazyZodSchema(() => z.union([
  PluginDevLoopReviewRequiredActionOutputSchema,
  PluginDevLoopChangeStatusActionOutputSchema,
  PluginDevLoopOrdinaryActionOutputSchema,
]));

const PLUGIN_DEV_LOOP_ACTION_TITLES: Readonly<Record<PluginDevLoopActionIdV1, string>> = Object.freeze({
  'plugins.scaffold': 'Scaffold plugin',
  'plugins.install': 'Install plugin',
  'plugins.uninstall': 'Uninstall plugin',
  'plugins.enable': 'Enable plugin',
  'plugins.disable': 'Disable plugin',
  'plugins.rollback': 'Roll back plugin',
  'plugins.trust.forget': 'Forget plugin trust',
  'plugins.update_policy.set': 'Set plugin update policy',
  'plugins.dev.submit': 'Start plugin development',
  'plugins.dev.unregister': 'Stop plugin development',
  'plugins.dev.install': 'Install plugin dependencies',
  'plugins.dev.typecheck': 'Typecheck plugin',
  'plugins.dev.build': 'Build plugin',
  'plugins.dev.test': 'Test plugin',
  'plugins.doctor': 'Diagnose plugin',
  'plugins.pack': 'Pack plugin',
  'plugins.reload': 'Reload plugin',
  'plugins.list': 'List plugins',
  'plugins.change.status': 'Get plugin change status',
});

const PLUGIN_DEV_LOOP_ACTION_DESCRIPTIONS: Readonly<Record<PluginDevLoopActionIdV1, string>> = Object.freeze({
  'plugins.scaffold': 'Create a local plugin scaffold from the first-party template.',
  'plugins.install': 'Request approval to install and trust an exact marketplace or local plugin; the daemon retains custody of the install effect.',
  'plugins.uninstall': 'Remove a plugin installed from a local folder on a machine.',
  'plugins.enable': 'Enable an installed and trusted plugin through its machine lifecycle owner.',
  'plugins.disable': 'Disable an installed plugin, preserving the daemon’s retained-resource review.',
  'plugins.rollback': 'Restore the previous installed plugin version through its machine lifecycle owner.',
  'plugins.trust.forget': 'Remove the machine’s retained trust for an installed plugin.',
  'plugins.update_policy.set': 'Change whether an installed plugin admits explicit updates.',
  'plugins.dev.submit': 'Register a local plugin source with the daemon-owned development cycle, which watches and applies source changes.',
  'plugins.dev.unregister': 'Unregister an exact explicit source root from the daemon-owned development cycle.',
  'plugins.dev.install': 'Prepare external plugin-author dependencies through the managed runtime.',
  'plugins.dev.typecheck': 'Run the managed TypeScript check for an external plugin-author source.',
  'plugins.dev.build': 'Build an external plugin-author source through the managed runtime.',
  'plugins.dev.test': 'Run the external plugin-author test command through the managed runtime.',
  'plugins.doctor': 'Evaluate and diagnose an external plugin-author source.',
  'plugins.pack': 'Validate and package a local plugin into an installable archive.',
  'plugins.reload': 'Load a plugin you are developing again, so your latest changes take effect.',
  'plugins.list': 'List installed plugins plus daemon-owned pending changes with the issued ids needed to rejoin them.',
  'plugins.change.status': 'Read one daemon-issued pending plugin change without creating or deciding it.',
});

/**
 * What a present user is confirming, named by the exact source or plugin it acts on. Without it the
 * confirmation fell back to the Action title and asked "Submit plugin development snapshot." about
 * a folder it never named.
 */
const PLUGIN_DEV_LOOP_APPROVAL_SUMMARIES: Readonly<Partial<Record<PluginDevLoopActionIdV1, (subject: string) => string>>> = Object.freeze({
  'plugins.scaffold': (subject) => `Create a new plugin in ${subject}`,
  'plugins.uninstall': (subject) => `Remove ${subject} from this machine`,
  'plugins.trust.forget': (subject) => `Forget this machine’s trust for ${subject}`,
  'plugins.dev.submit': (subject) => `Build and run the plugin in ${subject}, and reload it whenever its files change`,
  'plugins.dev.unregister': (subject) => `Stop developing the plugin in ${subject}`,
  'plugins.dev.install': (subject) => `Install the dependencies of the plugin in ${subject}`,
  'plugins.dev.typecheck': (subject) => `Typecheck the plugin in ${subject}`,
  'plugins.dev.build': (subject) => `Build the plugin in ${subject}`,
  'plugins.dev.test': (subject) => `Run the tests of the plugin in ${subject}`,
  'plugins.doctor': (subject) => `Diagnose the plugin in ${subject}`,
  'plugins.pack': (subject) => `Package the plugin in ${subject} into an installable archive`,
  'plugins.reload': (subject) => `Reload ${subject} so its latest changes take effect`,
});

function readPluginDevLoopApprovalSubject(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  for (const key of ['projectRoot', 'locator', 'targetDir', 'pluginId'] as const) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function createPluginDevLoopActionSpec(actionId: PluginDevLoopActionIdV1): PreNormalizedActionSpec {
  const describeApproval = PLUGIN_DEV_LOOP_APPROVAL_SUMMARIES[actionId];
  const isRead = actionId === 'plugins.list' || actionId === 'plugins.change.status';
  const isLifecycle = actionId === 'plugins.enable' || actionId === 'plugins.disable' || actionId === 'plugins.rollback'
    || actionId === 'plugins.trust.forget' || actionId === 'plugins.update_policy.set';
  const isInspectorUiAction = actionId === 'plugins.list'
    || actionId === 'plugins.scaffold'
    || actionId === 'plugins.uninstall'
    || isLifecycle
    || actionId === 'plugins.install'
    || actionId === 'plugins.reload'
    || actionId === 'plugins.change.status'
    || actionId === 'plugins.dev.submit'
    || actionId === 'plugins.dev.unregister'
    || actionId === 'plugins.dev.test'
    || actionId === 'plugins.pack';
  const inputSchema = PluginDevLoopActionInputSchemas[actionId];

  return {
    id: actionId, approval: isRead
      ? { result: 'required' }
      : { result: 'optional', flow: 'deferred' },
    title: PLUGIN_DEV_LOOP_ACTION_TITLES[actionId],
    ...(actionId === 'plugins.uninstall' ? { confirmVerb: { key: 'settingsPlugins.uninstall', fallback: 'Uninstall' }, irreversible: true as const }
      : actionId === 'plugins.trust.forget' ? { confirmVerb: { key: 'settingsPlugins.forgetTrust', fallback: 'Forget trust' }, irreversible: true as const }
        : actionId === 'plugins.install' ? { confirmVerb: { key: 'common.install', fallback: 'Install' } } : {}),
    description: PLUGIN_DEV_LOOP_ACTION_DESCRIPTIONS[actionId],
    ...(describeApproval ? { approvalPresentation: { summary: (input: unknown) => {
      const subject = readPluginDevLoopApprovalSubject(input);
      return subject ? describeApproval(subject) : null;
    } } } : {}),
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    bindings: {
      mcpToolName: actionId.replaceAll('.', '_'),
    },
    surfaces: {
      ui: isInspectorUiAction,
      ...(actionId === 'plugins.install' ? { api: false } : {}),
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    sideEffectClass: actionId === 'plugins.uninstall' || actionId === 'plugins.trust.forget' ? 'danger' : isRead ? 'read' : 'write',
    ...(actionId === 'plugins.reload' || actionId === 'plugins.scaffold' || isLifecycle && actionId !== 'plugins.trust.forget'
      ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    ...(actionId === 'plugins.uninstall' || actionId === 'plugins.trust.forget' ? { approvalPolicy: { uiConfirmation: 'policy' as const } } : {}),
    ...(actionId === 'plugins.install' ? {
      // Install & Trust defaults to one ordinary approval Artifact on every
      // caller surface; users can change that policy through Action settings.
      approvalPolicy: {
        uiConfirmation: 'policy' as const,
      },
      cli: {
        acceptsServerId: true as const,
        commands: [
          { path: ['plugins', 'install'], positionals: ['path'], visibility: 'canonical' as const },
          { path: ['plugins', 'update'], positionals: ['pluginId'], visibility: 'alias' as const },
          { path: ['plugins', 'marketplace', 'install'], positionals: ['sourceId', 'pluginId'], visibility: 'alias' as const },
        ],
        inputSchema: PluginInstallCliInputSchema,
        flagAliases: [{ path: 'sdkRegistryOrigin', aliases: ['--sdk-registry'] }, { path: 'packageName', aliases: ['--package'] }, { path: 'machineId', aliases: ['--machine'] }],
        bindInput: (value: unknown, context: ActionCliBindContext) => {
          const input = PluginInstallCliInputSchema.parse(value);
          if (context.commandPath?.[1] === 'update') {
            if (!input.pluginId || input.path !== undefined || input.sourceId !== undefined || input.version !== undefined
              || input.packageName !== undefined || input.kind !== undefined || input.dev !== undefined || input.dryRun !== undefined
              || input.force !== undefined || input.selector !== undefined || input.integrity !== undefined || input.sdkRegistryOrigin !== undefined) {
              throw new Error('Plugin updates accept an installed plugin id and optional Machine selection.');
            }
            return { source: { kind: 'installed', pluginId: input.pluginId }, ...(input.machineId ? { machineId: input.machineId } : {}) };
          }
          if (context.commandPath?.includes('marketplace')) {
            if (input.path !== undefined || input.kind !== undefined || input.dev !== undefined
              || input.dryRun !== undefined || input.force !== undefined || input.selector !== undefined
              || input.integrity !== undefined || input.sdkRegistryOrigin !== undefined) {
              throw new Error('Marketplace installs accept an exact source, plugin, version and Machine selection.');
            }
            return { machineId: input.machineId, source: {
              kind: 'marketplace', sourceId: input.sourceId, pluginId: input.pluginId, version: input.version,
              ...(input.packageName ? { packageName: input.packageName } : {}),
            } };
          }
          if (input.sourceId !== undefined || input.pluginId !== undefined || input.version !== undefined || input.packageName !== undefined) {
            throw new Error('Marketplace listing fields require plugins marketplace install.');
          }
          const { sourceId: _sourceId, pluginId: _pluginId, version: _version, packageName: _packageName, ...local } = input;
          if (!local.kind && local.path) {
            let archivePath = local.path;
            try { archivePath = new URL(local.path).pathname; } catch { /* Local paths have no URL pathname. */ }
            if (/\.(?:tar\.gz|tgz|tar\.xz|zip)$/iu.test(archivePath)) return { ...local, kind: 'archive' };
          }
          return local;
        },
      },
    } : actionId === 'plugins.uninstall' ? {
      cli: {
        acceptsServerId: true as const,
        commands: [{ path: ['plugins', 'uninstall'], positionals: ['pluginId'], visibility: 'canonical' as const }],
        inputSchema: lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginUninstallActionInputSchema, { yes: z.optional(z.boolean()) }))),
        flagAliases: [{ path: 'yes', aliases: ['-y'] }],
        bindInput: (value: unknown) => {
          const input = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginUninstallActionInputSchema, { yes: z.optional(z.boolean()) }))).parse(value);
          if (input.deleteData && !input.yes) throw new Error('Destructive plugin data removal requires --yes confirmation.');
          const { yes: _yes, ...canonical } = input;
          return canonical;
        },
      },
    } : isLifecycle ? {
      cli: {
        acceptsServerId: true as const,
        commands: [{ path: actionId.split('.').map(segment => segment.replaceAll('_', '-')), positionals: ['pluginId'], visibility: 'canonical' as const }],
        flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
      },
    } : {}),
    outputSchema: PluginDevLoopActionOutputSchema,
    inputSchema,
    inputHints: { fields: actionId === 'plugins.install' ? [
      { path: 'source', title: 'Source', widget: 'json' },
      { path: 'path', title: 'Local path or package', widget: 'text' },
      { path: 'machineId', title: 'Machine', widget: 'text' },
      { path: 'kind', title: 'Install from', widget: 'select', options: [
        { value: 'path', label: 'Local folder' }, { value: 'archive', label: 'Archive' }, { value: 'npm', label: 'npm package' },
      ] },
      { path: 'selector', title: 'Package selection', widget: 'text' },
      { path: 'integrity', title: 'Integrity', widget: 'text' },
      { path: 'sdkRegistryOrigin', title: 'SDK registry', widget: 'url' },
      { path: 'dev', title: 'Development install', widget: 'boolean' },
      { path: 'dryRun', title: 'Preview only', widget: 'boolean' },
      { path: 'force', title: 'Replace existing install', widget: 'boolean' },
    ] : [] },
  };
}

const PLUGIN_SETTINGS_ADMINISTRATION_ACTION_TITLES: Readonly<Record<
  PluginSettingsAdministrationActionIdV1,
  string
>> = Object.freeze({
  'plugins.settings.list': 'List plugin settings',
  'plugins.settings.get': 'Get plugin setting',
  'plugins.settings.set': 'Set plugin setting',
  'plugins.settings.reset': 'Reset plugin setting',
  'plugins.settings.secret.status': 'Get plugin secret status',
  'plugins.settings.secret.bind': 'Bind existing saved secret',
  'plugins.settings.secret.unbind': 'Unbind plugin secret',
  'plugins.settings.secret.delete': 'Delete plugin secret',
});

const PLUGIN_SETTINGS_ADMINISTRATION_ACTION_DESCRIPTIONS: Readonly<Record<
  PluginSettingsAdministrationActionIdV1,
  string
>> = Object.freeze({
  'plugins.settings.list': 'List declared plugin Settings for one exact Account or daemon scope.',
  'plugins.settings.get': 'Read one declared non-secret plugin Setting from one exact scope.',
  'plugins.settings.set': 'Compare-and-set one declared non-secret plugin Setting.',
  'plugins.settings.reset': 'Reset one declared non-secret plugin Setting to its owner default.',
  'plugins.settings.secret.status': 'Read safe configured status for one declared plugin secret.',
  'plugins.settings.secret.bind': 'Bind one plugin secret to an existing SavedSecret identity without exposing its value.',
  'plugins.settings.secret.unbind': 'Remove the binding for one plugin secret without exposing its value.',
  'plugins.settings.secret.delete': 'Delete one plugin secret through its declared custody owner without exposing its value.',
});

function createPluginSettingsAdministrationActionSpec(
  actionId: PluginSettingsAdministrationActionIdV1,
): PreNormalizedActionSpec {
  const isRead = actionId === 'plugins.settings.list'
    || actionId === 'plugins.settings.get'
    || actionId === 'plugins.settings.secret.status';
  const isSecretMutation = !isRead && actionId.startsWith('plugins.settings.secret.');
  const isReversibleUiMutation = actionId === 'plugins.settings.set'
    || actionId === 'plugins.settings.secret.bind'
    || actionId === 'plugins.settings.secret.unbind';

  return {
    id: actionId, approvalPolicy: { uiConfirmation: isReversibleUiMutation ? 'direct' : 'policy', retainUiFieldIntent: true }, approval: isRead ? { result: 'required' } : { result: 'none' },
    title: PLUGIN_SETTINGS_ADMINISTRATION_ACTION_TITLES[actionId],
    ...(actionId === 'plugins.settings.secret.delete'
      ? { confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true as const } : {}),
    description: PLUGIN_SETTINGS_ADMINISTRATION_ACTION_DESCRIPTIONS[actionId],
    safety: isRead ? 'safe' : 'danger',
    executionPlacementForInput: (input: unknown) => resolvePluginSettingsAdministrationTargetV1(actionId, input).kind === 'account'
      ? 'account' : 'machine',
    bindings: { mcpToolName: actionId.replaceAll('.', '_') },
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      ...(isSecretMutation ? { api: false as const } : {}),
    },
    sideEffectClass: isRead ? 'read' : 'write',
    outputSchema: PluginSettingsAdministrationActionOutputV1Schema,
    inputSchema: PluginSettingsAdministrationActionInputSchemasV1[actionId],
    ...(actionId === 'plugins.settings.set' ? { projectObservationInput: (input: unknown) => {
      const { value: _privateValue, ...safeInput } = readRecord(input);
      return safeInput;
    } } : {}),
    inputHints: { fields: [] },
  };
}

/** What a person reads in Settings, approvals and the form. Agents read `description`. */
const PLUGIN_PERMISSION_GRANT_ACTION_SUMMARIES: Readonly<Record<PluginPermissionGrantActionIdV1, string>> = Object.freeze({
  'plugins.permissions.grants.list': 'See which optional permissions you have given your plugins.',
  'plugins.permissions.grants.request': 'Have a plugin ask you for an optional permission. Nothing is allowed until you say yes.',
  'plugins.permissions.grants.grant': 'Give a plugin an optional permission it asked for.',
  'plugins.permissions.grants.revoke': 'Take back an optional permission you gave a plugin.',
  'plugins.permissions.grants.dismissRequest': 'Close a plugin\'s permission request without allowing it.',
});

function createPluginPermissionGrantActionSpec(actionId: PluginPermissionGrantActionIdV1): PreNormalizedActionSpec {
  const isRead = actionId === 'plugins.permissions.grants.list';
  const isRevoke = actionId === 'plugins.permissions.grants.revoke';
  const pluginBinding = actionId === 'plugins.permissions.grants.list'
    ? {
        inputSchema: PluginPermissionGrantListPluginInputSchema,
        bindInput(value: unknown, context: ActionSurfaceBindingContext) {
          const caller = requirePluginBindingCaller(context);
          const input = value as z.infer<typeof PluginPermissionGrantListPluginInputSchema>;
          return {
            ...input,
            pluginId: caller.pluginId,
            ...(input.subject
              ? { subject: bindPluginPermissionSubject(input.subject, caller.pluginId) }
              : {}),
          };
        },
      }
    : actionId === 'plugins.permissions.grants.request'
      ? {
          inputSchema: PluginPermissionGrantRequestPluginInputSchema,
          bindInput(value: unknown, context: ActionSurfaceBindingContext) {
            const caller = requirePluginBindingCaller(context);
            const input = value as z.infer<typeof PluginPermissionGrantRequestPluginInputSchema>;
            return {
              ...input,
              pluginId: caller.pluginId,
              subject: bindPluginPermissionSubject(input.subject, caller.pluginId),
              requester: {
                kind: 'plugin' as const,
                pluginId: caller.pluginId,
                ...(context.defaultSessionId ? { sessionId: context.defaultSessionId } : {}),
              },
            };
          },
        }
      : actionId === 'plugins.permissions.grants.revoke'
        ? {
            inputSchema: PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS[actionId],
          }
        : undefined;
  return {
    id: actionId, approval: isRead ? { result: 'required' }
      : isRevoke ? { result: 'optional', flow: 'deferred' } : { result: 'none' },
    title: PLUGIN_PERMISSION_GRANT_ACTION_TITLES[actionId],
    description: 'Manage durable user-approved optional plugin permission grants.',
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    bindings: {
      rpcMethod: PLUGIN_PERMISSION_GRANT_ACTION_RPC_METHODS[actionId],
      sdkMethod: actionId,
    },
    ...(pluginBinding ? { surfaceBindings: { plugin: pluginBinding } } : {}),
    surfaces: {
      ui: true,
      voice: false,
      agent: isRead || isRevoke,
      mcp: isRead || isRevoke,
      cli: false,
      rpc: true,
    },
    sideEffectClass: isRead ? 'read' : 'write',
    outputSchema: PluginPermissionGrantActionOutputSchemasV1[actionId],
    inputSchema: PluginPermissionGrantActionInputSchemasV1[actionId],
    inputHints: { description: PLUGIN_PERMISSION_GRANT_ACTION_SUMMARIES[actionId], fields: [] },
  };
}

const PLUGIN_WEBHOOK_ACTION_TITLES: Readonly<Record<PluginWebhookActionIdV1, string>> = Object.freeze({
  'plugin.webhook.endpoint.ensure': 'Ensure webhook endpoint',
  'plugin.webhook.endpoint.read': 'Read webhook endpoint',
  'plugin.webhook.endpoint.revoke': 'Revoke webhook endpoint',
  'plugin.webhook.endpoint.retarget': 'Retarget webhook endpoint',
  'plugin.webhook.endpoint.checkCorrespondence': 'Check webhook endpoint correspondence',
  'plugin.webhook.endpoint.convergeTarget': 'Converge webhook endpoint target',
  'plugin.webhook.delivery.movePending': 'Move pending webhook deliveries',
  'plugin.webhook.delivery.replay': 'Replay webhook delivery',
  'plugin.webhook.delivery.discard': 'Discard webhook delivery',
  'plugin.webhook.endpoint.credential.configure': 'Configure webhook credential',
  'plugin.webhook.endpoint.credential.rotate': 'Rotate webhook credential',
  'plugin.webhook.endpoint.credential.finishRotation': 'Finish webhook credential rotation',
});

function createPluginWebhookActionSpec(actionId: PluginWebhookActionIdV1): PreNormalizedActionSpec {
  // A plugin-surface endpoint operation is never offered on a present-user
  // surface: the caller identity it authorizes against is host-stamped plugin
  // provenance, which a `ui`/`cli` invocation cannot supply.
  const isPluginSurface = isPluginWebhookPluginSurfaceActionIdV1(actionId);
  const readOnly = actionId === 'plugin.webhook.endpoint.read'
    || actionId === 'plugin.webhook.endpoint.checkCorrespondence';
  const automationDeliveryControl = actionId === 'plugin.webhook.delivery.replay'
    || actionId === 'plugin.webhook.delivery.discard' || actionId === 'plugin.webhook.delivery.movePending';
  return {
    id: actionId, approval: readOnly || actionId === 'plugin.webhook.endpoint.ensure'
      || automationDeliveryControl
      ? { result: 'required' } : { result: 'none' },
    ...(automationDeliveryControl
      ? { requiredAuthority: 'account_automation' as const, approvalPolicy: { uiConfirmation: 'policy' as const } } : {}),
    title: PLUGIN_WEBHOOK_ACTION_TITLES[actionId],
    description: 'Manage one Account-owned webhook endpoint through the canonical Webhook ingress owner.',
    executionPlacement: 'account',
    safety: readOnly ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: !isPluginSurface,
      voice: false,
      agent: automationDeliveryControl,
      mcp: automationDeliveryControl,
      cli: !isPluginSurface,
      rpc: false,
      ...(actionId === 'plugin.webhook.delivery.movePending' ? { api: false } : {}),
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: PluginWebhookActionOutputSchemasV1[actionId],
    ...(actionId === 'plugin.webhook.endpoint.ensure' ? {
      approvalResultCustody: 'live_only' as const,
      projectObservationOutput: (output: unknown) => {
        const result = PluginWebhookEndpointEnsureResultV1Schema.parse(output);
        return {
          webhookEndpointId: result.webhookEndpointId,
          revision: result.revision,
          publicUrl: result.publicUrl,
          readiness: result.readiness,
        };
      },
    } : {}),
    inputSchema: PluginWebhookActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
    serverTransport: {
      method: 'POST',
      path: isPluginWebhookPluginSurfaceActionIdV1(actionId)
        ? PluginWebhookPluginSurfaceActionHttpPathsV1[actionId]
        : PluginWebhookActionHttpPathsV1[actionId],
    },
  };
}

const AUTOMATION_EVENT_ACTION_TITLES: Readonly<Record<AutomationEventActionIdV1, string>> = Object.freeze({
  'automation.event.sources.list': 'List Automation Event sources',
  'automation.event.admit': 'Admit Automation Event occurrence',
  'automation.event.source.status.report': 'Report Automation Event source status',
});

function createAutomationEventActionSpec(actionId: AutomationEventActionIdV1): PreNormalizedActionSpec {
  const readOnly = actionId === 'automation.event.sources.list';
  return {
    id: actionId, approval: { result: 'none' },
    title: AUTOMATION_EVENT_ACTION_TITLES[actionId],
    description: 'Read or update Event Automation state through the canonical Automation owner.',
    // Source telemetry records the admitted runtime's health, not a user
    // effect. Event admission retains its ordinary configurable confirmation.
    safety: readOnly || actionId === 'automation.event.source.status.report' ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: AutomationEventActionOutputSchemasV1[actionId],
    inputSchema: AutomationEventActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

const AUTOMATION_CONVERSATION_ACTION_TITLES: Readonly<
  Record<AutomationConversationActionIdV1, string>
> = Object.freeze({
  'automation.conversation.targets.list': 'List Automation conversation targets',
  'automation.conversation.target.verify': 'Verify Automation conversation target',
  'automation.conversation.admit': 'Admit Automation conversation occurrence',
});

function createAutomationConversationActionSpec(
  actionId: AutomationConversationActionIdV1,
): PreNormalizedActionSpec {
  const readOnly = actionId === 'automation.conversation.targets.list'
    || actionId === 'automation.conversation.target.verify';
  const description = actionId === 'automation.conversation.targets.list'
    ? 'List current selectable Automation conversation targets through the canonical Automation owner.'
    : readOnly
      ? 'Verify an Automation conversation target through the canonical Automation owner.'
      : 'Admit a conversation occurrence through the canonical Automation owner.';
  return {
    id: actionId, approval: { result: 'none' },
    title: AUTOMATION_CONVERSATION_ACTION_TITLES[actionId],
    description,
    safety: readOnly ? 'safe' : 'danger',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: readOnly ? 'read' : 'write',
    outputSchema: AutomationConversationActionOutputSchemasV1[actionId],
    inputSchema: AutomationConversationActionInputSchemasV1[actionId],
    inputHints: { fields: [] },
  };
}

/** What a person reads in Settings, approvals and the form. Agents read `description`. */
const REVIEW_COMMENT_ACTION_SUMMARIES: Readonly<Record<ReviewCommentActionIdV1, string>> = Object.freeze({
  'reviews.comments.create': 'Add a comment to a review, on a line or on the whole change.',
  'reviews.comments.list': 'See the comments on a review.',
  'reviews.comments.get': 'Read one review comment and its replies.',
  'reviews.comments.transition': 'Move a review comment along, for example from proposed to open, or to resolved.',
  'reviews.comments.edit': 'Change the text of a review comment.',
  'reviews.comments.reply': 'Answer a review comment.',
  'reviews.comments.redact': 'Hide the text of a review comment that should not be shown, keeping its place in the review.',
  'reviews.comments.setDisposition': 'Record what was decided about a review comment, such as whether it must be fixed.',
  'reviews.comments.attachEvidence': 'Add proof to a review comment, such as a failing test or a file reference.',
  'reviews.comments.bulkTransition': 'Move several review comments along in one step.',
  'reviews.comments.claimPublicationDispatch': 'Reserve review comments for posting to the pull request, so they are posted only once.',
});

const REVIEW_COMMENT_ACTION_VOICE_EXAMPLES = {
  'reviews.comments.create': '{"workspace":{"machineId":"machine-1","path":"/repo"},"anchor":{"kind":"file","filePath":"src/main.ts"},"snapshot":{"kind":"none","capturedAt":1},"body":"Check the failure path.","clientMutationId":"create-1"}',
  'reviews.comments.list': '{"workspace":{"machineId":"machine-1","path":"/repo"}}',
  'reviews.comments.get': '{"commentId":"comment-1"}',
  'reviews.comments.transition': '{"workspace":{"machineId":"machine-1","path":"/repo"},"commentId":"comment-1","expectedServerRevision":1,"expectedState":"open","toState":"resolved","reason":"The regression test passes.","clientMutationId":"transition-1"}',
  'reviews.comments.edit': '{"workspace":{"machineId":"machine-1","path":"/repo"},"commentId":"comment-1","expectedServerRevision":1,"expectedBodyVersion":1,"nextBody":"Check the cancellation path.","clientMutationId":"edit-1"}',
  'reviews.comments.reply': '{"workspace":{"machineId":"machine-1","path":"/repo"},"parentCommentId":"comment-1","expectedParentServerRevision":1,"body":"Added a regression test.","clientMutationId":"reply-1"}',
  'reviews.comments.redact': '{"workspace":{"machineId":"machine-1","path":"/repo"},"commentId":"comment-1","expectedServerRevision":1,"reason":"Contains private content.","clientMutationId":"redact-1"}',
  'reviews.comments.setDisposition': '{"workspace":{"machineId":"machine-1","path":"/repo"},"commentId":"comment-1","expectedServerRevision":1,"disposition":"blocking","clientMutationId":"disposition-1"}',
  'reviews.comments.attachEvidence': '{"workspace":{"machineId":"machine-1","path":"/repo"},"commentId":"comment-1","expectedServerRevision":1,"evidence":[{"kind":"reasoning","message":"Cancellation leaves the destination unchanged."}],"clientMutationId":"evidence-1"}',
  'reviews.comments.bulkTransition': '{"workspace":{"machineId":"machine-1","path":"/repo"},"commentIds":["comment-1"],"expectedServerRevisions":{"comment-1":1},"expectedState":"open","toState":"resolved","reason":"The regression test passes.","clientMutationId":"bulk-1"}',
} as const satisfies Record<Exclude<ReviewCommentActionIdV1, 'reviews.comments.claimPublicationDispatch'>, string>;

function createReviewCommentActionSpec(actionId: ReviewCommentActionIdV1): PreNormalizedActionSpec {
  const isRead = actionId === 'reviews.comments.list' || actionId === 'reviews.comments.get';
  const isReversibleMutation = actionId === 'reviews.comments.transition' || actionId === 'reviews.comments.bulkTransition'
    || actionId === 'reviews.comments.edit' || actionId === 'reviews.comments.reply';
  const isPublicCommentAction = actionId !== 'reviews.comments.claimPublicationDispatch';
  return {
    // A publication handler awaits its claim correlations before
    // provider dispatch. Keep that nested plugin invocation on the existing
    // approval waiter instead of returning an approval Artifact as a claim.
    id: actionId, approval: { result: actionId === 'reviews.comments.claimPublicationDispatch' ? 'required' : 'none' },
    executionPlacement: 'account',
    title: REVIEW_COMMENT_ACTION_TITLES[actionId],
    description: 'Operate on durable review comments through the shared review-comment substrate.',
    safety: isRead || isReversibleMutation ? 'safe' : 'danger',
    ...(isReversibleMutation ? { approvalPolicy: { agentDefault: 'authority' as const } } : {}),
    placements: [],
    bindings: {
      rpcMethod: REVIEW_COMMENT_ACTION_RPC_METHODS[actionId],
      sdkMethod: REVIEW_COMMENT_ACTION_SDK_METHODS[actionId],
      ...(isPublicCommentAction ? { mcpToolName: actionId.replaceAll('.', '_') } : {}),
    },
    surfaces: {
      ui: true,
      voice: isPublicCommentAction,
      agent: isPublicCommentAction,
      mcp: isPublicCommentAction,
      cli: isPublicCommentAction,
      rpc: true,
    },
    ...(isPublicCommentAction ? { cli: { acceptsServerId: true, commands: [{
      path: actionId.split('.').map((segment) => segment.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)),
      visibility: 'canonical' as const,
    }] } } : {}),
    sideEffectClass: isRead ? 'read' : 'write',
    outputSchema: ReviewCommentActionOutputSchemasV1[actionId],
    inputSchema: ReviewCommentActionInputSchemasV1[actionId],
    inputHints: { description: REVIEW_COMMENT_ACTION_SUMMARIES[actionId], fields: [] },
    ...(actionId === 'reviews.comments.claimPublicationDispatch' ? {} : {
      examples: { voice: { argsExample: REVIEW_COMMENT_ACTION_VOICE_EXAMPLES[actionId] } },
    }),
  };
}

const PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1 = [
  {
    id: 'plugins.sessionHooks.status.get', approval: {result: 'required'},
    title: 'Get Agent session-hook status inventory',
    description:
      'Read a bounded, paginated inventory of portable External Session hook installation status rows.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET },
    surfaceBindings: {
      rpc: PluginSessionHookRpcSurfaceBinding,
      plugin: {
        inputSchema: PluginSessionHookStatusPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
        projectOutput: projectPluginSessionHookStatus,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: PluginSessionHookStatusResponseV1Schema,
    inputSchema: PluginSessionHookStatusActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.install', approval: {result: 'optional',flow: 'deferred'},
    confirmVerb: { key: 'common.install', fallback: 'Install' },
    approvalPolicy: { uiConfirmation: 'policy' },
    title: 'Install Agent session hooks',
    description: 'Explicitly install External Session hooks for one qualified Agent integration.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_INSTALL },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookInstallResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookInstallPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookInstallResponseV1Schema,
    inputSchema: PluginSessionHookInstallActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.disable', approval: {result: 'optional',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Disable Agent session hooks',
    description: 'Explicitly disable ingestion for one exact Agent hook installation without deleting its owned config.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_DISABLE },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookToggleResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookToggleResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.enable', approval: {result: 'optional',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Enable Agent session hooks',
    description: 'Explicitly enable ingestion for one exact Agent hook installation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_ENABLE },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookToggleResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookToggleResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: [] },
  },
  {
    id: 'plugins.sessionHooks.uninstall', approval: {result: 'optional',flow: 'deferred'},
    confirmVerb: { key: 'settingsPlugins.uninstall', fallback: 'Uninstall' },
    approvalPolicy: { uiConfirmation: 'policy' },
    title: 'Uninstall Agent session hooks',
    description: 'Explicitly remove only the owned entries for one exact External Session hook installation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_UNINSTALL },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookUninstallResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: PluginSessionHookUninstallResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: [] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];

const EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS: ActionInputHints['fields'] = [
  { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
  { path: 'operationId', title: 'Operation id', widget: 'text', required: true },
  { path: 'revision', title: 'Revision', widget: 'text', required: true },
];

function identityActionSurfaceValue(value: unknown): unknown {
  return value;
}

function projectExternalSessionOperationResult(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const semantic = ExternalSessionOperationActionResultV1Schema.safeParse(value);
  const materialize = ExternalSessionMaterializeActionInputV1Schema.safeParse(
    context.input,
  );
  const reference = ExternalSessionOperationStatusInputV1Schema.safeParse(
    context.input,
  );
  const sessionId = materialize.success
    ? materialize.data.request.sessionId
    : reference.success
      ? reference.data.sessionId
      : null;
  if (!sessionId) throw new Error('external_session_operation_input_required');
  if (semantic.success) {
    if (
      semantic.data.ok
      && semantic.data.operation.sessionId !== sessionId
    ) {
      throw new Error('external_session_operation_session_mismatch');
    }
    return semantic.data;
  }
  return projectExternalSessionOperationActionResultV1(value, sessionId);
}

function projectExternalSessionMaterializeResult(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const materialize = ExternalSessionMaterializeActionInputV1Schema.parse(
    context.input,
  );
  return projectExternalSessionMaterializeActionResultV1(
    value,
    materialize.request.sessionId,
  );
}

function projectExternalSessionStatusResult(value: unknown): unknown {
  const response = ExternalSessionStatusGetResponseSchema.parse(value);
  return response.ok
    ? ExternalSessionStatusActionResultV1Schema.parse({
        ok: true,
        machineOnline: response.machineOnline,
        runnerActive: response.runnerActive,
        activity: response.activity,
        canTakeOverDirect: response.canTakeOverDirect,
        canTakeOverPersist: response.canTakeOverPersist,
        canForceStop: response.canForceStop,
        ...(response.lastKnownActivityAtMs === undefined
          ? {}
          : { lastKnownActivityAtMs: response.lastKnownActivityAtMs }),
      })
    : ExternalSessionStatusActionResultV1Schema.parse({
        ok: false,
        errorCode: response.errorCode,
        error: response.error,
      });
}

function projectExternalSessionBackgroundFollowResult(value: unknown): unknown {
  const response = ExternalSessionFollowPolicySetResponseSchema.parse(value);
  return ExternalSessionBackgroundFollowActionResultV1Schema.parse(response.ok
    ? {
        ok: true,
        enabled: response.enabled,
        leaseActive: response.leaseActive,
        updatedAtMs: response.updatedAtMs,
      }
    : {
        ok: false,
        errorCode: response.errorCode,
        error: response.error,
      });
}

const EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1 = [
  {
    id: 'sessions.external.materialize.start', approval: {result: 'optional',flow: 'deferred'},
    title: 'Materialize external session',
    description: 'Start or converge on the canonical external-session materialization operation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START, mcpToolName: 'sessions_external_materialize_start' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionMaterializeStartInputV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionMaterializeActionInputV1Schema,
        projectOutput: projectExternalSessionMaterializeResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionMaterializeActionResultV1Schema,
    inputSchema: ExternalSessionMaterializeActionInputV1Schema,
    inputHints: {
      description: 'Bring a session you started outside Happier into Happier so you can follow it here.',
      title: 'Materialize external session',
      fields: [{ path: 'request', title: 'Operation request', widget: 'textarea', required: true }],
    },
  },
  {
    id: 'sessions.external.takeover.start', approval: {result: 'optional',flow: 'deferred'},
    title: 'Start external session takeover',
    description: 'Start or converge on the canonical external-session takeover operation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionTakeoverStartInputV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionOperationActionResponseV1Schema,
    inputSchema: ExternalSessionTakeoverStartInputV1Schema,
    inputHints: {
      description: 'Start moving a session you began outside Happier into Happier, so you can steer it here.',
      title: 'Start external session takeover',
      fields: [{ path: 'request', title: 'Operation request', widget: 'textarea', required: true }],
    },
  },
  {
    id: 'sessions.external.operation.status.get', approval: {result: 'required'},
    title: 'Get external session operation status',
    description: 'Passively read the current canonical external-session operation projection.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET, mcpToolName: 'sessions_external_operation_status_get' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationStatusInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationStatusInputV1Schema,
    inputHints: {
      description: 'See how far an import or takeover of an outside session has got.',
      title: 'Get external session operation status',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.cancel', approval: {result: 'optional',flow: 'deferred'},
    title: 'Cancel external session operation',
    description: 'Record an explicit cancellation intent for the current operation revision.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL, mcpToolName: 'sessions_external_operation_cancel' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationCancelInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationCancelInputV1Schema,
    inputHints: {
      description: 'Stop an import or takeover of an outside session that is still in progress.',
      title: 'Cancel external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.resume', approval: {result: 'optional',flow: 'deferred'},
    title: 'Resume external session operation',
    description: 'Explicitly resume a passively hydrated operation from its durable checkpoint.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME, mcpToolName: 'sessions_external_operation_resume' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationResumeInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationResumeInputV1Schema,
    inputHints: {
      description: 'Pick up an interrupted import or takeover of an outside session where it left off.',
      title: 'Resume external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.retry', approval: {result: 'optional',flow: 'deferred'},
    title: 'Retry external session operation',
    description: 'Explicitly retry the canonical recovery phase at the current revision.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RETRY, mcpToolName: 'sessions_external_operation_retry' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationRetryInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationRetryInputV1Schema,
    inputHints: {
      description: 'Try a failed import or takeover of an outside session again.',
      title: 'Retry external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.discard', approval: {result: 'optional',flow: 'deferred'},
    title: 'Discard external session operation',
    description: 'Destructively discard an eligible initial partial operation and its private staging.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD, mcpToolName: 'sessions_external_operation_discard' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationDiscardInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationDiscardInputV1Schema,
    inputHints: {
      description: 'Throw away an unfinished import of an outside session and the partial copy it made.',
      title: 'Discard external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
] as const satisfies readonly PreNormalizedActionSpec[];


const EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION =
  'A nonempty sessionId selects that exact authorized Session. Omitting sessionId inherits the current Action Session, or selects detached scope when none exists. sessionId:null selects detached scope even inside a current Session.';

const EXECUTION_RUN_SESSION_SCOPE_HINT = {
  path: 'sessionId',
  title: 'Session id',
  prompt: 'Which session?',
  description: 'Use a nonempty value for an exact authorized Session. Omit it to inherit the current Action Session, or to select detached scope when no current Session exists. Set null to select detached scope even inside a current Session.',
  widget: 'text',
} satisfies ActionInputFieldHint;

const EXECUTION_RUN_WAIT_OBSERVATION_DESCRIPTION =
  'Timeout only ends this observation; it does not stop, retry, or start the run. Cancellation only ends this wait.';

const WORKFLOW_DIRECT_MCP_ACTION_IDS = new Set<WorkflowActionIdV1>([
  'workflow.run.start', 'workflow.run.get', 'workflow.run.wait', 'workflow.run.cancel',
]);

const WORKFLOW_DANGER_ACTION_IDS = new Set<WorkflowActionIdV1>([
  'workflow.run.delete', 'workflow.definition.delete',
  'workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.remove',
  'workflow.trigger.run_now',
  'session.trigger.remove',
]);

const WORKFLOW_ACTION_TITLES: Readonly<Record<WorkflowActionIdV1, string>> = {
  'workflow.validate': 'Validate workflow',
  'workflow.run.start': 'Start workflow Run',
  'workflow.run.list': 'List workflow Runs',
  'workflow.run.summaries': 'Summarize workflow Runs',
  'workflow.run.get': 'Get workflow Run',
  'workflow.run.wait': 'Wait for workflow Run',
  'workflow.run.pause': 'Pause workflow Run',
  'workflow.run.resume': 'Resume workflow Run',
  'workflow.run.cancel': 'Cancel workflow Run',
  'workflow.run.invocations.list': 'List workflow invocations',
  'workflow.run.invocations.get': 'Get workflow invocation',
  'workflow.run.invocations.retry': 'Retry workflow invocation',
  'workflow.run.invocations.publish_draft': 'Publish workflow draft result',
  'workflow.run.invocations.complete_review': 'Complete workflow review',
  'workflow.run.delete': 'Delete workflow Run history',
  'workflow.definition.list': 'List saved workflow definitions',
  'workflow.definition.get': 'Get saved workflow definition',
  'workflow.definition.create': 'Create workflow definition',
  'workflow.definition.update': 'Update workflow definition',
  'workflow.definition.edit': 'Edit workflow definition',
  'workflow.definition.delete': 'Delete workflow definition',
  'workflow.definition.import': 'Import workflow document',
  'workflow.definition.export': 'Export saved workflow document',
  'workflow.definition.capture': 'Prepare an editable pattern',
  'workflow.trigger.list': 'List workflow triggers',
  'workflow.trigger.add': 'Add workflow trigger',
  'workflow.trigger.update': 'Update workflow trigger',
  'workflow.trigger.remove': 'Remove workflow trigger',
  'workflow.trigger.run_now': 'Run saved Automation now',
  'session.trigger.list': 'List session triggers',
  'session.trigger.add': 'Add session trigger',
  'session.trigger.update': 'Update session trigger',
  'session.trigger.remove': 'Remove session trigger',
};

const WORKFLOW_TRIGGER_VOICE_ARGS_EXAMPLES: Readonly<Partial<Record<WorkflowActionIdV1, string>>> = {
  'workflow.run.list': '{"targetSessionId":"session_123"}',
  'workflow.run.start': '{"runId":"22222222-2222-4222-8222-222222222222","source":{"kind":"inline","definition":{"blocks":["Use the accepted workflow"]},"replay":{"runId":"11111111-1111-4111-8111-111111111111","intent":"another_round"}}}',
  'workflow.trigger.list': '{"workflow":"builtin:review-and-converge"}',
  'workflow.trigger.add': '{"workflow":"builtin:review-and-converge","project":{"machineId":"machine_123","directory":"/workspace/project"},"trigger":{"kind":"schedule","enabled":true,"schedule":{"kind":"cron","scheduleExpr":"0 9 * * *","everyMs":null,"timezone":"UTC"}}}',
  'workflow.trigger.update': '{"automationId":"automation_123","triggerId":"trigger_123","expectedRevision":1,"patch":{"enabled":false}}',
  'workflow.trigger.remove': '{"automationId":"automation_123","triggerId":"trigger_123"}',
  'workflow.trigger.run_now': '{"automationId":"automation_123"}',
  'session.trigger.list': '{"sessionId":"session_123"}',
  'session.trigger.add': '{"sessionId":"session_123","target":{"kind":"workflow","ref":"builtin:keep-going"},"trigger":{"kind":"sessionLifecycle","enabled":true,"sourceSessionId":"session_123","events":["parentTurnCompleted"],"policy":{"kind":"everyMatch"}}}',
  'session.trigger.update': '{"sessionId":"session_123","triggerId":"trigger_123","expectedRevision":1,"patch":{"enabled":false}}',
  'session.trigger.remove': '{"sessionId":"session_123","triggerId":"trigger_123"}',
};

const WORKFLOW_ACTION_DESCRIPTIONS: Readonly<Partial<Record<WorkflowActionIdV1, string>>> = {
  'workflow.definition.capture': 'Prepare an editable draft from explicitly selected authorized Discussion messages. Review inferred steps, exact dependencies and per-run question/participant inputs; use choices to resolve unlinked messages. Workflow-backed exchanges reuse their authored definition and source provenance. Capture does not save, share or start work; open the draft in the ordinary editor and save with workflow.definition.create.',
  'workflow.run.start': `Start an ordinary workflow from a built-in/plugin catalog, a saved definition, or an inline definition. A Session caller supplies the origin Session and its Machine/workspace through authenticated Action context. inputs contains only declared workflow input values; machineId and directory inside inputs do not select a run target. executionTarget selects the leaf execution kind, not the Machine/workspace. For an inline definition, put model and effort on defaults.engine or a step execution.engine, for example {agentTarget,modelSelection,effort:"low"}; do not place reasoning_effort in sessionConfigOptionOverrides. Validate the definition with ${'workflow.validate' satisfies WorkflowActionIdV1} before starting. Retain runId when a response is uncertain. Run again uses source.replay.runId to reopen the accepted graph, runtime and participants; Another round adds source.replay.intent="another_round" and the owner reads authorized prior outcomes into its declared previousRoundContext input. Another round retains all accepted inputs and participants; unavailable context or targets requires repair before starting. It uses the ordinary start approval; contained Actions keep their own approval and authority.`,
  'workflow.trigger.remove': 'Remove one trigger by automationId and triggerId; the last child removal leaves a Manual set. Omit triggerId to delete the whole Account trigger set, including an empty Manual set. Past Runs are kept.',
  'workflow.definition.list': 'List saved workflows in this Home Account and available plugin workflows. Returns definitions with metadata, content availability and trigger summaries, plus pluginWorkflows when available. Follow nextCursor to read later pages; use workflow.definition.get to read a saved definition.',
  'workflow.definition.get': 'Read one saved workflow definition, its metadata, revision and destinations using a definitionId from workflow.definition.list.',
  'workflow.definition.create': 'Save an authored workflow definition without running it. Supply a UUID definitionId for the new Artifact; reuse that UUID only to rejoin the same create. For named starter templates, first execute workflow.starters.list and workflow.starters.resolve. Block kinds describe workflow syntax; eligible trigger events come from workflow.events.list.',
  'workflow.run.list': 'List started workflow Runs and their progress in this Home Account. Run history can be empty while saved definitions exist; use workflow.definition.list for the workflow library. Use execution.run.list for agent execution runs.',
  'workflow.definition.edit': 'Prefer this typed operation batch for partial workflow changes; workflow.definition.update replaces the whole definition.',
  'workflow.run.invocations.publish_draft': "Publish a private draft value validated against the invocation's exact frozen result contract. Prose does not publish a result. Publication does not complete or advance the invocation. If publication fails, request a present-user follow-up; an agent must not complete the review.",
  'workflow.run.invocations.complete_review': 'Present-user only: use the stored or supplied validated result, or request generation on the held invocation, using its exact content revision. Automated callers cannot resolve review.',
};

const WorkflowInvocationRetryCliInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(WorkflowActionInputSchemasV1[
  'workflow.run.invocations.retry'
], { input: true }), {
  retryInput: WorkflowActionInputSchemasV1['workflow.run.invocations.retry'].shape.input,
})));

function bindWorkflowInvocationRetryCliInputV1(value: unknown): unknown {
  const { retryInput, ...rest } = WorkflowInvocationRetryCliInputV1Schema.parse(value);
  return { ...rest, input: retryInput };
}

const WORKFLOW_READ_ACTION_IDS: ReadonlySet<WorkflowActionIdV1> = new Set([
  'workflow.validate', 'workflow.run.list', 'workflow.run.summaries', 'workflow.run.get', 'workflow.run.wait',
  'workflow.run.invocations.list', 'workflow.run.invocations.get',
  'workflow.definition.list', 'workflow.definition.get', 'workflow.definition.import', 'workflow.definition.export', 'workflow.definition.capture',
  'workflow.trigger.list', 'session.trigger.list',
]);

const WORKFLOW_ACTION_SPECS_V1: readonly PreNormalizedActionSpec[] = WORKFLOW_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
  const directMcp = WORKFLOW_DIRECT_MCP_ACTION_IDS.has(actionId);
  // Voice reaches the ordinary Action owner but cannot complete a person's review.
  const voice = actionId !== 'workflow.run.invocations.complete_review';
  const voiceArgsExample = WORKFLOW_TRIGGER_VOICE_ARGS_EXAMPLES[actionId];
  const sideEffectClass = WORKFLOW_DANGER_ACTION_IDS.has(actionId)
    ? 'danger' as const
    : WORKFLOW_READ_ACTION_IDS.has(actionId)
      ? 'read' as const
      : 'write' as const;
  const commandPath = actionId.split('.');
  return {
    id: actionId, approvalPolicy: { ...(actionId === 'session.trigger.remove' ? { scopeAdmissionOwnsConfirmation: true as const } : {}) }, approval: WORKFLOW_READ_ACTION_IDS.has(actionId) ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
    title: WORKFLOW_ACTION_TITLES[actionId],
    description: WORKFLOW_ACTION_DESCRIPTIONS[actionId]
      ?? `${WORKFLOW_ACTION_TITLES[actionId]} through the canonical workflow Action owner.`,
    safety: WORKFLOW_DANGER_ACTION_IDS.has(actionId) ? 'danger' : 'safe',
    placements: [],
    bindings: {
      mcpToolName: actionId.replaceAll('.', '_'),
      // Trusted clients reach the same daemon-owned Workflow Action port. The
      // method is the Action id, so there is no second transport vocabulary.
      rpcMethod: actionId,
      ...(voice
        ? { voiceClientToolName: actionId.replaceAll('.', '_') } : {}),
    },
    surfaces: {
      ui: true,
      voice,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    // Only the four interactive operations project as direct MCP tools; the
    // other Workflow operations stay executable through the generic external
    // MCP `action_execute` transport and discoverable through Action search
    // without gaining a dedicated tool row.
    ...(directMcp ? {} : { toolExposure: { mcp: 'discoverable_only' as const } }),
    sideEffectClass,
    ...(actionId === 'workflow.run.invocations.complete_review' ? { requiredAuthority: 'present_user' as const } : {}),
    inputSchema: WorkflowActionInputSchemasV1[actionId],
    outputSchema: WorkflowActionOutputSchemasV1[actionId],
    ...(voiceArgsExample ? { examples: { voice: { argsExample: voiceArgsExample } } } : {}),
    inputHints: { title: WORKFLOW_ACTION_TITLES[actionId], fields: actionId === 'workflow.definition.list'
      ? [
        { path: 'cursor', title: 'Next page cursor', widget: 'text', description: 'Use the previous response nextCursor to continue the saved workflow library.' },
        { path: 'limit', title: 'Page size preference', widget: 'number' },
      ]
      : actionId === 'workflow.definition.get'
        ? [{ path: 'definitionId', title: 'Saved definition id', widget: 'text', required: true, description: 'Use a definitionId returned by workflow.definition.list.' }]
      : actionId === 'workflow.trigger.list'
        // The input is a strict union, not an empty object. Declare its choices
        // here so workflow steps and every other Action form share the same
        // fields; forms never infer another contract from the schema.
        ? [
          { path: 'workflow', title: 'Workflow', widget: 'select', optionsSourceId: 'workflows.references.available',
            description: 'Choose a workflow, an Account scope, or an Automation with Review.',
            requiredWhen: { op: 'and', all: [
              { op: 'not', predicate: { op: 'truthy', path: 'scope' } },
              { op: 'not', predicate: { op: 'eq', path: 'review', value: true } },
            ] } },
          { path: 'scope', title: 'Account scope', widget: 'select', options: [
            { value: 'account_inline', label: 'Inline workflows' },
            { value: 'account_all', label: 'All workflows' },
          ] },
          { path: 'review', title: 'Review retained Automation', widget: 'boolean' },
          { path: 'automationId', title: 'Automation', widget: 'text',
            requiredWhen: { op: 'eq', path: 'review', value: true } },
        ]
      : actionId === 'session.trigger.list'
        ? [{ path: 'sessionId', title: 'Session', widget: 'text', required: true }]
      : actionId === 'workflow.trigger.add'
      ? [{ path: 'workflow', title: 'Workflow', widget: 'select', optionsSourceId: 'workflows.references.available' }]
      : actionId === 'workflow.trigger.update'
        ? [
          { path: 'automationId', title: 'Automation', widget: 'text', required: true },
          { path: 'expectedRevision', title: 'Reviewed revision', widget: 'number', required: true },
          { path: 'triggerId', title: 'Trigger', widget: 'text' },
          { path: 'patch', title: 'Changes', widget: 'json', required: true,
            description: 'For a reviewed legacy conversion, include the reviewed target and project, and optionally enabled.' },
          { path: 'confirmLegacyConversion', title: 'Store reviewed workflow without end-to-end encryption', widget: 'boolean', required: true,
            visibleWhen: { op: 'eq', path: 'confirmLegacyConversion', value: true } },
        ]
      : actionId === 'session.trigger.add'
        ? [{ path: 'target.ref', title: 'Workflow', widget: 'select', optionsSourceId: 'workflows.references.available' }]
      : actionId === 'workflow.run.start'
        ? [
          { path: 'runId', title: 'New Run id', widget: 'text', required: true,
            description: 'Allocate a UUID for this new start; reuse it to reconcile a lost response.' },
          { path: 'source.workflow', title: 'Workflow', widget: 'select', optionsSourceId: 'workflows.references.available' },
          { path: 'source.replay.runId', title: 'Accepted Run to repeat', widget: 'text',
            description: 'With an inline source, reopens this authorized Run and preserves its accepted graph and concrete participants.' },
          { path: 'source.replay.intent', title: 'Continuation', widget: 'select',
            options: [{ value: 'another_round', label: 'Another round' }],
            description: 'Omit for ordinary Run again. Another round retains accepted inputs and supplies authorized outcomes as previousRoundContext; that JSON input must be declared by the workflow.' },
          { path: 'inputs', title: 'Workflow inputs', widget: 'json',
            description: 'Values keyed by declared workflow input names. Resolve input choices with action.options.resolve using a workflow consumer and the declared input name as fieldPath. Machine/workspace routing comes from Action context, not this object. Another round inherits the completed Run inputs; it never substitutes current picker defaults.' },
          { path: 'executionTarget', title: 'Step execution kind', widget: 'json',
            description: 'Optional leaf execution kind: session or detached_run. This does not select a Machine or directory; a Session caller inherits those from its authenticated context.' },
        ]
      : actionId === 'workflow.run.invocations.list'
        ? [{ path: 'includeContent', title: 'Include invocation content', widget: 'boolean',
          description: 'Open progress and output beside each history row in the same page. Not available with parentRecordId.' }]
      : [] },
    cli: {
      acceptsServerId: true,
      commands: [{ path: commandPath, visibility: 'canonical' }],
      ...(actionId === 'workflow.run.invocations.retry' ? {
        inputSchema: WorkflowInvocationRetryCliInputV1Schema,
        inputHints: {
          title: 'Retry workflow invocation',
          fields: [{
            path: 'retryInput',
            title: 'Retry input',
            description: 'Use {"kind":"original"} or provide a replacement authored input.',
            widget: 'json',
            required: true,
          }],
        },
        bindInput: bindWorkflowInvocationRetryCliInputV1,
      } : {}),
    },
  };
});
const WORK_BOARD_ACTION_TITLES: Readonly<Record<WorkBoardActionIdV1, string>> = {
  'boards.list': 'List Boards',
  'boards.apply': 'Edit Board',
};

const WORK_BOARD_ACTION_SPECS_V1: readonly PreNormalizedActionSpec[] = WORK_BOARD_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => ({
  id, approval: { result: 'required' },
  ...(id === 'boards.apply' ? { approvalPolicy: {
    uiConfirmation: 'direct' as const,
    uiConfirmationForInput: (input: unknown) => {
      const parsed = WorkBoardActionInputSchemasV1['boards.apply'].safeParse(input);
      if (!parsed.success) return true;
      // Board and widget edits are reversible and keep their referenced work, as the same widget
      // edits through widgets.item.* do. Delete removes the Artifact and a widget's network access
      // widens what a guest may reach, so those two confirm.
      return parsed.data.intent.kind === 'delete' || parsed.data.intent.kind === 'widget_network';
    },
  } } : {}),
  title: WORK_BOARD_ACTION_TITLES[id],
  description: id === 'boards.list'
    ? 'List this Home Account’s saved Boards, including their names, item references and layout. This reads Home Boards; session.board.get reads a Session’s own Board.'
    : 'Replay a Board intent through its canonical Artifact. Supports create, delete, update, add_items, remove_item and set_positions; agent moves do not prune positions.',
  // An aggregate intent can delete a Board, so mutation approval uses the shared danger policy.
  safety: id === 'boards.list' ? 'safe' : 'danger',
  sideEffectClass: id === 'boards.list' ? 'read' : 'danger',
  executionPlacement: 'account', requiredAuthority: 'account_automation',
  placements: [],
  bindings: { mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_'), rpcMethod: id },
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: WorkBoardActionInputSchemasV1[id],
  outputSchema: WorkBoardActionOutputSchemasV1[id],
  inputHints: { title: WORK_BOARD_ACTION_TITLES[id],
    ...(id === 'boards.list' ? { description: 'Execute with action_execute {"actionId":"boards.list","input":{}}. This discoverable Action does not need a dedicated boards_list tool.' } : {}),
    fields: id === 'boards.list' ? [] : [
    { path: 'boardId', title: 'Board id', widget: 'text', description: 'Optional; must match the intent target when supplied.' },
    { path: 'intent', title: 'Board intent', widget: 'json', required: true,
      description: 'Use kind create, delete, update, add_items, remove_item or set_positions. References include kind and qualifiedId {serverId, id}.' },
  ] },
  cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
}));

const ARTIFACT_ACCESS_ACTION_SPECS: readonly (PreNormalizedActionSpec & Readonly<{
  requiredAuthority: 'account_automation';
}>)[] = ARTIFACT_ACCESS_ACTION_IDS_V1.map((id) => ({
  id, approval: { result: 'required' }, title: id === 'artifact.access.grants.list' ? 'List document sharing' : id === 'artifact.access.grants.set' ? 'Share document' : 'Remove document sharing',
  description: 'Manage sharing through the document kind owner and authenticated Artifact grants.',
  safety: id === 'artifact.access.grants.list' ? 'safe' : 'danger',
  sideEffectClass: id === 'artifact.access.grants.list' ? 'read' : 'write',
  // Anything a person can do here an agent can do too (owner rule; INT review F-18): the same
  // authority and approval policy as Session access grants, so widening access still asks. The
  // present user pressing Add or Remove in the share sheet is the confirmation, as for Session grants.
  ...(id === 'artifact.access.grants.list' ? {} : { approvalPolicy: { uiConfirmation: 'direct' as const } }),
  requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
  bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_') },
  surfaces: { ui: true, cli: true, rpc: true, agent: true, mcp: true, voice: true },
  inputSchema: ArtifactAccessActionInputSchemasV1[id], outputSchema: ArtifactAccessActionOutputSchemasV1[id],
  inputHints: { title: 'Document sharing', fields: [] },
  cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
}));

function projectPublicLinkCreationObservation(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  return { ...result,
    ...(typeof result.url === 'string' ? { url: redactPublicShareCapabilityUrl(result.url) } : {}),
    ...(typeof result.previewUrl === 'string' ? { previewUrl: redactPublicShareCapabilityUrl(result.previewUrl) } : {}),
  };
}

// What a person reads in Settings, approvals and the form. Agents read `description`.
const ARTIFACT_ACTION_COPY = {
  'artifact.create': ['Create document', 'Save a new document to your account.'],
  'artifact.get': ['Read document', 'Open one document and read what is in it.'],
  'artifact.export': ['Export document file', 'Save a binary document into the invoking session’s workspace, or save/share a portable Role or Profile document on the answering client. Existing workspace files are preserved unless overwrite is approved.'],
  'artifact.list': ['List documents', 'See the documents saved in your account.'],
  'artifact.update': ['Update document', 'Save a new version of a document. Earlier versions are kept.'],
  'artifact.delete': ['Delete document', 'Remove a document from your account. People it was shared with lose it too.'],
  'artifact.publish_from_file': ['Save a file as a document', 'Turn a file on a machine into a document in your account.'],
  'artifact.revisions.list': ['List document versions', 'See the earlier versions of a document.'],
  'artifact.revisions.restore': ['Restore document version', 'Make an earlier version of a document the current one.'],
  'artifact.storage.usage': ['Read document storage', 'See how much space your documents take.'],
  'artifact.public_link.create': ['Create document public link', 'Make a link that lets anyone who has it read a document.'],
  'artifact.public_link.list': ['List document public links', 'See the public links a document has.'],
  'artifact.public_link.revoke': ['Turn off document public link', 'Stop a public link working. People who have it can no longer open the document.'],
  'artifact.public_link.audit': ['Read document public link activity', 'See when a document\'s public link was opened.'],
} as const satisfies Record<ArtifactActionIdV1, readonly [title: string, summary: string]>;

const ARTIFACT_ACTION_SPECS: readonly (PreNormalizedActionSpec & Readonly<{
  requiredAuthority: 'account_automation';
}>)[] = ARTIFACT_ACTION_IDS_V1.map((id): PreNormalizedActionSpec & Readonly<{ requiredAuthority: 'account_automation' }> => {
  const read = id === 'artifact.get' || id === 'artifact.list' || id === 'artifact.revisions.list' || id === 'artifact.storage.usage' || id === 'artifact.public_link.audit';
  const voice = id !== 'artifact.export';
  return {
    id, approval: { result: 'required' },
    ...(id === 'artifact.export' ? { approvalPolicy: {
      uiConfirmation: 'direct' as const,
      uiConfirmationForInput: (input: unknown) => !Object.hasOwn(readRecord(input), 'portable'),
    }, executionPlacementForInput: (input: unknown) => Object.hasOwn(readRecord(input), 'portable') ? 'client' as const : 'machine' as const } : {}),
    ...(id === 'artifact.public_link.audit' ? { approvalPolicy: { agentDefault: 'egress' as const } } : {}),
    // Opening the share sheet reads the document's links; a present-user read is not confirmed.
    ...(id === 'artifact.public_link.list' ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    // Both create a new private Account document (artifactActionDeps#createDocument).
    // Public-link creation carries its own in-page network choice (owner ruling
    // 2026-10-16); existing-document edits and revocation stay confirmed.
    ...(id === 'artifact.create' || id === 'artifact.publish_from_file' || id === 'artifact.public_link.create'
      ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    // The present user's own Inbox notice read or dismissal is reversible bookkeeping on a private
    // notice; the executor admits only those exact notice transitions. Document edits stay confirmed.
    ...(id === 'artifact.update' ? { approvalPolicy: {
      uiConfirmation: 'direct' as const,
      uiConfirmationForInput: (input: unknown) => {
        const header = readRecord(readRecord(input).header);
        return header.kind !== USAGE_NOTICE_ARTIFACT_KIND_V1 && header.kind !== ACCOUNT_NOTICE_ARTIFACT_KIND_V1;
      },
    } } : {}),
    title: ARTIFACT_ACTION_COPY[id][0], description: id === 'artifact.export' ? ARTIFACT_ACTION_COPY[id][1]
      : 'Read, publish and manage ordinary Account Artifacts through their mode-aware store.',
    safety: read ? 'safe' : 'danger', sideEffectClass: read || id === 'artifact.public_link.list' ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: id === 'artifact.publish_from_file' || id === 'artifact.export' ? 'machine' : 'account',
    placements: [], bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_'),
      ...(voice ? { voiceClientToolName: id.replaceAll('.', '_') } : {}) },
    surfaces: { ui: true, cli: true, rpc: true, agent: true, mcp: true,
      voice },
    inputSchema: ArtifactActionInputSchemasV1[id], outputSchema: ArtifactActionOutputSchemasV1[id],
    ...(['artifact.public_link.create', 'artifact.create', 'artifact.update', 'artifact.publish_from_file', 'artifact.get', 'artifact.revisions.restore'].includes(id)
      ? { projectObservationOutput: projectPublicLinkCreationObservation } : {}),
    inputHints: { title: ARTIFACT_ACTION_COPY[id][0], description: ARTIFACT_ACTION_COPY[id][1], fields: id === 'artifact.publish_from_file' ? [
      { path: 'path', title: 'File path', widget: 'text', required: true,
        description: 'File within the source workspace. Without workspace, the admitted caller Session supplies the source.' },
      { path: 'workspace', title: 'Source workspace', widget: 'json',
        description: 'Explicit {machineId, rootPath} source. Overrides an ambient Session; the host must support this Machine workspace or refuse the operation.' },
      { path: 'title', title: 'Document title', widget: 'text' },
    ] : [] },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.').map((segment) => segment.replaceAll('_', '-')), visibility: 'canonical' }] },
  };
});

// Reference family declarations so this aggregate preserves literal ids and
// schemas without serializing every Zod schema into the inline tuple type.
const ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES: readonly (
  | (typeof PLUGIN_EXECUTION_ORIGIN_ACTION_SPECS)[number]
  | (typeof USAGE_ACTION_SPECS)[number]
  | (typeof USAGE_COACH_ACTION_SPECS)[number]
  | (typeof HOME_GOVERNANCE_ACTION_SPECS)[number]
  | (typeof ACCOUNT_PROFILE_ACTION_SPECS_V1)[number]
  | (typeof FRIENDS_ACTION_SPECS)[number]
  | (typeof ACCOUNT_LIFECYCLE_ACTION_SPECS)[number]
  | (typeof HOME_IDENTITY_ACTION_SPECS)[number]
  | (typeof SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS)[number]
  | (typeof MACHINE_CONNECTION_ACTION_SPECS)[number]
  | (typeof LOCAL_DAEMON_SERVICE_ACTION_SPECS)[number]
  | (typeof MACHINE_TERMINAL_ACTION_SPECS)[number]
  | (typeof MACHINE_ACCESS_ACTION_SPECS)[number]
  | (typeof MACHINE_VITALS_ACTION_SPECS)[number]
  | (typeof MACHINE_PROCESSES_ACTION_SPECS)[number]
  | (typeof MACHINE_STORAGE_ACTION_SPECS)[number]
  | (typeof MACHINE_RESOURCES_ACTION_SPECS)[number]
  | (typeof MACHINE_GUARD_ACTION_SPECS)[number]
  | (typeof TEAM_ACTION_SPECS)[number]
  | (typeof SHARED_SAVED_SECRET_ACTION_SPECS)[number]
  | (typeof CONNECTED_SERVICE_CONFIGURATION_ACTION_SPECS)[number]
  | (typeof USAGE_SOURCE_ACTION_SPECS)[number]
  | (typeof PROFILE_ACTION_SPECS_V1)[number]
  | (typeof MCP_SERVER_ACTION_SPECS_V1)[number]
  | (typeof REGISTRY_ACTION_SPECS_V1)[number]
  | (typeof PERSONAL_SAVED_SECRET_ACTION_SPECS_V1)[number]
  | (typeof CAPABILITY_RULES_ACTION_SPECS_V1)[number]
  | (typeof SESSION_CAPABILITIES_ACTION_SPECS_V1)[number]
  | (typeof SESSION_ACCESS_DISCOVERY_ACTION_SPECS_V1)[number]
  | (typeof SKILL_ACTION_SPECS_V1)[number]
  | (typeof PROVIDER_ACTION_SPECS_V1)[number]
  | (typeof REMOTE_HOST_ACTION_SPECS_V1)[number]
  | (typeof HOME_RUNTIME_ACTION_SPECS_V1)[number]
  | (typeof ARTIFACT_FOLDER_ACTION_SPECS_V1)[number]
  | (typeof MANAGED_IDENTITY_PROVIDER_ACTION_SPECS)[number]
  | (typeof MANAGED_GITHUB_APP_ACTION_SPECS)[number]
  | (typeof PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1)[number]
  | (typeof EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1)[number]
  | (typeof WORKFLOW_ACTION_SPECS_V1)[number]
  | (typeof WORKFLOW_EVENT_CATALOG_ACTION_SPECS_V1)[number]
)[] = Object.freeze([
  ...PLUGIN_EXECUTION_ORIGIN_ACTION_SPECS,
  ...USAGE_ACTION_SPECS,
  ...USAGE_COACH_ACTION_SPECS,
  ...HOME_GOVERNANCE_ACTION_SPECS,
  ...ACCOUNT_PROFILE_ACTION_SPECS_V1,
  ...FRIENDS_ACTION_SPECS,
  ...ACCOUNT_LIFECYCLE_ACTION_SPECS,
  ...HOME_IDENTITY_ACTION_SPECS,
  ...SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS,
  ...MACHINE_CONNECTION_ACTION_SPECS,
  ...LOCAL_DAEMON_SERVICE_ACTION_SPECS,
  ...MACHINE_TERMINAL_ACTION_SPECS,
  ...MACHINE_ACCESS_ACTION_SPECS,
  ...MACHINE_VITALS_ACTION_SPECS,
  ...MACHINE_PROCESSES_ACTION_SPECS,
  ...MACHINE_STORAGE_ACTION_SPECS,
  ...MACHINE_RESOURCES_ACTION_SPECS,
  ...MACHINE_GUARD_ACTION_SPECS,
  ...TEAM_ACTION_SPECS,
  ...SHARED_SAVED_SECRET_ACTION_SPECS,
  ...CONNECTED_SERVICE_CONFIGURATION_ACTION_SPECS,
  ...USAGE_SOURCE_ACTION_SPECS,
  ...PROFILE_ACTION_SPECS_V1,
  ...MCP_SERVER_ACTION_SPECS_V1,
  ...REGISTRY_ACTION_SPECS_V1,
  ...PERSONAL_SAVED_SECRET_ACTION_SPECS_V1,
  ...CAPABILITY_RULES_ACTION_SPECS_V1,
  ...SESSION_CAPABILITIES_ACTION_SPECS_V1,
  ...SESSION_ACCESS_DISCOVERY_ACTION_SPECS_V1,
  ...SKILL_ACTION_SPECS_V1,
  ...PROVIDER_ACTION_SPECS_V1,
  ...REMOTE_HOST_ACTION_SPECS_V1,
  ...HOME_RUNTIME_ACTION_SPECS_V1,
  ...ARTIFACT_FOLDER_ACTION_SPECS_V1,
  ...MANAGED_IDENTITY_PROVIDER_ACTION_SPECS,
  ...MANAGED_GITHUB_APP_ACTION_SPECS,
  ...PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1,
  ...EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1,
  ...WORKFLOW_ACTION_SPECS_V1,
  ...WORKFLOW_EVENT_CATALOG_ACTION_SPECS_V1,
]);

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_OPENING = Object.freeze(defineActionSpecs([
  ...MEMORY_DOCUMENT_ACTION_SPECS_V1,
  ...DOC_COLLABORATION_ACTION_SPECS_V1,
  ...PROJECT_ACTION_SPECS_V1,
  ...WORKFLOW_EFFECT_ACTION_SPECS_V1,
  ...WORKSPACE_ACTION_SPECS,
  ...PROJECT_DEFINITION_ACTION_SPECS,
  ...WORKFLOW_AUTHORING_ACTION_SPECS,
  ...WORKFLOW_DIAGNOSTIC_ACTION_SPECS,
  ...COMPOSER_INGRESS_ACTION_SPECS,
  ...SESSION_ORGANIZATION_MOVE_ACTION_SPECS,
  ...LIST_REORDER_ACTION_SPECS,
  ...TODO_SESSION_LINK_ACTION_SPECS,
  ...INTERNAL_TASK_ACTION_SPECS,
  ...SESSION_TERMINAL_ACTION_SPECS,
  ...SESSION_AGENT_TRANSITION_ACTION_SPECS,
  ...APP_SHELL_ACTION_SPECS,
  ...NOTIFICATION_CONFIGURATION_ACTION_SPECS,
  ...APP_UPDATE_ACTION_SPECS,
  ...UPDATES_ACTION_SPECS,
  ...CLIPBOARD_ACTION_SPECS,
  ...CODE_INTELLIGENCE_ACTION_SPECS,
  ...VOICE_CONVERSATION_ACTION_SPECS,
  ...SCOPE_ACTION_SPECS,
  ...DIAGNOSTICS_ACTION_SPECS,
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_MIDDLE = Object.freeze(defineActionSpecs([
  ...WORK_BOARD_ACTION_SPECS_V1,
  ...WIDGET_INSTANCE_ACTION_SPECS_V1,
  ...WIDGET_DEFINITION_ACTION_SPECS_V1,
  ...WIDGET_LAYOUT_FRAGMENT_ACTION_SPECS_V1,
  ...WIDGET_SNAPSHOT_ACTION_SPECS_V1,
  ...HOME_HUB_LAYOUT_ACTION_SPECS,
  ...PROJECT_SOURCE_ACTION_SPECS_V1,
  ...ARTIFACT_ACCESS_ACTION_SPECS,
  ...ARTIFACT_ACTION_SPECS,
  {
    id: 'launch_profiles.publish', approval: {result: 'required'}, title: 'Publish launch profile', safety: 'danger',
    placements: [], bindings: { rpcMethod: 'launch_profiles.publish', mcpToolName: 'launch_profiles_publish' },
    requiredAuthority: 'account_automation', sideEffectClass: 'write',
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true },
    inputSchema: LaunchProfilePublishInputV1Schema, outputSchema: LaunchProfilePublishOutputV1Schema,
    inputHints: { description: 'Make a launch profile ready to share with a Team. Its secrets stay with you.', title: 'Publish launch profile', fields: [
      { path: 'profileId', title: 'Launch profile id', widget: 'text', required: true },
    ] },
    cli: { acceptsServerId: true, commands: [{ path: ['launch_profiles', 'publish'], visibility: 'canonical' }] },
  },
] as const));

const CAPTURE_VIEW_ACTION_SPECS = Object.freeze(defineActionSpecs([
  {
    id: 'capture.view', approvalPolicy: { pluginCaptureWaiver: true, requiredSurfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'rpc', 'api', 'plugin'] }, approval: {result: 'required'},
    title: 'View host capture',
    description: 'Allow one mounted plugin viewer to view the exact current host capture source. Approval is required by default and may be waived for that plugin in Actions settings.',
    safety: 'safe',
    approvalResultCustody: 'live_only',
    projectObservationOutput: () => ({ admitted: true }),
    placements: [],
    surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: false, rpc: false },
    sideEffectClass: 'read',
    inputSchema: lazyZodSchema(() => z.strictObject({ sourceId: z.string().check(z.minLength(1)), sourceOccurrenceId: z.string().check(z.minLength(1)) })),
    outputSchema: lazyZodSchema(() => z.strictObject({ admitted: z.literal(true), sourceId: z.string().check(z.minLength(1)), sourceOccurrenceId: z.string().check(z.minLength(1)) })),
    inputHints: { fields: [] },
  },
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD = Object.freeze(defineActionSpecs([
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_OPENING,
  ...ACTION_POLICY_ACTION_IDS.map((id): PreNormalizedActionSpec => ({
    id, title: id === 'actions.policy.get' ? 'Read Action policy' : id === 'actions.policy.reset' ? 'Reset Action policy' : 'Change Action policy',
    description: 'Read or change one exact Action policy preference. Default and reset restore inherited audience policy; unrelated preferences remain intact. Policy changes require human authority.',
    approval: { result: 'required' }, originalExecution: { accountRoot: 'allowed', terminalRoot: 'host' },
    ...(id !== 'actions.policy.get' ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    safety: id === 'actions.policy.get' ? 'safe' : 'danger', sideEffectClass: id === 'actions.policy.get' ? 'read' : 'write',
    requiredAuthority: id === 'actions.policy.get' ? 'account_automation' : 'present_user',
    executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: true },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_') },
    inputSchema: ActionPolicyInputSchemas[id], outputSchema: ActionPolicyOutputSchemas[id],
    inputHints: { fields: [
      { path: 'actionId', title: 'Action id', widget: 'text', required: true },
      { path: 'audience', title: 'Audience', widget: 'text', required: id !== 'actions.policy.set' },
      ...(id === 'actions.policy.set' ? [
        { path: 'mode', title: 'Audience policy', widget: 'text' as const },
        { path: 'change', title: 'Policy change', widget: 'json' as const },
      ] : []),
    ] },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  })),
  ...SETTINGS_DECLARATION_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => ({
    id, approval: { result: 'required' }, originalExecution: { accountRoot: 'allowed', terminalRoot: 'host' },
    ...(id === 'settings.get' || id === 'settings.set' || id === 'settings.reset'
      ? { toolExposure: { agent: 'direct' as const } }
      : {}),
    // A present user's own Settings change applies directly; agent and automation callers keep the danger default.
    ...(id === 'settings.set' || id === 'settings.reset' ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    ...(id === 'settings.invoke' ? { approvalPolicy: {
      uiConfirmation: 'direct' as const,
      uiConfirmationForInput: (input: unknown) => readBuiltInSettingsOperationApprovalPolicyV1(input).uiConfirmationRequired,
    }, safetyForInput: (input: unknown): 'danger' | 'safe' => readBuiltInSettingsOperationApprovalPolicyV1(input).requiresApproval ? 'danger' : 'safe' } : {}),
    title: id === 'settings.list' ? 'List settings' : id === 'settings.get' ? 'Read a setting' : id === 'settings.reset' ? 'Reset a setting' : id === 'settings.invoke' ? 'Run a settings operation' : 'Change a setting',
    description: 'Discover settings, read or change their values, or request a settings operation through its owner. Operations retain their human interaction and credential trust requirements. Local preferences belong to the answering client.',
    safety: id === 'settings.set' || id === 'settings.reset' ? 'danger' : 'safe',
    sideEffectClass: id === 'settings.set' || id === 'settings.reset' || id === 'settings.invoke' ? 'write' : 'read',
    requiredAuthority: 'account_automation', executionPlacement: id === 'settings.invoke' ? 'client' : 'account', placements: [],
    executionPlacementForInput: (input: unknown) => {
      if (id === 'settings.list') return 'account';
      if (id === 'settings.invoke') return 'client';
      if (typeof input !== 'object' || input === null || !('anchor' in input)) return 'client';
      const declaration = readBuiltInSettingDeclarationV1(input.anchor);
      if (declaration?.storage?.prerequisite === 'ui_account_encryption_requirement') return 'client';
      return declaration?.storage && declaration.storage.scope !== 'local' ? 'account' : 'client';
    },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_') },
    surfaces: { ui: true, cli: true, rpc: true, agent: true, mcp: true, voice: true },
    inputSchema: SettingsDeclarationActionInputSchemasV1[id], outputSchema: SettingsDeclarationActionOutputSchemasV1[id],
    approvalPresentation: { summary: (input: unknown) => describeSettingsDeclarationApprovalSummaryV1(id, input),
      projectInput: (input: unknown) => projectSettingsDeclarationApprovalInputV1(id, input) },
    inputHints: { fields: id === 'settings.list'
      ? [{ path: 'pageId', title: 'Settings page', widget: 'text' }]
      : [
        { path: 'anchor', title: 'Setting', widget: 'text', required: true },
        ...(id === 'settings.set' ? [{ path: 'value', title: 'New value', widget: 'json' as const, required: true }] : []),
      ] },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  })),
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_MIDDLE,
  ...ROLE_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
    const accountMutation = isAccountRoleMutationV1(id);
    const read = id === 'roles.list' || id === 'roles.get';
    const reports = id === 'session.roles.apply_to_reports';
    const fields: ActionInputFieldHint[] = [];
    if (id.startsWith('session.')) {
      fields.push({ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true });
    }
    if (id !== 'roles.list' && id !== 'session.notes.set' && !reports) {
      fields.push({ path: 'roleId', title: 'Role id', widget: 'text', required: id !== 'roles.create' && id !== 'session.role.set' });
    }
    if (id === 'session.role.set') {
      fields.push({ path: 'answersWorkerQuestions', title: 'Answers its workers’ questions', widget: 'boolean' });
    }
    if (id === 'session.roles.add' || id === 'roles.create' || id === 'roles.update') {
      fields.push({ path: 'role', title: 'Role', widget: 'json', required: true });
    }
    if (id === 'roles.update' || id === 'roles.delete') {
      fields.push({ path: 'expectedRevision', title: 'Expected role revision', widget: 'json', required: true });
    }
    if (id === 'session.roles.override.set' || id === 'roles.override.set') {
      fields.push(
        { path: 'engine', title: 'Engine', widget: 'json' },
        { path: 'runsAs', title: 'Runs as', widget: 'json' },
        { path: 'profileId', title: 'Launch profile id', widget: 'text' },
        { path: 'workspaceWrites', title: 'Workspace writes', widget: 'select', options: [
          { value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' },
        ] },
        { path: 'secondOpinion', title: 'Second opinion', widget: 'select', options: [
          { value: 'off', label: 'Off' }, { value: 'encouraged', label: 'Encouraged' },
        ] },
      );
      if (id === 'roles.override.set') {
        fields.push({ path: 'instructionsOverride', title: 'Instructions override', widget: 'textarea' });
      }
    }
    if (id === 'session.notes.set') {
      fields.push({ path: 'notes', title: 'Orchestration notes', widget: 'textarea', required: true });
    }
    const voiceArgsExamples: Partial<Record<RoleActionIdV1, string>> = {
      'session.role.set': '{"sessionId":"{{sessionId}}","roleId":"orchestrator"}',
      'session.roles.override.set': '{"sessionId":"{{sessionId}}","roleId":"orchestrator","workspaceWrites":"deny"}',
      'session.roles.override.clear': '{"sessionId":"{{sessionId}}","roleId":"orchestrator"}',
      'session.roles.add': '{"sessionId":"{{sessionId}}","roleId":"scout_notes","role":{"name":"Scout notes","instructions":"Read the workspace and report findings.","runsAs":{"kind":"session"},"workspaceWrites":"deny","secondOpinion":"off","enabled":true}}',
      'session.roles.remove': '{"sessionId":"{{sessionId}}","roleId":"scout_notes"}',
      'session.notes.set': '{"sessionId":"{{sessionId}}","notes":"Verify changes before reporting."}',
      'roles.list': '{}',
      'roles.get': '{"roleId":"orchestrator"}',
    };
    const voiceArgsExample = voiceArgsExamples[id];
    // What a person reads in Settings, approvals and the form; agents read the schema.
    const copy = ({
      'session.role.set': ['Set Session role', 'Choose a session’s role or whether it answers its workers’ questions. Supply at least one choice; omitted choices stay unchanged.'],
      'session.roles.override.set': ['Change a role for one Session', 'Change how a role runs for one session and the sessions under it, leaving your settings as they are.'],
      'session.roles.override.clear': ['Use default role in a Session', 'Remove a session\'s change to a role, so the role runs as set in your settings again.'],
      'session.roles.add': ['Add a role to one Session', 'Give one session a role of its own that the sessions under it can use.'],
      'session.roles.remove': ['Remove a role from one Session', 'Remove a role that was added for one session only.'],
      'session.notes.set': ['Set Session notes', 'Write the notes a lead session keeps for the work it hands out.'],
      'session.roles.apply_to_reports': ['Apply roles to sessions under it', 'Give the sessions under a lead session the roles the lead uses now.'],
      'roles.list': ['List roles', 'See your roles: the built-in ones, the ones you made and the ones shared with you.'],
      'roles.get': ['Read role', 'See one role: its instructions, the agent it runs on and how it runs.'],
      'roles.create': ['Create role', 'Add a role of your own with its instructions and how it runs.'],
      'roles.update': ['Update role', 'Change one of your roles.'],
      'roles.delete': ['Delete role', 'Remove one of your roles. Work that already started with it keeps going.'],
      'roles.override.set': ['Change role settings', 'Adjust a role, such as its agent or instructions, for all your work.'],
      'roles.override.reset': ['Reset role settings', 'Remove your changes to a role and use its original settings.'],
    } as const satisfies Record<RoleActionIdV1, readonly [title: string, summary: string]>)[id];
    return {
      id, approval: { result: 'required' }, title: copy[0], safety: accountMutation ? 'danger' : 'safe',
      ...(['roles.create', 'roles.update', 'roles.override.set'].includes(id)
        ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
      placements: [],
      bindings: { mcpToolName: id.replaceAll('.', '_'), rpcMethod: id },
      surfaces: { ui: true, cli: true, agent: true, mcp: true,
        voice: !accountMutation && !reports, rpc: true },
      sideEffectClass: read ? 'read' : 'write',
      ...(voiceArgsExample ? { examples: { voice: { argsExample: voiceArgsExample } } } : {}),
      inputSchema: RoleActionInputSchemasV1[id],
      outputSchema: RoleActionOutputSchemasV1[id],
      inputHints: { title: copy[0], description: copy[1], fields },
      cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
    };
  }),
  ...PLUGIN_DEV_LOOP_ACTION_IDS_V1.map(createPluginDevLoopActionSpec),
  ...NPM_REGISTRY_PROFILE_ACTION_SPECS_V1,
  ...PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_SPECS,
  ...CAPTURE_VIEW_ACTION_SPECS,
  ...PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1.map(createPluginSettingsAdministrationActionSpec),
  ...PLUGIN_PERMISSION_GRANT_ACTION_IDS_V1.map(createPluginPermissionGrantActionSpec),
  ...PLUGIN_WEBHOOK_ACTION_IDS_V1.map(createPluginWebhookActionSpec),
  ...AUTOMATION_EVENT_ACTION_IDS_V1.map(createAutomationEventActionSpec),
  ...AUTOMATION_CONVERSATION_ACTION_IDS_V1.map(createAutomationConversationActionSpec),
  ...REVIEW_COMMENT_ACTION_IDS_V1.map(createReviewCommentActionSpec),
  // Runtime rows' exact carriers are projected from their family schema maps
  // below. Avoid serializing that complete union again inside this tuple.
  ...(RUNTIME_ACTION_SPECS as readonly PreNormalizedActionSpec[]),
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_OPENING = Object.freeze(defineActionSpecs([
  ...MACHINE_PRESET_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
    const verb = id.slice('machines.presets.'.length);
    const read = id === 'machines.presets.list' || id === 'machines.presets.get';
    const title = `${verb[0]!.toUpperCase()}${verb.slice(1)} Machine preset`;
    return {
      id, approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'direct' }, title, description: `${title} on the exact authenticated Home. Preset changes affect future machines only.`,
      safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'danger', placements: [],
      bindings: { mcpToolName: `machines_presets_${verb}`, voiceClientToolName: `machines_presets_${verb}` },
      surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
      cli: { acceptsServerId: true, commands: [{ path: ['machines', 'presets', verb], visibility: 'canonical' }] },
      inputHints: { title, fields: MACHINE_PRESET_INPUT_FIELDS[id] },
      inputSchema: MachinePresetActionInputSchemasV1[id], outputSchema: MachinePresetActionOutputSchemasV1[id],
      serverTransport: { method: 'POST', path: machinePresetActionEndpointPathV1(id) },
    };
  }),
  ...MANAGED_MACHINE_ACTION_SPECS,
  ...PROJECT_WORKER_ACTION_SPECS,
  ...ACTION_OPERATION_ACTION_SPECS,
  ...MACHINE_POOL_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
    const verb = actionId.slice('machines.pools.'.length);
    const isDelete = actionId === 'machines.pools.delete';
    const isRead = actionId === 'machines.pools.list'
      || actionId === 'machines.pools.get'
      || actionId === 'machines.pools.resolve';
    const titles: Record<MachinePoolActionIdV1, string> = {
      'machines.pools.list': 'List Machine Pools',
      'machines.pools.get': 'Get Machine Pool',
      'machines.pools.create': 'Create Machine Pool',
      'machines.pools.update': 'Update Machine Pool',
      'machines.pools.delete': 'Delete Machine Pool',
      'machines.pools.resolve': 'Resolve Machine Pool target',
    };
    return {
      id: actionId, approval: isRead ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
      ...(isDelete ? { approvalPolicy: { uiConfirmation: 'policy' as const } } : {}),
      ...(isDelete ? { confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true as const } : {}),
      title: titles[actionId],
      description: `${titles[actionId]} on the authenticated Home.`,
      safety: isDelete ? 'danger' : 'safe',
      sideEffectClass: isDelete ? 'danger' : isRead ? 'read' : 'write',
      placements: [],
      bindings: { mcpToolName: `machines_pools_${verb}` },
      surfaces: {
        ui: true,
        voice: false,
        agent: true,
        mcp: true,
        cli: true,
        rpc: false,
      },
      cli: {
        acceptsServerId: true,
        commands: [{
          path: ['machines', 'pools', verb],
          visibility: 'canonical',
        }],
      },
      inputHints: { title: titles[actionId], fields: MACHINE_POOL_INPUT_FIELDS[actionId] },
      inputSchema: MachinePoolActionInputSchemasV1[actionId],
      outputSchema: MachinePoolActionOutputSchemasV1[actionId],
      serverTransport: {
        method: 'POST',
        path: machinePoolActionEndpointPathV1(actionId),
      },
    };
  }),
  ...EPHEMERAL_RUNNER_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
    const titles: Record<EphemeralRunnerActionIdV1, string> = {
      'sessions.runner.activation.create': 'Create Temporary computer request',
      'sessions.runner.activation.get': 'Get Temporary computer request',
      'sessions.runner.activation.cancel': 'Cancel Temporary computer request',
    };
    const isRead = actionId === 'sessions.runner.activation.get';
    return {
      id: actionId, approval: isRead ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
      title: titles[actionId],
      description: `${titles[actionId]} on the exact authenticated Home.`,
      safety: actionId === 'sessions.runner.activation.cancel' ? 'danger' : 'safe',
      sideEffectClass: isRead ? 'read' : actionId === 'sessions.runner.activation.cancel' ? 'danger' : 'write',
      placements: [],
      bindings: {},
      surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false },
      inputHints: { title: titles[actionId], fields: [] },
      inputSchema: EphemeralRunnerActionInputSchemasV1[actionId],
      outputSchema: EphemeralRunnerActionOutputSchemasV1[actionId],
      serverTransport: EPHEMERAL_RUNNER_ACTION_TRANSPORTS_V1[actionId],
    };
  }),
  {
    id: 'account.plugins.data.erase', approval: {result: 'required'},
    title: 'Erase Account plugin data',
    description: 'Erase the current Account’s retained data for one plugin without uninstalling local plugin code.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'danger',
    outputSchema: PluginAccountDataEraseActionOutputV1Schema,
    inputSchema: PluginAccountDataEraseActionInputV1Schema,
    inputHints: {
      title: 'Erase Account plugin data',
      description: 'This permanently removes the current Account’s retained data for the selected plugin.',
      fields: [
        { path: 'pluginId', title: 'Plugin id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'account.sessions.signOutEverywhere', approval: {result: 'required'},
    accountAuthorityRetirementStatuses: ['signed_out'],
    title: 'Sign out everywhere',
    description: 'Invalidate all signed sessions for the current Account. API tokens remain active.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'danger',
    outputSchema: AccountSessionsSignOutEverywhereActionOutputV1Schema,
    inputSchema: AccountSessionsSignOutEverywhereActionInputV1Schema,
    inputHints: {
      title: 'Sign out everywhere',
      description: 'This invalidates signed sessions for the current Account. API tokens remain active.',
      fields: [],
    },
  },
  {
    id: 'account.encryption.automationTemplates.recover', approval: {result: 'required'},
    placements: [],
    bindings: { mcpToolName: 'account_encryption_automation_templates_recover' },
    title: 'Recover older automation templates',
    description: 'Recover encrypted predecessor templates on a plain Account using genuine historical material held by the invoking client. Each template uses version CAS; retained encrypted Session templates and historical keys remain unchanged.',
    safety: 'danger',
    sideEffectClass: 'write',
    requiredAuthority: 'present_user',
    surfaces: { ui: true, voice: false, mcp: true, cli: false, agent: true, rpc: false },
    inputSchema: AccountEncryptionAutomationTemplatesRecoverInputV1Schema,
    outputSchema: AccountEncryptionAutomationTemplatesRecoverResultV1Schema,
    inputHints: { title: 'Recover older automation templates', fields: [] },
  },
  {
    id: 'account.encryption.historicalKey.forget', approval: {result: 'required'},
    confirmVerb: { key: 'common.remove', fallback: 'Remove' }, irreversible: true,
    placements: [],
    bindings: { mcpToolName: 'account_encryption_historical_key_forget' },
    title: 'Forget the old encryption key',
    description: 'Irreversibly discard historical encryption material on the invoking device after disclosing encrypted dependencies and obtaining human confirmation. Server content is not deleted.',
    safety: 'danger',
    sideEffectClass: 'danger',
    requiredAuthority: 'present_user',
    surfaces: { ui: true, voice: false, mcp: true, cli: false, agent: true, rpc: false },
    inputSchema: AccountHistoricalEncryptionKeyForgetInputV1Schema,
    outputSchema: AccountHistoricalEncryptionKeyForgetResultV1Schema,
    inputHints: { title: 'Forget the old encryption key', fields: [] },
  },
  ...([
    {
      id: 'account.security.get', approval: {result: 'required'},
      bindings: { mcpToolName: 'account_security_get' },
      title: 'View Account security',
      description: 'Read the current Account authentication summary without exposing credential material.',
      safety: 'safe',
      sideEffectClass: 'read',
      inputSchema: AccountSecurityGetRequestV1Schema,
      outputSchema: AccountSecurityGetResponseV1Schema,
      serverTransport: { method: 'GET', path: ACCOUNT_SECURITY_PATH_V1 },
    },
    {
      id: 'account.security.terminalPresentUser.set', approval: {result: 'required'},
      bindings: { mcpToolName: 'account_security_terminal_present_user_set' },
      title: 'Set terminal present-user policy',
      description: 'Set whether trusted terminal credentials may prove present-user authority for this Account.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountTerminalPresentUserPolicySetRequestV1Schema,
      outputSchema: AccountTerminalPresentUserPolicySetResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_TERMINAL_PRESENT_USER_POLICY_PATH_V1 },
    },
    {
      id: 'account.password.enroll', approval: {result: 'required'},
      title: 'Add a password',
      description: 'Enroll email and password authentication for the current Account.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountPasswordEnrollRequestV1Schema,
      outputSchema: AccountPasswordMutationResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_PASSWORD_ENROLL_PATH_V1 },
    },
    {
      id: 'account.password.change', approval: {result: 'required'},
      title: 'Change password',
      description: 'Replace the current Account password credential.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountPasswordChangeRequestV1Schema,
      outputSchema: AccountPasswordMutationResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_PASSWORD_CHANGE_PATH_V1 },
    },
    {
      id: 'account.password.remove', approval: {result: 'required'},
      title: 'Remove password',
      description: 'Remove email and password authentication after verifying another viable sign-in route.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountPasswordRemoveRequestV1Schema,
      outputSchema: AccountPasswordMutationResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_PASSWORD_REMOVE_PATH_V1 },
    },
    {
      id: 'account.email.change.request', approval: {result: 'required'},
      title: 'Change sign-in email',
      description: 'Send verification for a replacement sign-in email address.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountEmailChangeRequestV1Schema,
      outputSchema: AccountEmailChangeRequestResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1 },
    },
  ] as const).map((spec): PreNormalizedActionSpec => ({
    ...spec,
    // This private security choice must be reviewed even though the shared security
    // observer projection below deliberately omits Account policy values.
    ...(spec.id === 'account.security.terminalPresentUser.set'
      ? { approvalPresentation: { summary: () => null, projectInput: (input: unknown) => input } }
      : {}),
    // Enrollment, change and removal carry credential material, one-time
    // verification bearers and reauthentication proofs. That input may never
    // become durable Approval Artifact custody: a required confirmation keeps
    // the admitted present-user invocation as the waiter, and the Artifact
    // carries only the observation projection below.
    ...(spec.id === 'account.password.enroll'
      || spec.id === 'account.password.change'
      || spec.id === 'account.password.remove'
      ? { approvalInputCustody: 'live_only' as const }
      : {}),
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      // Trusted interactive CLI hosts are application-owned surfaces that prove
      // present_user, collect secrets locally, and use the canonical direct
      // confirmation host. Automated raw-input requests need an authenticated
      // decision continuation; an approval Artifact cannot confer that authority.
      cli: true,
      rpc: false,
    },
    inputHints: { title: spec.title, fields: [] },
    projectObservationInput: (input: unknown) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
      const record = input as Readonly<Record<string, unknown>>;
      return {
        ...(record.v === 1 ? { v: 1 } : {}),
        ...(record.kind === 'plain' || record.kind === 'e2ee' ? { kind: record.kind } : {}),
        ...(typeof record.expectedCredentialRevision === 'number'
          ? { expectedCredentialRevision: record.expectedCredentialRevision }
          : {}),
      };
    },
  })),
  {
    id: 'account.apiTokens.create', approval: { flow: 'blocking', result: 'required' },
    bindings: { mcpToolName: 'account_api_tokens_create' },
    title: 'Create API token',
    description: 'Create a named API token for the current Account, optionally with trusted-device-prepared encryption access. The token secret is shown once.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
    },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensCreateActionOutputV1Schema,
    projectObservationOutput: projectAccountApiTokenCreationObservation,
    // The bearer is shown once and stored only as a digest (L02 PLAN "no ...
    // compound credential reaches ... approval history"); like the Team external
    // key, it stays on the admitted invocation and never in a durable Artifact.
    approvalResultCustody: 'live_only',
    inputSchema: AccountApiTokensCreateActionInputV1Schema,
    approvalPresentation: { summary: (input: unknown) => {
      const value = AccountApiTokensCreateActionInputV1Schema.parse(input);
      return [
        value.grant === undefined ? 'Full API-eligible access.' : 'Access is defined by the reviewed grant.',
        value.expiresAt ? `Expires ${value.expiresAt}.` : 'No expiry.',
        `Encryption access: ${value.encryption ? 'yes' : 'no'}.`,
        `Unattended Team access: ${value.authorizeUnattendedTeamAccess === true ? 'yes' : 'no'}.`,
      ].join(' ');
    } },
    inputHints: {
      title: 'Create API token',
      description: 'The full token is displayed once after creation.',
      fields: [
        { path: 'tokenId', title: 'Token id', widget: 'text', required: true },
        { path: 'label', title: 'Label', widget: 'text', required: true },
        { path: 'expiresAt', title: 'Expiry', widget: 'text' },
        { path: 'grant', title: 'Access grant (omitted means full access)', widget: 'json' },
        { path: 'encryption', title: 'Encryption access (omitted means none)', widget: 'json' },
        { path: 'authorizeUnattendedTeamAccess', title: 'Authorize unattended Team access', widget: 'boolean' },
        { path: 'embedConfig', title: 'Embed configuration', widget: 'json' },
      ],
    },
  },
  {
    id: 'account.apiTokens.list', approval: {result: 'required'},
    bindings: { mcpToolName: 'account_api_tokens_list' },
    title: 'List API tokens',
    description: 'List non-secret API-token summaries for the current Account.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
      // Signed Session roots can read summaries; PAT self-management stays on
      // the dedicated bearer-only native routes.
      api: false,
    },
    sideEffectClass: 'read',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensListActionOutputV1Schema,
    inputSchema: AccountApiTokensListActionInputV1Schema,
    inputHints: {
      title: 'List API tokens',
      description: 'Returns labels, prefixes, timestamps, and whether encryption access is present; no token secret is returned.',
      fields: [],
    },
  },
  {
    id: 'account.apiTokens.update', approval: {result: 'required'},
    bindings: { mcpToolName: 'account_api_tokens_update' },
    title: 'Update API token access',
    description: 'Update the label, grant, or embed configuration of one API token for the current Account.',
    safety: 'danger',
    placements: [],
    surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: true, rpc: false },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensUpdateActionOutputV1Schema,
    inputSchema: AccountApiTokensUpdateActionInputV1Schema,
    inputHints: { title: 'Update API token access', fields: [
      { path: 'tokenId', title: 'Token id', widget: 'text', required: true },
      { path: 'label', title: 'Label', widget: 'text' },
      { path: 'grant', title: 'Access grant', widget: 'json' },
      { path: 'embedConfig', title: 'Embed configuration', widget: 'json' },
    ] },
  },
  {
    id: 'account.apiTokens.revoke', approval: {result: 'required'},
    confirmVerb: { key: 'files.reviewComments.durable.directWriteGrant.revoke', fallback: 'Revoke' }, irreversible: true,
    bindings: { mcpToolName: 'account_api_tokens_revoke' },
    title: 'Revoke API token',
    description: 'Revoke one API token for the current Account.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
    },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensRevokeActionOutputV1Schema,
    inputSchema: AccountApiTokensRevokeActionInputV1Schema,
    inputHints: {
      title: 'Revoke API token',
      description: 'The token stops working on the server’s next verification.',
      fields: [
        { path: 'tokenId', title: 'Token id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'account.apiTokens.revokeAll', approval: {result: 'required'},
    confirmVerb: { key: 'files.reviewComments.durable.directWriteGrant.revoke', fallback: 'Revoke' }, irreversible: true,
    bindings: { mcpToolName: 'account_api_tokens_revoke_all' },
    title: 'Revoke all API tokens',
    description: 'Revoke every API token for the current Account. Signed sessions are unaffected.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
    },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensRevokeAllActionOutputV1Schema,
    inputSchema: AccountApiTokensRevokeAllActionInputV1Schema,
    inputHints: {
      title: 'Revoke all API tokens',
      description: 'This permanently revokes every API token for the current Account.',
      fields: [],
    },
  },
  {
    id: 'action.spec.search', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'required'},
    title: 'Search action specs',
    sideEffectClass: 'read',
    description: 'Search available Happier action specs by name, description, bindings, and field hints.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'searchActionSpecs', mcpToolName: 'action_spec_search' },
    examples: {
      voice: { argsExample: '{"query":"plan mode","limit":5}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Search action specs',
      description: 'Use this before guessing action ids or tool names.',
      fields: [
        { path: 'query', title: 'Query', description: 'Natural-language search text.', widget: 'text' },
        { path: 'limit', title: 'Limit', description: 'Maximum number of action specs to return.', widget: 'text' },
      ],
    },
    cli: {
      acceptsServerId: true,
      commands: [{
        path: ['actions', 'search'],
        variadicPositional: 'query',
        visibility: 'canonical',
      }],
      inputSchema: ActionSpecSearchCliInputSchema,
      inputHints: {
        title: 'Search action specs',
        description: 'Use this before guessing action ids or tool names.',
        fields: [
          { path: 'query', title: 'Query words', description: 'Natural-language search text.', widget: 'text' },
          { path: 'limit', title: 'Limit', description: 'Maximum number of action specs to return.', widget: 'text' },
        ],
      },
      bindInput: (value) => {
        const parsed = ActionSpecSearchCliInputSchema.parse(value);
        return {
          query: parsed.query.join(' '),
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        };
      },
    },
    outputSchema: ActionSpecSearchResultSchema,
    inputSchema: ActionSpecSearchInputSchema,
  },
  {
    id: 'action.spec.get', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'required'},
    title: 'Get action spec',
    sideEffectClass: 'read',
    description: 'Get a Happier action spec, hints, examples and invoking Session context. Agent, MCP and CLI results reference named schemaSections: retrieve any section with the same id and schemaPath. Nothing is truncated. Section-local # references resolve against the original inputSchema or outputSchema root. Set includeOutputSchema:true for outputs. UI/API keep full schemas. Session Board actions fill omitted sessionId from the invoking Session; widget Actions require a qualified surface: use invocationContext.widgetSurface for this Session Board, changing only owner to {kind:"home"} for Home. Never guess serverId/accountId.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'getActionSpec', mcpToolName: 'action_spec_get' },
    examples: {
      voice: { argsExample: '{"id":"subagents.plan.start"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Get action spec',
      fields: [
        { path: 'id', title: 'Action id', description: 'The exact Happier action id.', widget: 'text', required: true },
        { path: 'includeOutputSchema', title: 'Include output schema', description: 'Include the complete output schema. Defaults to false for Agent, MCP and CLI discovery; true on other surfaces.', widget: 'boolean' },
        { path: 'schemaPath', title: 'Schema section', description: 'Read a schemaSections path from the same Action. JSON Pointer into the original inputSchema/outputSchema; named definitions are complete and local references keep their original root.', widget: 'text' },
      ],
    },
    cli: {
      acceptsServerId: true,
      commands: [{
        path: ['actions', 'get'],
        positionals: ['id'],
        visibility: 'canonical',
      }],
    },
    outputSchema: ActionSpecGetResultSchema,
    inputSchema: ActionSpecGetInputSchema,
  },
  {
    id: 'wait', approval: {result: 'required'},
    title: 'Wait for work',
    description: 'Observe an existing Home-qualified handle without polling or stopping its work. Prefer notifyParentOnCompletion or Follow for parent delivery. Reuse the same handle after an observation timeout.',
    sideEffectClass: 'read',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    bindings: { mcpToolName: 'wait' },
    surfaces: { ui: false, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: WAIT_CLI_PROJECTION,
    inputSchema: WaitActionInputV1Schema,
    outputSchema: WaitActionResultV1Schema,
    inputHints: { fields: [
      { path: 'target', title: 'Home-qualified work handle', widget: 'json', required: true },
      { path: 'condition', title: 'Observation condition', widget: 'json', required: true },
      { path: 'timeout.durationMs', title: 'Observation timeout in milliseconds', widget: 'text' },
    ] },
  },
  {
    id: 'notifications.notify_me', approval: {result: 'required'},
    title: 'Notify me',
    description: "Send a notification to your Account's configured channels, following your delivery policy.",
    sideEffectClass: 'write',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    placements: [],
    bindings: {
      voiceClientToolName: 'notifyMe',
      mcpToolName: 'notifications_notify_me',
      rpcMethod: 'notifications.notify_me',
    },
    examples: {
      voice: { argsExample: '{"title":"Tests finished","message":"The test run on the API branch passed."}' },
    },
    surfaces: { ui: false, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: {
      title: 'Notify me',
      fields: [
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'title', title: 'Title', widget: 'text' },
        { path: 'open', title: 'Open', description: 'Optional Session or Workflow run link.', widget: 'json' },
        { path: 'channels', title: 'Send to', widget: 'multiselect', optionsSourceId: 'notifications.channels.available' },
      ],
    },
    cli: {
      acceptsServerId: true,
      commands: [{ path: ['notify'], positionals: ['message'], visibility: 'canonical' }],
      flagAliases: [{ path: 'message', aliases: ['-p'] }, { path: 'title', aliases: ['-t'] }],
    },
    inputSchema: NotificationsNotifyMeInputV1Schema,
    outputSchema: NotificationsNotifyMeResultV1Schema,
  },
  {
    id: 'action.options.resolve', approval: {result: 'required'},
    title: 'Resolve action options',
    sideEffectClass: 'read',
    description: 'Resolve valid options for one Action field or one declared workflow/widget input. Provide actionId and fieldPath, consumer and fieldPath, or a direct optionsSourceId. A consumer always requires fieldPath.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'resolveActionOptions', mcpToolName: 'action_options_resolve', rpcMethod: 'action.options.resolve' },
    examples: {
      voice: { argsExample: '{"actionId":"subagents.plan.start","fieldPath":"backendTargetKeys","sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Resolve action options',
      description: 'Resolve choices for a specific input with static options, an optionsSourceId, or an input type. For a workflow consumer, fieldPath is the declared input name; it is not the inputs container.',
      fields: [
        { path: 'actionId', title: 'Action id', description: 'Optional when consumer or optionsSourceId is provided directly.', widget: 'text' },
        { path: 'consumer', title: 'Input consumer', description: 'The schema-defined workflow or widget consumer reference. Workflow consumers identify kind workflow and a workflow reference; supply that workflow input name in fieldPath.', widget: 'json' },
        { path: 'fieldPath', title: 'Field path', description: 'Required with actionId or consumer. Use the Action input dot-path, or the declared workflow input name without an inputs prefix. A known workflow with an unknown name returns availableFields in its refusal details.', widget: 'text' },
        { path: 'optionsSourceId', title: 'Options source id', description: 'Direct options source lookup when known.', widget: 'text' },
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', description: 'Omit to use the current invoking Session. Set only for an intentional authorized cross-Session target.', widget: 'text' },
        { path: 'draftInput', title: 'Partial action input', description: 'Dependent inventory context: for execution.run.start use {"backendTargetKey":"<backend option.value>"} for model, config, or connected-service choices; backendTarget alone does not select an inventory. Ergonomic multi-backend starts use backendTargetKeys. Session spawn uses its agentTarget and executionTarget objects.', widget: 'json' },
        { path: 'query', title: 'Query filter', description: 'Optional search text to filter the returned options.', widget: 'text' },
        { path: 'limit', title: 'Limit', description: 'Maximum number of options to return.', widget: 'text' },
        { path: 'values', title: 'Values', description: 'Return only the options for these values, to check a picked value without reading the whole inventory. A source that can answer directly does; any other is read in full and narrowed.', widget: 'json' },
      ],
    },
    outputSchema: ActionOptionsResolveResultSchema,
    inputSchema: ActionOptionsResolveInputSchema,
  },
  {
    id: 'action.invoke', approval: {result: 'required'},
    title: 'Invoke contributed action',
    description: 'Invoke one currently available contributed Action through the canonical host dispatcher. If the result is `denied`, the person declined the confirmation: report that and do not invoke it again unless they ask.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: [],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'invokeAction', rpcMethod: 'action.invoke' },
    examples: {
      voice: { argsExample: '{"action":{"pluginId":"acme.plugin","localId":"open-details"},"input":{"source":"voice"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Invoke contributed action',
      description: 'Use the exact qualified Action identity returned by action discovery and only its declared input.',
      fields: [
        { path: 'action.pluginId', title: 'Plugin id', widget: 'text', required: true },
        { path: 'action.localId', title: 'Action id', widget: 'text', required: true },
        { path: 'input', title: 'Declared Action input', widget: 'textarea' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ActionInvokeInputSchema,
  },
  {
    id: 'review.start', approval: {result: 'optional',flow: 'deferred'},
    title: 'Start review',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/review', '/h.review'] },
    bindings: { voiceClientToolName: 'startReview', mcpToolName: 'review_start' },
    inputHints: {
      title: 'Start a code review',
      description: 'Start one or more parallel review runs against the current worktree.',
      fields: [
        {
          path: 'engineIds',
          title: 'Review engines',
          description: 'Select one or more engines. Each engine runs as its own execution run.',
          widget: 'multiselect',
          required: true,
          requireExplicitSelection: true,
          optionsSourceId: 'review.engines.available',
        },
        {
          path: 'outputs', title: 'Also write a walkthrough', widget: 'multiselect',
          options: [{ value: 'walkthrough', label: 'Walkthrough' }],
        },
        {
          path: 'comparisonId', title: 'Captured comparison', widget: 'text',
          description: 'Saved exact comparison identity required when requesting a walkthrough.',
        },
        {
          path: 'narrator.engineId', title: 'Narrator', widget: 'select',
          description: 'Optional explicit capable engine; defaults to the first selected capable reviewer.',
          optionsSourceId: 'review.engines.available',
        },
        { path: 'narrator.modelId', title: 'Narrator model', widget: 'text' },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the reviewers to focus on.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'teamCredentialModel',
          title: 'Team credential model (json)',
          description: 'Optional exact Team credential resource/model selection from the recipient-safe Team catalog. Requires one review engine.',
          widget: 'json',
          optionsSourceId: 'teams.credential_models.available',
        },
        {
          path: 'secretReferenceOverlay',
          title: 'Saved Secret overrides (json)',
          description: 'Optional value-free Saved Secret references for this launch only. Values are resolved by the exact daemon and the selected Profile is not changed.',
          widget: 'json',
        },
        {
          path: 'changeType',
          title: 'Change type',
          description: 'Which changes to review.',
          widget: 'select',
          required: true,
          options: [
            { value: 'committed', label: 'Committed' },
            { value: 'uncommitted', label: 'Uncommitted' },
            { value: 'all', label: 'All' },
          ],
        },
        {
          path: 'base.kind',
          title: 'Base selection',
          description: 'How to define the review base for engines that need it.',
          widget: 'select',
          required: true,
          options: [
            { value: 'none', label: 'None' },
            { value: 'branch', label: 'Base branch' },
            { value: 'commit', label: 'Base commit' },
          ],
        },
        {
          path: 'base.baseBranch',
          title: 'Base branch',
          description: 'Branch name to diff against (when base.kind=branch).',
          widget: 'text',
          visibleWhen: { op: 'eq', path: 'base.kind', value: 'branch' },
          requiredWhen: { op: 'eq', path: 'base.kind', value: 'branch' },
        },
        {
          path: 'base.baseCommit',
          title: 'Base commit',
          description: 'Commit SHA to diff against (when base.kind=commit).',
          widget: 'text',
          visibleWhen: { op: 'eq', path: 'base.kind', value: 'commit' },
          requiredWhen: { op: 'eq', path: 'base.kind', value: 'commit' },
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"engineIds":["codex"],"instructions":"Review this.","changeType":"uncommitted","base":{"kind":"none"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ReviewStartInputSchema,
    completion: reviewStartCompletion,
  },
  {
    id: 'review.walkthrough', approval: {result: 'optional',flow: 'deferred'},
    title: 'Walk through review',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['session_action_menu', 'command_palette', 'voice_panel'],
    bindings: { voiceClientToolName: 'reviewWalkthrough', mcpToolName: 'review_walkthrough' },
    cli: { commands: [{ path: ['review', 'walkthrough'], visibility: 'canonical' }] },
    examples: { voice: { argsExample: '{"runId":"review-1","comparisonId":"comparison-1"}' } },
    inputHints: { description: 'Have an agent walk you through a finished review, change by change.', fields: [
      { path: 'target.kind', title: 'Detached target', widget: 'select', options: [{ value: 'detached', label: 'Machine workspace (no Session)' }] },
      { path: 'runId', title: 'Reviewer Run', widget: 'text', required: true },
      { path: 'reviewRunIds', title: 'Reviewer Runs', widget: 'text_list', listSeparator: 'comma' },
      { path: 'comparisonId', title: 'Captured comparison', widget: 'text', required: true },
      { path: 'narrator.engineId', title: 'Narrator', widget: 'select', optionsSourceId: 'review.engines.available' },
      { path: 'narrator.modelId', title: 'Narrator model', widget: 'text' },
    ] },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: ReviewWalkthroughInputSchema,
    outputSchema: StrictJsonValueSchema,
    completion: reviewWalkthroughCompletion,
  },
  {
    id: 'review.explain_findings', approval: {result: 'optional',flow: 'deferred'},
    title: 'Explain review findings',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['session_action_menu', 'command_palette', 'voice_panel'],
    bindings: { voiceClientToolName: 'reviewExplainFindings', mcpToolName: 'review_explain_findings' },
    cli: { commands: [{ path: ['review', 'explain-findings'], visibility: 'canonical' }] },
    examples: { voice: { argsExample: '{"runId":"review-1","cwd":"/repo","resultId":"result-1","expectedRevision":1,"findingIds":[{"runId":"review-1","findingId":"finding-1"}]}' } },
    inputHints: { description: 'Have an agent explain chosen review findings: what is wrong, why it matters and what to do.', fields: [
      { path: 'target.kind', title: 'Detached target', widget: 'select', options: [{ value: 'detached', label: 'Machine workspace (no Session)' }] },
      { path: 'runId', title: 'Reviewer Run', widget: 'text', required: true },
      { path: 'reviewRunIds', title: 'Reviewer Runs', widget: 'text_list', listSeparator: 'comma' },
      { path: 'cwd', title: 'Repository', widget: 'text', required: true },
      { path: 'resultId', title: 'Saved result', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Current result revision', widget: 'integer', required: true },
      { path: 'findingIds', title: 'Finding Run identities', widget: 'json', required: true },
      { path: 'instructions', title: 'Instructions', widget: 'textarea' },
    ] },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: ReviewExplainFindingsInputSchema,
    outputSchema: StrictJsonValueSchema,
  },
  {
    id: 'subagents.plan.start', approval: {result: 'optional',flow: 'deferred'},
    title: 'Start plan run',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.plan'] },
    bindings: { voiceClientToolName: 'startPlan', mcpToolName: 'subagents_plan_start' },
    inputHints: {
      title: 'Start a planning run',
      description: 'Start one or more Happier-managed planning runs using selected Agent backend targets; targets are Agent choices, not parallelism capacity.',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Agent backend targets',
          description: 'Select Agent backend targets for Happier-managed runs; use repeated launches or Agent-native subagents for homogeneous parallelism capacity, not parallelism capacity in this field.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
          maxSelections: 1,
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the planner(s) to do.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'modelId',
          title: 'Model id',
          description: 'Optional explicit model applied to every started run. Omit to inherit the applied parent choice for an attached child; independent starts use defaults.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'teamCredentialModel',
          title: 'Team credential model (json)',
          description: 'Optional exact Team credential resource/model selection from the recipient-safe Team catalog. Mutually exclusive with modelSelection.',
          widget: 'json',
          optionsSourceId: 'teams.credential_models.available',
        },
        {
          path: 'secretReferenceOverlay',
          title: 'Saved Secret overrides (json)',
          description: 'Optional value-free Saved Secret references for this launch only. Values are resolved by the exact daemon and the selected Profile is not changed.',
          widget: 'json',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional agent config-option overrides applied to every started run, e.g. {"reasoning_effort":"high"}. Merged canonically; a conflict with sessionConfigOptionOverrides fails.',
          widget: 'json',
          optionsSourceId: 'agents.config_options.available',
        },
        {
          path: 'connectedServices',
          title: 'Connected services (json)',
          description: 'Optional blanket connected-services selection for every target. Attached omission inherits the parent choice; independent starts use Account defaults. Use "native" to suppress connected accounts. An exact connectedServicesByBackendTargetKey entry overrides it.',
          widget: 'json',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
        {
          path: 'connectedServicesByBackendTargetKey',
          title: 'Connected services per target (json)',
          description: 'Optional connected-services selection per backend target key. Accepts "native", a per-service string ("<service>:group:<id>", "<service>:<profileId>", "<service>:native"), an array, or the full object; omitted targets use the blanket selection, attached inheritance, or independent Account defaults. Enumerate valid selections via the shared session-spawn options source.',
          widget: 'textarea',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"backendTargetKeys":["agent:codex"],"instructions":"Plan the changes."}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: false,
	      },
	    outputSchema: StrictJsonValueSchema,
	    inputSchema: PlanStartInputSchema,
	    completion: planStartCompletion,
	  },
  {
    id: 'subagents.delegate.start', approval: {result: 'optional',flow: 'deferred'},
    title: 'Start delegate run',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.delegate'] },
    bindings: { voiceClientToolName: 'startDelegate', mcpToolName: 'subagents_delegate_start' },
    inputHints: {
      title: 'Start a delegation run',
      description: 'Start one or more Happier-managed delegation runs using selected Agent backend targets; targets are Agent choices, not parallelism capacity.',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Agent backend targets',
          description: 'Select Agent backend targets for Happier-managed runs; use repeated launches or Agent-native subagents for homogeneous parallelism capacity, not parallelism capacity in this field.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
          maxSelections: 1,
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the delegate(s) to do.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'permissionMode',
          title: 'Permission mode',
          description: EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
          widget: 'select',
          options: EXECUTION_RUN_ACTION_PERMISSION_INPUTS.map((value) => ({ value, label: value })),
        },
        {
          path: 'modelId',
          title: 'Model id',
          description: 'Optional explicit model applied to every started run. Omit to inherit the applied parent choice for an attached child; independent starts use defaults.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'teamCredentialModel',
          title: 'Team credential model (json)',
          description: 'Optional exact Team credential resource/model selection from the recipient-safe Team catalog. Requires one Agent backend target.',
          widget: 'json',
          optionsSourceId: 'teams.credential_models.available',
        },
        {
          path: 'secretReferenceOverlay',
          title: 'Saved Secret overrides (json)',
          description: 'Optional value-free Saved Secret references for this launch only. Values are resolved by the exact daemon and the selected Profile is not changed.',
          widget: 'json',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional agent config-option overrides applied to every started run, e.g. {"reasoning_effort":"high"}. Merged canonically; a conflict with sessionConfigOptionOverrides fails.',
          widget: 'json',
          optionsSourceId: 'agents.config_options.available',
        },
        {
          path: 'connectedServices',
          title: 'Connected services (json)',
          description: 'Optional blanket connected-services selection for every target. Attached omission inherits the parent choice; independent starts use Account defaults. Use "native" to suppress connected accounts. An exact connectedServicesByBackendTargetKey entry overrides it.',
          widget: 'json',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
        {
          path: 'connectedServicesByBackendTargetKey',
          title: 'Connected services per target (json)',
          description: 'Optional connected-services selection per backend target key. Accepts "native", a per-service string ("<service>:group:<id>", "<service>:<profileId>", "<service>:native"), an array, or the full object; omitted targets use the blanket selection, attached inheritance, or independent Account defaults. Enumerate valid selections via the shared session-spawn options source.',
          widget: 'textarea',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"backendTargetKeys":["agent:codex"],"instructions":"Delegate the task."}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: false,
	      },
	    outputSchema: StrictJsonValueSchema,
	    inputSchema: DelegateStartInputSchema,
	  },
  {
    id: 'voice_agent.start', approval: {result: 'optional',flow: 'deferred'},
    title: 'Start voice agent run',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['voice_panel'],
    slash: { tokens: ['/h.voice'] },
    bindings: { voiceClientToolName: 'startVoiceAgentRun', mcpToolName: 'voice_agent_start' },
    inputHints: {
      title: 'Start a voice agent run',
      description: 'Start a voice agent execution run (typically used by the voice control plane).',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Agent backend targets',
          description: 'Select Agent backend targets for the Happier-managed voice agent run; this is not parallelism capacity.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
          maxSelections: 1,
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'Initial instructions for the voice agent run.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'connectedServices',
          title: 'Connected services (json)',
          description: 'Optional blanket connected-services selection for every target. An exact connectedServicesByBackendTargetKey entry overrides it.',
          widget: 'json',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
        {
          path: 'connectedServicesByBackendTargetKey',
          title: 'Connected services per target (json)',
          description: 'Optional per-target override using the exact selected backend target key.',
          widget: 'json',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"backendTargetKeys":["agent:codex"],"instructions":"Start the voice assistant for this workspace."}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: VoiceAgentStartInputSchema,
  },
  {
    id: 'sessions.subagents.list', approval: {result: 'required'},
    title: 'List session subagents',
    description: 'Return bounded provider-neutral subagent projections for a session.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_LIST },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: lazyZodSchema(() => z.array(SubagentRefV1Schema)),
    inputSchema: SubagentListInputSchema,
    inputHints: {
      title: 'List session subagents',
      description: 'Reads a bounded provider-neutral subagent projection snapshot.',
      fields: [
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
        { path: 'groupId', title: 'Group id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.get', approval: {result: 'required'},
    title: 'Get session subagent',
    description: 'Return one provider-neutral subagent projection by id.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_GET },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: lazyZodSchema(() => z.nullable(SubagentRefV1Schema)),
    inputSchema: SubagentGetInputSchema,
    inputHints: {
      title: 'Get session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.watch', approval: {result: 'required'},
    title: 'Watch session subagents',
    description: 'Register the bounded host subagent watcher path and return its initial typed projection snapshot.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_WATCH },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentWatchSnapshotOutputSchema,
    inputSchema: SubagentWatchInputSchema,
    inputHints: {
      title: 'Watch session subagents',
      description: 'Uses the bounded host subagent watcher path and returns the initial snapshot for the RPC caller.',
      fields: [
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
        { path: 'id', title: 'Subagent id', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.upsert', approval: {result: 'optional',flow: 'deferred'},
    title: 'Record session subagent',
    description: 'Create or replace a provider-neutral subagent projection with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_UPSERT },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentRefInputV1Schema,
    inputHints: { description: 'Add or replace the record of a helper agent working under a session, so it shows in that session\'s work.',
      title: 'Record session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'origin', title: 'Origin', widget: 'text', required: true },
        { path: 'kind', title: 'Kind', widget: 'text', required: true },
        { path: 'status', title: 'Status', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.updateStatus', approval: {result: 'optional',flow: 'deferred'},
    title: 'Update session subagent status',
    description: 'Update subagent lifecycle status with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_UPDATE_STATUS },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentStatusUpdateInputSchema,
    inputHints: { description: 'Record whether a helper agent under a session is working, done or failed.',
      title: 'Update session subagent status',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'status', title: 'Status', widget: 'text', required: true },
        { path: 'completedAt', title: 'Completed at', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.complete', approval: {result: 'optional',flow: 'deferred'},
    title: 'Complete session subagent',
    description: 'Mark a subagent terminal with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_COMPLETE },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentCompleteInputSchema,
    inputHints: {
      title: 'Complete session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'status', title: 'Terminal status', widget: 'text' },
        { path: 'completedAt', title: 'Completed at', widget: 'text' },
      ],
    },
  },
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_MIDDLE = Object.freeze(defineActionSpecs([
  {
    id: 'execution.run.start', approval: {result: 'optional',flow: 'deferred'},
    title: 'Start execution run',
    description: `Start a new execution run. Resolve dependent model, config, and connected-service options with draftInput.backendTargetKey set to the selected backend option.value; then supply the schema-defined backendTarget object to start. Set waitForCompletion=true to wait for a terminal run result. waitTimeoutSeconds only bounds this observation; it never stops, retries, or starts the run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_START,
      voiceClientToolName: 'startExecutionRun',
      mcpToolName: 'execution_run_start',
    },
    sideEffectClass: 'write',
    examples: {
      mcp: {
        argsExample: '{"intent":"delegate","backendTarget":{"kind":"backend","backendId":"codex","sourceKind":"built_in"},"instructions":"Summarize recent changes.","permissionMode":"read_only","retentionPolicy":"ephemeral","runClass":"bounded","ioMode":"request_response","waitForCompletion":true,"waitTimeoutSeconds":60}',
      },
      voice: {
        argsExample: '{"intent":"delegate","backendTarget":{"kind":"backend","backendId":"codex","sourceKind":"built_in"},"instructions":"Summarize recent changes.","permissionMode":"read_only","retentionPolicy":"ephemeral","runClass":"bounded","ioMode":"request_response"}',
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    cli: EXECUTION_RUN_START_CLI_PROJECTION,
    surfaceBindings: {
      plugin: {
        inputSchema: ExecutionRunStartPluginInputSchema,
      },
    },
    inputHints: {
      title: 'Start a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'intent', title: 'Intent', description: 'Choose the purpose and its accepted retentionPolicy, runClass and ioMode together. Delegate covers ordinary bounded child work; Voice serves ongoing conversations.', widget: 'select', required: true, options: EXECUTION_RUN_INTENT_OPTIONS },
        { path: 'backendTarget', title: 'Backend target (json)', widget: 'textarea', required: true },
        { path: 'instructions', title: 'Instructions', widget: 'textarea' },
        {
          path: 'permissionMode',
          title: 'Permission intent',
          description: EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
          widget: 'select',
          required: true,
          options: EXECUTION_RUN_ACTION_PERMISSION_INPUTS.map((value) => ({ value, label: value })),
        },
        { path: 'retentionPolicy', title: 'Retention policy', widget: 'text', required: true },
        { path: 'runClass', title: 'Run class', widget: 'text', required: true },
        { path: 'ioMode', title: 'IO mode', widget: 'text', required: true },
        {
          path: 'waitForCompletion',
          title: 'Wait for completion',
          description: 'Return the terminal run disposition under wait instead of returning immediately after start.',
          widget: 'boolean',
        },
        {
          path: 'waitTimeoutSeconds',
          title: 'Wait timeout seconds',
          description: 'Optional observation deadline; requires waitForCompletion=true and never stops the run.',
          widget: 'text',
        },
        { path: 'initialContextMode', title: 'Initial context mode', widget: 'text' },
        {
          path: 'modelId',
          title: 'Model id',
          description: 'Optional explicit model for the run backend. Assign the model option.value string, not the {value,label} choice object or a stamped Session snapshot. Attached omission inherits the applied parent choice; independent starts use defaults.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional scalar overrides keyed by config-option ids, e.g. {"reasoning_effort":"high"}. Supply draftInput.modelId for model-scoped choices. Config-option choices name ids; read agents.config_options.list with modelId for their value choices. These are not stamped Session configuration fields. Merged into sessionConfigOptionOverrides at the boundary; a conflict fails with invalid_parameters.',
          widget: 'json',
          optionsSourceId: 'agents.config_options.available',
        },
        {
          path: 'connectedServices',
          title: 'Connected services (json)',
          description: 'Optional connected-services selection for the run backend. Accepts "native", a per-service string ("<service>:group:<id>", "<service>:<profileId>", "<service>:native"), an array, or the full object. Attached omission inherits the parent choice; independent starts use Account defaults. Enumerate valid selections via the shared session-spawn options source.',
          widget: 'textarea',
          optionsSourceId: 'sessions.spawn.connected_services.available',
        },
        {
          path: 'secretReferenceOverlay',
          title: 'Saved Secret overrides (json)',
          description: 'Optional value-free Saved Secret references for this launch only. Values are resolved by the exact daemon and the selected Profile is not changed.',
          widget: 'json',
        },
      ],
    },
    outputSchema: ExecutionRunStartResponseSchema,
    inputSchema: ExecutionRunStartInputSchema,
  },
  {
    id: 'execution.run.list', approval: {result: 'required'},
    title: 'List execution runs',
    description: `List agent execution runs in the selected scope. Saved workflow definitions are read with workflow.definition.list; workflow Run history is read with workflow.run.list. An empty runs result says only that this execution scope has no matching runs. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_list', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.runs'] },
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_LIST, voiceClientToolName: 'listExecutionRuns', mcpToolName: 'execution_run_list' },
    sideEffectClass: 'read',
    inputHints: {
      title: 'List execution runs',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'backendTarget', title: 'Backend target', widget: 'text' },
        {
          path: 'status',
          title: 'Status',
          widget: 'select',
          options: [
            { value: 'running', label: 'Running' },
            { value: 'succeeded', label: 'Succeeded' },
            { value: 'failed', label: 'Failed' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'timeout', label: 'Timeout' },
          ],
        },
        { path: 'limit', title: 'Max runs', widget: 'text' },
      ],
    },
    examples: {
      voice: { argsExample: '{"status":"running","limit":10}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: true,
	      },
	    cli: EXECUTION_RUN_LIST_CLI_PROJECTION,
	    outputSchema: ExecutionRunListResponseSchema,
    inputSchema: lazyZodSchema(() => z.extend(ExecutionRunListRequestSchema, {
      sessionId: ExecutionRunScopeSessionIdSchema,
    })),
	  },
  {
    id: 'execution.run.get', approval: {result: 'required'},
    title: 'Get execution run',
    description: `Get one execution run from the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_list', 'run_card', 'command_palette'],
    prompting: { voiceHotPath: true },
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_GET, voiceClientToolName: 'getExecutionRun', mcpToolName: 'execution_run_get' },
    sideEffectClass: 'read',
    examples: {
      voice: { argsExample: '{"sessionId":null,"runId":"run_123","includeStructured":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    cli: EXECUTION_RUN_GET_CLI_PROJECTION,
    inputHints: {
      title: 'Get a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'includeStructured', title: 'Include structured output', widget: 'boolean' },
      ],
    },
    outputSchema: ExecutionRunGetResponseSchema,
    inputSchema: ExecutionRunGetInputSchema,
  },
  {
    id: 'execution.run.send', approval: {result: 'optional',flow: 'deferred'},
    title: 'Send to detached execution run',
    description: 'Send a message to a detached execution run on the selected Machine. Requires sessionId: null. Session-owned runs use session.message.send with a recipient.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_SEND, mcpToolName: 'execution_run_send' },
    sideEffectClass: 'write',
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Send to detached run',
      fields: [
        { path: 'sessionId', title: 'Detached scope (null)', widget: 'text', required: true },
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: ExecutionRunSendResponseSchema,
    inputSchema: DetachedExecutionRunSendInputSchema,
  },
  {
    id: 'execution.run.ensure', approval: {result: 'optional',flow: 'deferred'},
    title: 'Ensure execution run',
    description: `Ensure an existing execution run is active or resumable. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, mcpToolName: 'execution_run_ensure' },
    sideEffectClass: 'write',
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'run', 'ensure'], visibility: 'canonical' }] },
    inputHints: {
      title: 'Ensure a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunEnsureInputSchema,
  },
  {
    id: 'execution.run.ensure_or_start', approval: {result: 'optional',flow: 'deferred'},
    title: 'Ensure or start execution run',
    description: `Ensure an existing execution run, or start a new one when no run id is supplied. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      rpcMethodAliases: [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1],
    },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Ensure or start a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text' },
        { path: 'start', title: 'Start request (json)', widget: 'textarea' },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunEnsureOrStartInputSchema,
  },
  {
    id: 'execution.run.stream.start', approval: {result: 'optional',flow: 'deferred'},
    title: 'Start execution run stream',
    description: `Start a bounded streaming turn for an execution run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_STREAM_START_CLI_PROJECTION,
    inputHints: {
      title: 'Start a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'displayMessage', title: 'Display message', widget: 'textarea' },
        { path: 'resume', title: 'Resume if needed', widget: 'boolean' },
      ],
    },
    outputSchema: lazyZodSchema(() => z.lazy(() => ExecutionRunTurnStreamStartResponseSchema)),
    inputSchema: ExecutionRunStreamStartInputSchema,
  },
  {
    id: 'execution.run.stream.read', approval: {result: 'required'},
    title: 'Read execution run stream',
    description: `Read bounded deltas from an execution-run stream cursor. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_STREAM_READ_CLI_PROJECTION,
    inputHints: {
      title: 'Read a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'streamId', title: 'Stream id', widget: 'text', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxEvents', title: 'Max events', widget: 'text' },
      ],
    },
    outputSchema: lazyZodSchema(() => z.lazy(() => ExecutionRunTurnStreamReadResponseSchema)),
    inputSchema: ExecutionRunStreamReadInputSchema,
  },
  {
    id: 'execution.run.stream.cancel', approval: {result: 'optional',flow: 'deferred'},
    title: 'Cancel execution run stream',
    description: `Cancel a bounded streaming turn for an execution run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: false,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_STREAM_CANCEL_CLI_PROJECTION,
    inputHints: {
      title: 'Cancel a run stream',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'streamId', title: 'Stream id', widget: 'text', required: true },
      ],
    },
    outputSchema: lazyZodSchema(() => z.lazy(() => ExecutionRunTurnStreamCancelResponseSchema)),
    inputSchema: ExecutionRunStreamCancelInputSchema,
  },
  {
    id: 'execution.run.stop', approval: {result: 'optional',flow: 'deferred'},
    title: 'Stop execution run',
    description: `Stop one execution run in the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card', 'run_list'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STOP, voiceClientToolName: 'stopExecutionRun', mcpToolName: 'execution_run_stop' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123"}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      agent: true,
	      mcp: true,
	      cli: true,
	      rpc: true,
	      },
	    cli: EXECUTION_RUN_STOP_CLI_PROJECTION,
	    inputHints: {
	      title: 'Stop a run',
	      fields: [
          EXECUTION_RUN_SESSION_SCOPE_HINT,
          { path: 'runId', title: 'Run id', widget: 'text', required: true },
        ],
	    },
	    outputSchema: ExecutionRunStopResponseSchema,
	    inputSchema: ExecutionRunIdInputSchema,
	  },
  {
    id: 'execution.run.cancel_turn', approval: {result: 'optional',flow: 'deferred'},
    title: 'Cancel this response',
    description: `Cancel the addressed active response without stopping its execution run. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1, mcpToolName: 'execution_run_cancel_turn' },
    sideEffectClass: 'write',
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: {
      title: 'Cancel this response',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'occurrenceId', title: 'Occurrence id', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
      ],
    },
    outputSchema: ExecutionRunCancelTurnResponseSchema,
    inputSchema: lazyZodSchema(() => z.extend(ExecutionRunCancelTurnRequestSchema, { sessionId: ExecutionRunScopeSessionIdSchema })),
  },
  {
    id: 'execution.run.action', approval: {result: 'optional',flow: 'deferred'},
    title: 'Apply execution run action',
    description: `Apply an action to one execution run in the selected scope. ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: ['run_card'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, voiceClientToolName: 'actionExecutionRun', mcpToolName: 'execution_run_action' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123","actionId":"voice_agent.commit","input":{"maxChars":1200}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Run action',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'actionId', title: 'Action id', widget: 'text', required: true },
        { path: 'input', title: 'Input (JSON)', widget: 'textarea' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ExecutionRunActionInputSchema,
  },
  {
    id: 'execution.run.permission.respond', approval: {result: 'optional',flow: 'deferred'},
    title: 'Answer detached run request',
    description: 'Approve or deny a permission request, or answer a structured question, on an exact detached execution run. Only a present user may answer; autonomous callers can discover this operation but cannot execute it.',
    safety: 'safe',
    requiredAuthority: 'present_user',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND },
    sideEffectClass: 'write',
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: { title: 'Answer a detached run request', fields: [
      { path: 'runId', title: 'Run id', widget: 'text', required: true },
      { path: 'requestId', title: 'Request id', widget: 'text', required: true },
      { path: 'approved', title: 'Approve permission', widget: 'boolean' },
      { path: 'answers', title: 'Question answers (JSON)', widget: 'textarea' },
    ] },
    inputSchema: ExecutionRunPermissionRespondInputSchema,
    outputSchema: lazyZodSchema(() => z.strictObject({ ok: z.literal(true) })),
  },
  {
    id: 'execution.run.wait', approval: {result: 'required'},
    title: 'Wait for execution run',
    description: `Observe an execution run until terminal by default, or select permission attention, either condition, or a changed snapshot. Pass timeoutSeconds to bound the observation; omit it for no Happier-side deadline. ${EXECUTION_RUN_WAIT_OBSERVATION_DESCRIPTION} ${EXECUTION_RUN_SESSION_SCOPE_DESCRIPTION}`,
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
      mcpToolName: 'execution_run_wait',
    },
    sideEffectClass: 'read',
    examples: {
      mcp: { argsExample: '{"sessionId":null,"runId":"run_123"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    cli: EXECUTION_RUN_WAIT_CLI_PROJECTION,
    inputHints: {
      title: 'Wait for a run',
      fields: [
        EXECUTION_RUN_SESSION_SCOPE_HINT,
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'timeoutSeconds', title: 'Timeout seconds (optional)', widget: 'text' },
      ],
    },
    outputSchema: ExecutionRunWaitResultSchema,
    inputSchema: ExecutionRunWaitInputSchema,
    surfaceBindings: {
      api: {
        inputSchema: ExecutionRunWaitPublicInputSchema,
        outputSchema: ExecutionRunWaitResultSchema,
      },
    } satisfies ActionSpecSurfaceBindings,
  },
  {
    id: 'session.open', approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    // Navigation belongs to the answering client, including CLI requests.
    // Only explicit resume without a Workspace destination is headless.
    executionPlacementForInput: (input: unknown) =>
      typeof input === 'object' && input !== null && 'intent' in input && input.intent === 'resume'
        && !('destination' in input) && !('tabId' in input) ? 'session' : 'client',
    title: 'Open session',
    description: 'Open or resume a session, including Files, Walkthrough or pending-only Commits for an SCM comparison. Explicit fresh-folder consent lets the daemon recover a missing managed folder.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    bindings: { voiceClientToolName: 'openSession', mcpToolName: 'session_open' },
    examples: {
      voice: { argsExample: '{"serverId":"{{serverId}}","sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Open a session, or resume it if it has stopped.',
      title: 'Open a session',
      fields: [
        { path: 'tabId', title: 'Workspace tab id (optional)', widget: 'text' },
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'sessionTitle', title: 'Session title', widget: 'text' },
        { path: 'approvedNewDirectoryCreation', title: 'Continue in a fresh folder if the private folder is missing', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionOpenInputSchema,
    cli: { commands: [{ path: ['session', 'open'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.fork', approval: {result: 'optional',flow: 'deferred'},
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'indeterminate',
      presentation: { onStart: 'current' },
    },
    title: 'Fork session',
    sideEffectClass: 'write',
    description: 'Create a new session from the latest state or a selected message using Native or Replay.',
    safety: 'safe',
    placements: ['session_action_menu', 'session_info', 'command_palette', 'slash_command', 'voice_panel', 'agent_input_chips'],
    slash: { tokens: ['fork'] },
    bindings: {
      voiceClientToolName: 'forkSession',
      mcpToolName: 'session_fork',
      rpcMethod: 'session.fork',
      rpcMethodAliases: [RPC_METHODS.SESSION_FORK_PROVIDER_SAFE],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Fork a session',
      description: 'Fork from the latest state or a selected message, using Native or Replay.',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'strategy', title: 'Fork strategy (optional)', widget: 'select', options: [
          { value: 'native', label: 'Native' }, { value: 'replay', label: 'Replay' }, { value: 'auto', label: 'Automatic' },
        ] },
        { path: 'forkPoint', title: 'Fork point (optional)', widget: 'json' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionForkInputSchema,
    cli: { commands: [{ path: ['session', 'fork'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.continue_with_replay', approval: {result: 'optional',flow: 'deferred'},
    title: 'Continue session with replay',
    description: 'Create a continuation session from a replay seed while preserving the existing RPC wire contract.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.continueWithReplay' },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'Start a new session that picks up where an earlier one left off.',
      title: 'Continue with replay',
      fields: [
        { path: 'directory', title: 'Directory', widget: 'text', required: true },
        { path: 'backendTarget', title: 'Backend target', widget: 'text', required: true },
        { path: 'replay', title: 'Replay seed', widget: 'textarea', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionContinueWithReplayRpcParamsSchema,
  },
  {
    id: 'session.rollback', approval: {result: 'required',flow: 'deferred'},
    title: 'Rollback conversation',
    description: 'Roll back conversation state in the selected session.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'session.rollback' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
      },
    inputHints: {
      title: 'Rollback a session conversation',
      description: 'Rewinds conversation state for the selected session.',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionRollbackInputSchema,
  },
  {
    id: 'session.checkpoint_code_rollback', approval: {result: 'required',flow: 'deferred'},
    title: 'Rollback code to checkpoint',
    description: 'Apply a checkpoint-backed code rollback for the selected session turn.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Rollback session code to a checkpoint',
      description: 'Creates a mandatory backup checkpoint before applying a same-worktree reverse patch.',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text', required: true },
      ],
    },
    outputSchema: CheckpointCodeRollbackResultSchema,
    inputSchema: CheckpointCodeRollbackActionRequestSchema,
  },
  {
    id: 'session.checkpoint', approval: {result: 'optional',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Create checkpoint',
    description: 'Create a source-qualified checkpoint for the selected session.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_CHECKPOINT },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Create a session checkpoint',
      description: 'Creates a checkpoint through a selected provider or Happier SCM source.',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'scopes', title: 'Scopes', widget: 'multiselect', options: CHECKPOINT_SCOPE_INPUT_OPTIONS, required: true },
      ],
    },
    outputSchema: SessionCheckpointResultV1Schema,
    inputSchema: SessionCheckpointRequestV1Schema,
  },
  {
    id: 'session.restore', approval: {result: 'optional',flow: 'deferred'},
    title: 'Restore checkpoint',
    description: 'Restore a selected session checkpoint source.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.SESSION_RESTORE },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      title: 'Restore a session checkpoint',
      description: 'Restores from an explicit provider or Happier SCM checkpoint source.',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'scopes', title: 'Scopes', widget: 'multiselect', options: CHECKPOINT_SCOPE_INPUT_OPTIONS, required: true },
        { path: 'candidate.source', title: 'Source', widget: 'select', options: CHECKPOINT_SOURCE_INPUT_OPTIONS, required: true },
      ],
    },
    outputSchema: SessionRestoreResultV1Schema,
    inputSchema: SessionRestoreRequestV1Schema,
  },
  {
    id: 'session.handoff', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    sideEffectClass: 'write',
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    operationReentry: snapshot => snapshot.state === 'running' ? 'reinvoke'
      : snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled' ? 'replay' : 'refuse',
    title: 'Hand off session',
    description: 'Move the current session to another machine or another directory on the same machine while keeping the same session id. Select target storage and workspace transfer behavior explicitly when needed.',
    safety: 'safe',
    placements: ['session_action_menu', 'session_info'],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_START],
      sdkMethod: 'session.handoff.start',
      mcpToolName: 'session_handoff',
      voiceClientToolName: 'session_handoff',
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","targetMachineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      title: 'Hand off a session',
      description: 'Move to another machine or directory on the same machine. The daemon resolves the source and workspace endpoints.',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'targetMachineId', title: 'Target machine id', widget: 'text' },
        { path: 'targetPath', title: 'Target directory', widget: 'text',
          description: 'Destination path on the target machine, including a directory move on the source machine.' },
        { path: 'targetSessionStorageMode', title: 'Target session storage', widget: 'select', options: [
          { value: 'direct', label: 'Direct' }, { value: 'persisted', label: 'Persisted' },
        ] },
        { path: 'workspaceAction', title: 'Workspace transfer', widget: 'json',
          description: 'Workspace intent: none, copy_once, create_relationship, relationship or linked_workspace, with the fields required by that intent. Omit to leave workspace intent unspecified.' },
      ],
    },
    outputSchema: SessionHandoffActionResultV1Schema,
    inputSchema: SessionHandoffInputSchema,
    surfaceBindings: {
      api: { inputSchema: SessionHandoffPublicInputSchema },
      plugin: { inputSchema: SessionHandoffPublicInputSchema },
    },
  },
  {
    id: 'session.handoff.prepare_target', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Prepare session handoff target',
    description: 'Prepare a target machine to receive an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET],
      sdkMethod: 'session.handoff.prepareTarget.start',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'Get another machine ready to take over a running session.',
      title: 'Prepare handoff target',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'sourceMachineId', title: 'Source machine id', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffPrepareTargetRequestSchema,
  },
  {
    id: 'session.handoff.prepare_target_result.get', sideEffectClass: 'read', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'required'},
    title: 'Get session handoff target preparation result',
    description: 'Read the prepared-target result for an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'See whether the machine taking over a session is ready.',
      title: 'Get handoff prepare-target result',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: SessionHandoffPrepareTargetResultGetResponseSchema,
    inputSchema: SessionHandoffPrepareTargetResultGetRequestSchema,
  },
  {
    id: 'session.handoff.prepare_target.resume', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Resume interrupted session handoff target preparation',
    description: 'Explicitly continue one interrupted prepare-target job at its current durable revision.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3 },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      description: 'Continue getting a machine ready to take over a session after an interruption.',
      title: 'Resume interrupted handoff preparation',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'jobId', title: 'Job id', widget: 'text', required: true },
        { path: 'expectedRevision', title: 'Expected revision', widget: 'text', required: true },
        { path: 'attemptId', title: 'Attempt id', widget: 'text', required: true },
      ],
    },
    outputSchema: SessionHandoffPrepareTargetResumeResponseSchema,
    inputSchema: SessionHandoffPrepareTargetResumeRequestSchema,
  },
  {
    id: 'session.handoff.commit', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Commit session handoff',
    description: 'Finalize a prepared session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'Finish moving a session to the machine that is ready for it.',
      title: 'Commit handoff',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffCommitRequestSchema,
  },
  {
    id: 'session.handoff.abort', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Abort session handoff',
    description: 'Cancel an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'Cancel moving a session to another machine; it stays where it is.',
      title: 'Abort handoff',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'reason', title: 'Reason', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffAbortRequestSchema,
  },
  {
    id: 'session.handoff.status.get', sideEffectClass: 'read', originalExecution: { accountRoot: 'allowed' }, approval: {result: 'required'},
    title: 'Get session handoff status',
    description: 'Read scalar status for an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
      rpcMethodAliases: [RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET],
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      },
    inputHints: {
      description: 'See how a session\'s move to another machine is going.',
      title: 'Get handoff status',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHandoffStatusGetRequestSchema,
  },
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_REMAINDER = Object.freeze(defineActionSpecs([
  {
    id: 'workspace.sync.conflict.resolve', approval: {result: 'required',flow: 'deferred'},
    workspaceWrite: true,
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    title: 'Resolve workspace conflict',
    description: 'Apply the exact reviewed workspace entry to the explicitly approved current destinations.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'workspace_sync_conflict_resolve' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    inputHints: {
      description: 'Settle a conflict between linked folders by keeping the version you reviewed.',
      title: 'Resolve workspace conflict',
      fields: [
        { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text', required: true },
        { path: 'hubWorkspaceRefId', title: 'Hub workspace ref id', widget: 'text', required: true },
        { path: 'path', title: 'Conflict path', widget: 'text', required: true },
        { path: 'source', title: 'Reviewed source', widget: 'json', required: true },
        { path: 'targets', title: 'Approved destinations', widget: 'json', required: true },
        { path: 'relationshipIds', title: 'Relationship ids', widget: 'json', required: true },
        { path: 'strategy', title: 'Resolution strategy', widget: 'select', options: [{ value: 'use_source', label: 'Use reviewed source' }, { value: 'keep_both', label: 'Use source and keep alternatives' }], required: true },
      ],
    },
    outputSchema: WorkspaceSyncConflictResolutionResultV1Schema,
    inputSchema: WorkspaceSyncConflictResolveActionInputV1Schema,
  },
  {
    id: 'workspace.sync.relationship.create', approval: {result: 'required',flow: 'deferred'},
    workspaceWrite: true,
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    title: 'Add machine to workspace',
    description: 'Link a workspace to a folder on the machine you choose, which can be the one it is on. Attaching an existing folder preserves its contents; creating from this workspace replaces them.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Add a machine to this workspace',
      description: 'Links this workspace to a folder on the machine you choose.',
      fields: [
        { path: 'sourceWorkspaceRefId', title: 'Source workspace id', widget: 'text', required: true },
        { path: 'targetMachineId', title: 'Target machine id', widget: 'text', required: true },
        { path: 'targetPath', title: 'Target folder', widget: 'text', required: true },
        { path: 'mode', title: 'Sync mode', widget: 'select', options: [
          { value: 'keep_synced', label: 'Replica' },
          { value: 'mirror_exactly', label: 'Exact replica' },
          { value: 'keep_both_in_sync', label: 'Editable copy' },
        ], required: true },
        { path: 'destinationIntent', title: 'Destination', widget: 'select', options: [
          { value: 'use_existing', label: 'Use existing folder' },
          { value: 'materialize_from_source_workspace', label: 'Create from this Workspace' },
        ], required: true },
        { path: 'contentPolicy', title: 'Content policy', widget: 'select', required: true, options: [
          {
            label: 'Git-tracked files',
            description: 'Sync the Git worktree while respecting ignore rules.',
            value: {
              v: 1,
              selection: 'git_worktree',
              extraIgnorePatterns: [],
              extraIncludePatterns: [],
              policyDigest: computeWorkspaceSyncPolicyDigest({
                v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: [],
              }),
            },
          },
          {
            label: 'All files',
            description: 'Sync every file except explicit exclusions.',
            value: {
              v: 1,
              selection: 'all_files',
              extraIgnorePatterns: [],
              extraIncludePatterns: [],
              policyDigest: computeWorkspaceSyncPolicyDigest({
                v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [],
              }),
            },
          },
        ] },
      ],
    },
    outputSchema: WorkspaceSyncRelationshipCreateResultV1Schema,
    inputSchema: WorkspaceSyncRelationshipCreateActionInputV1Schema,
  },
  {
    id: 'workspace.sync.relationship.disable', approval: { result: 'required', flow: 'deferred' },
    approvalPolicy: { uiConfirmation: 'direct' }, workspaceWrite: true,
    title: 'Pause workspace sync', description: 'Pause automatic syncing between two linked folders.',
    safety: 'danger', placements: [], bindings: { mcpToolName: 'workspace_sync_relationship_disable' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Pause automatic syncing until it is resumed.', fields: [
      { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text', required: true },
      { path: 'relationshipId', title: 'Linked folders id', widget: 'text', required: true },
    ] },
    outputSchema: WorkspaceSyncRelationshipDisableActionOutputV1Schema,
    inputSchema: WorkspaceSyncRelationshipDisableActionInputV1Schema,
  },
  {
    id: 'workspace.sync.relationship.enable', approval: { result: 'required', flow: 'deferred' },
    approvalPolicy: { uiConfirmation: 'direct' }, workspaceWrite: true,
    title: 'Resume workspace sync', description: 'Resume automatic syncing between two linked folders.',
    safety: 'danger', placements: [], bindings: { mcpToolName: 'workspace_sync_relationship_enable' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Resume automatic syncing between these linked folders.', fields: [
      { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text', required: true },
      { path: 'relationshipId', title: 'Linked folders id', widget: 'text', required: true },
    ] },
    outputSchema: WorkspaceSyncRelationshipEnableActionOutputV1Schema,
    inputSchema: WorkspaceSyncRelationshipEnableActionInputV1Schema,
  },
  {
    id: 'workspace.sync.relationship.flush', approval: { result: 'required', flow: 'deferred' },
    approvalPolicy: { uiConfirmation: 'direct' }, workspaceWrite: true,
    title: 'Sync workspace now', description: 'Run one synchronization cycle between two linked folders.',
    safety: 'danger', placements: [], bindings: { mcpToolName: 'workspace_sync_relationship_flush' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Synchronize these linked folders now.', fields: [
      { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text', required: true },
      { path: 'relationshipId', title: 'Linked folders id', widget: 'text', required: true },
    ] },
    outputSchema: WorkspaceSyncRelationshipFlushActionOutputV1Schema,
    inputSchema: WorkspaceSyncRelationshipFlushActionInputV1Schema,
  },
  {
    id: 'workspace.sync.relationship.terminate', approval: { result: 'required', flow: 'deferred' },
    approvalPolicy: { uiConfirmation: 'policy' },
    workspaceWrite: true,
    title: 'Stop workspace sync',
    description: 'Permanently stop syncing two linked folders without deleting either one.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'workspace_sync_relationship_terminate' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Stop workspace sync',
      description: 'Sync will stop and the link between these folders will be removed. Files in both workspaces stay in place.',
      fields: [
        { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text', required: true },
        { path: 'relationshipId', title: 'Linked folders id', widget: 'text', required: true },
      ],
    },
    outputSchema: WorkspaceSyncRelationshipTerminateActionOutputV1Schema,
    inputSchema: WorkspaceSyncRelationshipTerminateActionInputV1Schema,
  },
  {
    id: 'workspace.sync.relationships.list', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'List linked workspace relationships',
    description: 'List linked workspace relationships and their current sync status on the exact controller. Missing status stays unknown, never zero.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'workspace_sync_relationships_list' },
    examples: {
      mcp: { argsExample: '{"controllerMachineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See which folders are linked across your machines and whether they are in sync.',
      title: 'List linked workspace relationships',
      fields: [
        { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text' },
        { path: 'workspaceRefId', title: 'Workspace ref id', widget: 'text' },
      ],
    },
    outputSchema: WorkspaceSyncRelationshipsListActionOutputV1Schema,
    inputSchema: WorkspaceSyncRelationshipsListActionInputV1Schema,
  },
  {
    id: 'workspace.sync.conflicts.list', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'List workspace sync conflicts',
    description: 'Read one bounded conflict page for a linked workspace relationship. Pages keep their cursor; coverage can be partial.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'workspace_sync_conflicts_list' },
    examples: {
      mcp: { argsExample: '{"controllerMachineId":"{{machineId}}","relationshipId":"{{relationshipId}}","limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See the files that changed in more than one linked folder.',
      title: 'List workspace sync conflicts',
      fields: [
        { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text', required: true },
        { path: 'relationshipId', title: 'Linked folders id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: WorkspaceSyncConflictsListActionInputV1Schema,
  },
  {
    id: 'workspace.sync.conflict.inspect', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'Inspect workspace sync conflict',
    description: 'Inspect the current endpoint versions of a linked workspace path. Reads current bytes, not history; coverage can be partial.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'workspace_sync_conflict_inspect' },
    examples: {
      mcp: { argsExample: '{"controllerMachineId":"{{machineId}}","workspaceRefId":"{{workspaceRefId}}","path":"src/index.ts"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Compare the versions of a file that changed in more than one linked folder.',
      title: 'Inspect workspace sync conflict',
      fields: [
        { path: 'controllerMachineId', title: 'Controller machine id', widget: 'text' },
        { path: 'workspaceRefId', title: 'Workspace ref id', widget: 'text', required: true },
        { path: 'path', title: 'Conflict path', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: WorkspaceSyncConflictInspectActionInputV1Schema,
  },
  {
    id: 'session.authoring.open', approval: {result: 'required'},
    title: 'Open editable Session draft',
    description: 'Open the ordinary editable New Session composer in an answering Happier client with a validated seed. Nothing starts until the user explicitly sends. Returns typed unavailability when no client can answer.',
    sideEffectClass: 'external',
    safety: 'safe',
    executionPlacement: 'client',
    placements: [],
    bindings: { voiceClientToolName: 'openSessionAuthoring', mcpToolName: 'session_authoring_open' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'authoring', 'open'], visibility: 'canonical' }] },
    inputHints: { title: 'Open editable Session draft', fields: [
      { path: 'seed', title: 'New Session seed', widget: 'json' },
      { path: 'sourceSession', title: 'Source Session address', widget: 'json' },
    ] },
    examples: { voice: { argsExample: '{"seed":{"prompt":"Help me author this checkout."}}' } },
    inputSchema: SessionAuthoringOpenV1Schema,
    outputSchema: SessionAuthoringOpenResultV1Schema,
  },
  {
    id: 'session.spawn_new', originalExecution: { accountRoot: 'allowed', terminalRoot: 'host' }, approval: {result: 'optional',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    operation: {
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    },
    operationReentry: snapshot => {
      if (snapshot.state === 'running') return 'resume';
      if (snapshot.state === 'succeeded') {
        const settlement = SessionSpawnNewResultV1Schema.safeParse(snapshot.result);
        if (settlement.success && settlement.data.type === 'error' && settlement.data.retryable) return 'fresh';
        return 'replay';
      }
      return snapshot.state === 'failed' || snapshot.state === 'cancelled' ? 'replay' : 'refuse';
    },
    title: 'Create session',
    description: 'Create a new session on the requested machine using the selected Agent. Pass directory {kind:"path",path} for a folder or {kind:"managed"} for no folder: Happier creates a private folder for this session.',
    sideEffectClass: 'write',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    bindings: {
      rpcMethod: RPC_METHODS.SESSION_SPAWN_NEW,
      voiceClientToolName: 'spawnSession',
      mcpToolName: 'session_spawn_new',
    },
    surfaceBindings: {
      api: {
        inputSchema: SessionSpawnNewApiInputSchema,
        bindInput: bindApiSessionSpawnNewInput,
        inputHints: SessionSpawnNewApiInputHints,
      },
      rpc: {
        inputSchema: SessionSpawnNewRpcInputSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: SessionSpawnNewResultV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    examples: {
      voice: { argsExample: '{"executionTarget":{"serverId":"active","machineId":"machine-1"},"directory":{"kind":"path","path":"/workspace/project"},"agentTarget":{"kind":"agent","identity":{"pluginId":"happier.agent.claude","localId":"claude"}},"initialInput":{"text":"Help me inspect this workspace."}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: SessionSpawnNewInputHints,
    outputSchema: SessionSpawnNewResultV1Schema,
    inputSchema: SessionSpawnNewInputSchema,
  },
  {
    id: 'paths.list_recent', approval: {result: 'required'},
    title: 'List recent paths',
    sideEffectClass: 'read',
    description: 'List recent workspace directory handles (optionally filtered to a machine).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listRecentPaths', mcpToolName: 'paths_list_recent' },
    examples: {
      voice: { argsExample: '{"limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List recent paths',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PathsListRecentInputSchema,
  },
  {
    id: 'projects.context.update', approval: {result: 'required'},
    title: 'Update Project context',
    description: 'Attach, detach, reorder or adjust one personal Project context entry at the reviewed organization row revision.',
    sideEffectClass: 'write',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_context_update' },
    cli: { commands: [{ path: ['projects', 'context', 'update'], visibility: 'canonical' }] },
    // Project owners and the catalog share an import cycle.
    // Publish deferred carriers, not values captured during that import cycle.
    inputSchema: lazyZodSchema(() => ProjectContextUpdateInputV1Schema),
    outputSchema: lazyZodSchema(() => ProjectContextUpdateOutputV1Schema),
    inputHints: { fields: [
      { path: 'target', title: 'Qualified Project', prompt: 'Which project?', widget: 'json', required: true },
      { path: 'expectedRevision', title: 'Reviewed organization revision', widget: 'json', required: true },
      { path: 'intent', title: 'Personal context edit', widget: 'json', required: true },
    ] },
  },
  {
    id: 'projects.visibility.set', approval: {result: 'required'}, title: 'Hide or show a Project',
    description: 'Change visibility for one Home-qualified private Project at the observed organization row revision. Sessions and files remain unchanged.',
    sideEffectClass: 'write', safety: 'safe', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_visibility_set', voiceClientToolName: 'projects_visibility_set' },
    cli: { commands: [{ path: ['projects', 'visibility', 'set'], visibility: 'canonical' }] },
    inputSchema: lazyZodSchema(() => ProjectVisibilitySetInputV1Schema),
    outputSchema: lazyZodSchema(() => ProjectVisibilitySetOutputV1Schema),
    inputHints: { fields: [
      { path: 'target', title: 'Qualified Project', prompt: 'Which project?', widget: 'json', required: true },
      { path: 'expectedRevision', title: 'Reviewed organization revision', widget: 'json', required: true },
      { path: 'hidden', title: 'Hidden', widget: 'boolean', required: true },
    ] },
  },
  {
    id: 'projects.workspace.update', approval: {result: 'required'}, title: 'Update workspace label or pin',
    description: 'Update only label and personal pin metadata for an accepted Home-qualified workspace. Checkout roots, files and Sessions remain unchanged.',
    sideEffectClass: 'write', safety: 'safe', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_workspace_update', voiceClientToolName: 'projects_workspace_update' },
    cli: { acceptsServerId: true, requiresServerId: true, commands: [{ path: ['projects', 'workspace', 'update'], visibility: 'canonical' }] },
    inputSchema: ProjectWorkspaceUpdateInputV1Schema, outputSchema: ProjectWorkspaceUpdateOutputV1Schema,
    inputHints: { fields: [
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'workspaceId', title: 'Workspace id', prompt: 'Which workspace?', widget: 'text', required: true },
      { path: 'label', title: 'Label', widget: 'text' },
      { path: 'pinned', title: 'Pinned', widget: 'boolean' },
    ] },
  },
  {
    id: 'projects.workspace.forget', approval: {result: 'required'}, title: 'Forget a workspace',
    description: 'Forget one accepted Home-qualified private workspace after approval. Linked workspaces are protected; no files, Sessions or Sources are deleted.',
    sideEffectClass: 'danger', safety: 'danger', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_workspace_forget', voiceClientToolName: 'projects_workspace_forget' },
    cli: { acceptsServerId: true, requiresServerId: true, commands: [{ path: ['projects', 'workspace', 'forget'], visibility: 'canonical' }] },
    inputSchema: ProjectWorkspaceForgetInputV1Schema, outputSchema: ProjectWorkspaceForgetOutputV1Schema,
    inputHints: { fields: [
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'workspaceId', title: 'Workspace id', prompt: 'Which workspace?', widget: 'text', required: true },
    ] },
  },
  {
    id: 'projects.list', approval: {result: 'required'},
    title: 'List projects',
    sideEffectClass: 'read',
    description:
      'List the account\'s persisted projects with each one\'s resolved hosting provider and worktrees.',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List projects',
      fields: [
        { path: 'serverId', title: 'Home id', widget: 'text' },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'includeHidden', title: 'Include hidden projects', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ProjectsListInputSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['projects', 'list'], visibility: 'canonical' }] },
  },
  {
    id: 'projects.open', approval: {result: 'required'},
    operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'current' } },
    title: 'Open a project',
    description: 'Prepare the selected checkout on the exact Machine and return its browse address without starting an Agent. Setup requires separate approval; client focus is optional and requires a mounted client.',
    safety: 'danger',
    sideEffectClass: 'danger',
    executionPlacement: 'machine',
    placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'projects_open', voiceClientToolName: 'projects_open' },
    cli: { commands: [{ path: ['projects', 'open'], visibility: 'canonical' }], acceptsServerId: true, requiresServerId: true },
    inputSchema: OpenProjectInputV1Schema,
    outputSchema: OpenProjectResultV1Schema,
    inputHints: {
      title: 'Open a project',
      fields: [
        { path: 'serverId', title: 'Home id', widget: 'text', required: true },
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'source', title: 'Source', widget: 'json', required: true },
        { path: 'ref', title: 'Branch or ref', widget: 'text' },
        { path: 'subdir', title: 'Project subdirectory', widget: 'text' },
        { path: 'materialization', title: 'Checkout choice', widget: 'json', required: true },
      ],
    },
    examples: { voice: { argsExample: '{"serverId":"{{serverId}}","machineId":"{{machineId}}","source":{"kind":"folder","path":"/workspace/project"},"materialization":{"kind":"attach"}}' } },
  },
  {
    id: 'prompts.invocations.list', approval: {result: 'required'},
    title: 'List prompt invocations',
    sideEffectClass: 'read',
    description:
      "List the account's Prompt Library invocations by stable id, without expanding any prompt body.",
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'prompts_invocations_list' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List prompt invocations',
      fields: [
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptInvocationsListInputSchema,
  },
  {
    id: 'prompts.invocation.resolve', approval: {result: 'required'},
    title: 'Resolve a prompt invocation',
    sideEffectClass: 'read',
    description:
      'Resolve one Prompt Library invocation, by its stable id, to the prompt text it produces.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'prompts_invocation_resolve' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Resolve a prompt invocation',
      fields: [
        { path: 'invocationId', title: 'Invocation id', widget: 'text', required: true },
        { path: 'argsText', title: 'Arguments', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptInvocationResolveInputSchema,
  },
  {
    id: 'machines.list', approval: {result: 'required'},
    title: 'List machines',
    sideEffectClass: 'read',
    description: 'List accessible machines on the qualified Home, including shared role, resource mode and current readiness. Offline and pending machines remain visible.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listMachines', mcpToolName: 'machines_list' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List machines',
      fields: [{ path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'refresh', title: 'Refresh machine inventory', widget: 'boolean' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: MachinesListInputSchema,
    cli: {
      commands: [{ path: ['machines', 'list'], visibility: 'canonical' }],
      inputSchema: MachinesListCliInputSchema,
      bindInput: (value) => ({
        ...((value as Readonly<{ serverId?: string }>).serverId ? { serverId: (value as Readonly<{ serverId: string }>).serverId } : {}),
        limit: (value as Readonly<{ limit?: number }>).limit ?? MACHINES_LIST_CLI_DEFAULT_LIMIT,
        ...(typeof (value as Readonly<{ refresh?: boolean }>).refresh === 'boolean' ? { refresh: (value as Readonly<{ refresh: boolean }>).refresh } : {}),
      }),
    },
  },
  {
    id: 'servers.list', approval: {result: 'required'},
    title: 'List servers',
    sideEffectClass: 'read',
    description: 'List servers configured in the client.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listServers' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    inputHints: {
      title: 'List servers',
      fields: [{ path: 'limit', title: 'Limit', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ServersListInputSchema,
  },
  {
    id: 'review.engines.list', approval: {result: 'required'},
    title: 'List review engines',
    sideEffectClass: 'read',
    description: 'List review engines available for an authorized Session or detached Machine.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listReviewEngines', mcpToolName: 'review_engines_list' },
    cli: { commands: [{ path: ['review', 'engines'], visibility: 'canonical' }] },
    executionPlacementForInput: (input: unknown) =>
      typeof input === 'object' && input !== null && 'sessionId' in input && input.sessionId === null
        ? 'machine' : 'session',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","includeDisabled":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List review engines',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'includeDisabled', title: 'Include disabled', widget: 'boolean' },
        { path: 'scope', title: 'Scope', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ReviewEnginesListInputSchema,
  },
  {
    id: 'agents.backends.list', approval: {result: 'required'},
    title: 'List agent backends',
    sideEffectClass: 'read',
    description: 'List available Agent backends for spawning sessions.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentBackends', mcpToolName: 'agents_backends_list' },
    examples: {
      voice: { argsExample: '{"includeDisabled":false,"limit":10,"machineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent backends',
      fields: [
        { path: 'includeDisabled', title: 'Include disabled', widget: 'boolean' },
        { path: 'limit', title: 'Max results', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
      ],
    },
    outputSchema: AgentsBackendsListOutputSchema,
    inputSchema: AgentsBackendsListInputSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['agents', 'backends', 'list'], visibility: 'canonical' }] },
  },
  {
    id: 'machines.agents.list', approval: {result: 'required'},
    title: 'List agents on a machine',
    sideEffectClass: 'read',
    description: 'Read daemon-owned Agent installation, sign-in, platform and update facts for a machine.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_list' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'agents', 'list'], visibility: 'canonical' }] },
    inputHints: {
      title: 'List agents on a machine',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'serverId', title: 'Home id (optional)', widget: 'text' },
        { path: 'agentId', title: 'Agent id (optional)', widget: 'text' },
        { path: 'refresh', title: 'Refresh inventory', widget: 'boolean' },
      ],
    },
    inputSchema: MachinesAgentsListInputSchema,
    outputSchema: MachinesAgentsListOutputSchema,
  },
  {
    id: 'workspace.files.search', approval: {result: 'required'},
    title: 'Search text in workspace files',
    description: 'Search the addressed machine workspace and return one bounded page of grouped text matches with explicit coverage. Refine the query when hasMore is true. Machine and root default to the calling session; supply both for another Machine or outside a session.',
    sideEffectClass: 'read',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'workspace_files_search' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { title: 'Search text in workspace files', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'rootPath', title: 'Workspace root', widget: 'text' },
      { path: 'query', title: 'Search text', widget: 'text' },
      { path: 'matchCase', title: 'Match case', widget: 'boolean' },
      { path: 'regex', title: 'Regular expression', widget: 'boolean' },
      { path: 'includeHidden', title: 'Include hidden files', widget: 'boolean' },
    ] },
    inputSchema: WorkspaceFilesSearchActionInputSchema,
    contextualDefaults: { machineId: 'current_session_machine', rootPath: 'current_session_root' },
    outputSchema: DaemonWorkspaceFileSearchResponseSchema,
  },
  {
    id: 'workspace.files.replace.preview', approval: { result: 'required' },
    title: 'Preview replacement in workspace files',
    description: 'Review matching text and raw file hashes before applying a single-line replacement. Continue with the returned cursor when hasMore is true. Machine and root default to the calling session; supply both for another Machine or outside a session.',
    contextualDefaults: { machineId: 'current_session_machine', rootPath: 'current_session_root' },
    sideEffectClass: 'read', safety: 'safe', placements: [],
    bindings: { mcpToolName: 'workspace_files_replace_preview', rpcMethod: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: WorkspaceFilesReplacePreviewActionInputSchema,
    outputSchema: DaemonWorkspaceFileReplacePreviewResponseSchema,
    inputHints: { fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'rootPath', title: 'Workspace root', widget: 'text' },
      { path: 'query', title: 'Search text', widget: 'text' },
      { path: 'replacement', title: 'Replacement text', widget: 'text' },
    ] },
  },
  {
    id: 'workspace.files.replace', approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'direct' },
    operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'current' } },
    title: 'Replace text in workspace files',
    description: 'Apply a reviewed replacement or restore its inverse edits only when the raw file hashes still match. Machine and root default to the calling session; supply both for another Machine or outside a session.',
    contextualDefaults: { machineId: 'current_session_machine', rootPath: 'current_session_root' },
    sideEffectClass: 'danger', safety: 'danger', placements: [],
    bindings: { mcpToolName: 'workspace_files_replace', sdkMethod: 'workspace.files.replace.apply', rpcMethod: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: WorkspaceFilesReplaceActionInputSchema,
    outputSchema: WorkspaceFilesReplaceActionOutputSchema,
    inputHints: { fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'rootPath', title: 'Workspace root', widget: 'text' },
      { path: 'operation', title: 'Guarded replacement or restore', widget: 'json' },
    ] },
  },
  {
    id: 'machines.agents.signIn.start', approval: {result: 'none'}, approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Sign in to an agent',
    description: 'Connect an accepted account, or open the agent native login on the selected machine.',
    sideEffectClass: 'write', safety: 'danger', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_start' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInStartInputSchema,
    outputSchema: MachinesAgentsSignInStartOutputSchema,
    inputHints: { title: 'Sign in to an agent', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'agentId', title: 'Agent id', widget: 'text' },
      { path: 'method', title: 'Method (connected or native)', widget: 'text' },
      { path: 'serviceId', title: 'Connected service id', widget: 'text' },
    ] },
  },
  {
    id: 'machines.agents.signIn.status', approval: {result: 'none'},
    title: 'Check agent sign-in', sideEffectClass: 'read', safety: 'safe', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_status' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInStatusInputSchema, outputSchema: AgentSignInStatusResponseSchema,
    inputHints: { description: 'See whether an agent is signed in on a machine, or still waiting for you to finish.', title: 'Check agent sign-in', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'agentId', title: 'Agent id', widget: 'text' },
    ] },
  },
  {
    id: 'machines.agents.signIn.cancel', approval: {result: 'none'}, approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Cancel agent sign-in', sideEffectClass: 'write', safety: 'danger', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_cancel' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInCancelInputSchema, outputSchema: MachinesAgentsSignInCancelOutputSchema,
    inputHints: { description: 'Stop an agent sign-in that is still waiting.', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
      { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
      { path: 'terminalId', title: 'Native sign-in terminal id', widget: 'text', required: true },
    ] },
  },
  {
    id: 'machines.agents.signIn.restart', approval: {result: 'none'}, approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Restart agent sign-in', sideEffectClass: 'write', safety: 'danger', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_restart' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInCancelInputSchema, outputSchema: MachinesAgentsSignInStartOutputSchema,
    inputHints: { description: 'Start an agent sign-in over when it stalled or expired.', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
      { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
      { path: 'terminalId', title: 'Native sign-in terminal id', widget: 'text', required: true },
    ] },
  },
  {
    id: 'machines.agents.install', approval: {result: 'required'}, approvalPolicy: { uiConfirmation: 'policy' },
    confirmVerb: { key: 'common.install', fallback: 'Install' },
    title: 'Install or update an agent',
    sideEffectClass: 'danger',
    description: 'Start a daemon-owned agent install or update job.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_install', sdkMethod: 'machines.agents.install.start' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.extend(z.omit(DaemonAgentInstallStartRequestSchema, { expectedDefinitionVersion: true }), {
      machineId: z.string().check(z.minLength(1)),
      intent: z.enum(['install', 'update']),
      consent: z.optional(DaemonAgentInstallStartRequestSchema.shape.consent),
    })),
    outputSchema: DaemonAgentInstallStartResponseSchema,
    cli: { acceptsServerId: true, inputSchema: MachineAgentInstallCliInputSchema,
      flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
      bindInput: (raw, context) => {
        const { yes, allowVendorRecipe, dryRun: _dryRun, version: _version, ...input } = readRecord(raw);
        return { ...input, intent: context.commandPath?.[1] === 'update' ? 'update' : input.intent ?? 'install',
          ...(yes || allowVendorRecipe ? { consent: { vendorRecipe: true } } : {}) };
      },
      commands: [
        { path: ['agents', 'install'], positionals: ['agentId'], visibility: 'canonical' },
        { path: ['agents', 'update'], positionals: ['agentId'], visibility: 'alias' },
        { path: ['install', 'provider'], positionals: ['agentId'], visibility: 'alias' },
      ] },
    inputHints: {
      title: 'Install or update an agent',
      fields: [
        { path: 'machineId', title: 'Machine', widget: 'text' },
        { path: 'agentId', title: 'Agent', widget: 'text' },
        { path: 'definitionId', title: 'Custom agent', widget: 'text' },
        { path: 'intent', title: 'Intent', widget: 'text' },
        { path: 'consent.vendorRecipe', title: 'Allow the vendor install recipe', widget: 'boolean' },
        { path: 'force', title: 'Reinstall an installed agent', widget: 'boolean' },
      ],
    },
  },
  {
    id: 'machines.agents.uninstall', approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'policy' },
    confirmVerb: { key: 'settingsPlugins.uninstall', fallback: 'Uninstall' },
    title: 'Remove an agent from a machine',
    sideEffectClass: 'danger', description: 'Remove a Happier-managed agent installation through the daemon job owner.',
    safety: 'danger', executionPlacement: 'machine', placements: [],
    bindings: { mcpToolName: 'machines_agents_uninstall' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.strictObject({ machineId: z.string().check(z.minLength(1)), agentId: z.string().check(z.minLength(1)),
      definitionId: z.optional(z.string().check(z.minLength(1))) })),
    outputSchema: DaemonAgentInstallStartResponseSchema,
    cli: { acceptsServerId: true, inputSchema: lazyZodSchema(() => z.strictObject({ machineId: z.optional(z.string().check(z.minLength(1))),
      agentId: z.string().check(z.minLength(1)), definitionId: z.optional(z.string().check(z.minLength(1))) })),
      flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
      commands: [{ path: ['agents', 'remove'], positionals: ['agentId'], visibility: 'canonical' }] },
    inputHints: { title: 'Remove an agent from a machine', fields: [
      { path: 'machineId', title: 'Machine', widget: 'text', required: true },
      { path: 'agentId', title: 'Agent', widget: 'text', required: true },
      { path: 'definitionId', title: 'Custom agent', widget: 'text' },
    ] },
  },
  {
    id: 'machines.agents.install.status', approval: {result: 'required'},
    title: 'Read an agent install job',
    description: 'Read the daemon-owned current steps, byte progress, and outcome alongside events after the cursor. Omitting the cursor reads events from the start.',
    sideEffectClass: 'read',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_install_status' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.extend(DaemonAgentInstallReadRequestSchema, {
      machineId: z.string().check(z.minLength(1)), cursor: z.optional(DaemonAgentInstallReadRequestSchema.shape.cursor),
    })),
    outputSchema: DaemonAgentInstallReadResponseSchema,
    cli: { acceptsServerId: true, inputSchema: lazyZodSchema(() => z.strictObject({ machineId: z.optional(z.string().check(z.minLength(1))),
      jobId: z.string().check(z.minLength(1)), cursor: z.optional(z.number().check(z.int(), z.nonnegative())) })),
      flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
      commands: [{ path: ['agents', 'install', 'status'], positionals: ['jobId'], visibility: 'canonical' }] },
    inputHints: { title: 'Read an agent install job', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'jobId', title: 'Job id', widget: 'text' },
      { path: 'cursor', title: 'Event cursor', widget: 'text' },
    ] },
  },
  {
    id: 'machines.agents.install.cancel', approval: {result: 'required'}, approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Cancel agent install',
    sideEffectClass: 'danger',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_install_cancel' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.extend(DaemonAgentInstallCancelRequestSchema, { machineId: z.string().check(z.minLength(1)) })),
    outputSchema: DaemonAgentInstallCancelResponseSchema,
    cli: { acceptsServerId: true, inputSchema: lazyZodSchema(() => z.strictObject({ machineId: z.optional(z.string().check(z.minLength(1))),
      jobId: z.string().check(z.minLength(1)) })), flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
      commands: [{ path: ['agents', 'install', 'cancel'], positionals: ['jobId'], visibility: 'canonical' }] },
    inputHints: { description: 'Stop installing an agent on a machine.', title: 'Cancel agent install', fields: [
      { path: 'machineId', title: 'Machine', widget: 'text' },
      { path: 'jobId', title: 'Install job', widget: 'text' },
    ] },
  },
  {
    id: 'agents.models.list', approval: {result: 'required'},
    title: 'List agent models',
    sideEffectClass: 'read',
    description: 'List available models for an agent backend. Omit serverId; the authenticated host binds the Home.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listAgentModels', mcpToolName: 'agents_models_list' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","backendTargetKey":"backend:plugin-review-bot","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent models',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: AgentsModelsListInputSchema,
    outputSchema: lazyZodSchema(() => inventoryOutputWithProbeObservation(AgentModelsProbeObservationSchema).check(z.superRefine((value, ctx) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'scmDiffSummaryCatalog')) return;
      const catalog = ScmDiffSummaryModelCatalogObservationV1Schema.safeParse(Reflect.get(value, 'scmDiffSummaryCatalog'));
      if (!catalog.success) for (const issue of catalog.error.issues) ctx.addIssue({ ...issue, path: ['scmDiffSummaryCatalog', ...issue.path] });
    }))),
  },
  {
    id: 'agents.config_options.list', approval: {result: 'required'},
    title: 'List agent config options',
    sideEffectClass: 'read',
    description: 'List configurable option definitions for an agent backend without exposing current values. Supply modelId to include that model’s declared options and allowed values alongside session-wide options. Omit serverId; the authenticated host binds the Home.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listAgentConfigOptions', mcpToolName: 'agents_config_options_list' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","backendTargetKey":"agent:happier.agent.claude/claude","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent config options',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', description: 'For an external Agent, retain the runtime agentId returned by backend inventory alongside its qualified backendTargetKey.', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'modelId', title: 'Model id', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: AgentsConfigOptionsListInputSchema,
    outputSchema: lazyZodSchema(() => inventoryOutputWithProbeObservation(AgentConfigOptionsProbeObservationSchema)),
  },
  {
    id: 'agents.session_modes.list', approval: {result: 'required'},
    title: 'List agent session modes',
    sideEffectClass: 'read',
    description: 'List session modes available for an agent backend. Omit serverId; the authenticated host binds the Home.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listAgentSessionModes', mcpToolName: 'agents_session_modes_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"agent:happier.agent.codex/codex","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent session modes',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: AgentSpawnOptionsListInputSchema,
    outputSchema: lazyZodSchema(() => inventoryOutputWithProbeObservation(AgentSessionModesProbeObservationSchema)),
  },
  {
    id: 'sessions.spawn.profiles.list', approval: {result: 'required'},
    title: 'List spawn profiles',
    sideEffectClass: 'read',
    description: 'List Agent launch profile references available for new sessions without exposing secret bindings.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSpawnProfiles', mcpToolName: 'sessions_spawn_profiles_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"agent:happier.agent.codex/codex","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List spawn profiles',
      fields: [
        { path: 'agentId', title: 'Runtime agent id (optional filter)', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key (optional filter)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SpawnProfilesListInputSchema,
  },
  {
    id: 'sessions.spawn.connected_services.list', approval: {result: 'required'},
    title: 'List spawn connected services',
    sideEffectClass: 'read',
    description: 'List connected-service references available for new sessions without exposing credentials. Omit serverId; the authenticated host binds the Home.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSpawnConnectedServices', mcpToolName: 'sessions_spawn_connected_services_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"agent:happier.agent.codex/codex","includeUnavailable":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List spawn connected services',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'includeUnavailable', title: 'Include unavailable', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SpawnConnectedServicesListInputSchema,
  },
  {
    id: 'sessions.spawn.mcp_servers.preview', approval: {result: 'required'},
    title: 'Preview spawn MCP servers',
    sideEffectClass: 'read',
    description: 'Preview MCP servers that would be available to a new session.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'previewSpawnMcpServers', mcpToolName: 'sessions_spawn_mcp_servers_preview' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","machineId":"{{machineId}}","directory":"{{path}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Preview spawn MCP servers',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'directory', title: 'Directory', widget: 'text' },
        { path: 'path', title: 'Path', widget: 'text' },
        { path: 'selection', title: 'Selection', widget: 'json' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SpawnMcpServersPreviewInputSchema,
  },
  {
    id: 'session.message.send', approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'sessionId', cardinality: 'many' },
    title: 'Send a message to a session',
    sideEffectClass: 'external',
    description: 'Send a user message to the AI coding assistant inside the specified session.',
    safety: 'safe',
    placements: ['voice_panel'],
    // Its full routing schema is discovered on demand, then used by action_execute.
    bindings: { voiceClientToolName: 'sendSessionMessage', mcpToolName: 'session_message_send' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","message":"Please inspect the latest changes."}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Send a message to the agent in a session.',
      title: 'Send a message',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'recipient', title: 'Recipient', description: 'Optional participant routing identity; omit to send to the main Session.', widget: 'json' },
        { path: 'permissionModeOverride', title: 'Permission mode override (optional)', widget: 'text' },
        { path: 'modelOverride', title: 'Model override (optional)', widget: 'text' },
        { path: 'providerConnectionId', title: 'Provider connection id (optional)', widget: 'text' },
        { path: 'reply', title: 'Reply mode (optional)', description: 'none sends information; wait observes the exact answer; return hands off its answer to the original Session.', widget: 'select', options: [
          { value: 'none', label: 'No reply' }, { value: 'wait', label: 'Wait' }, { value: 'return', label: 'Return later' },
        ] },
        { path: 'wait', title: 'Wait for message completion (optional)', widget: 'boolean' },
        { path: 'timeoutSeconds', title: 'Timeout seconds (optional)', widget: 'text' },
      ],
    },
    outputSchema: withSessionTargetFanoutResultV1(SessionMessageSendResultV1Schema),
    inputSchema: SessionSendMessageInputSchema,
    cli: { ...SESSION_SEND_CLI_PROJECTION, wholeInputSchema: SessionSendMessagePublicInputSchema },
    surfaceBindings: {
      api: {
        inputSchema: SessionSendMessagePublicInputSchema,
        outputSchema: withSessionTargetFanoutResultV1(SessionMessageSendResultV1Schema),
      },
      plugin: {
        inputSchema: SessionSendMessagePluginInputV1Schema,
        outputSchema: withSessionTargetFanoutResultV1(SessionMessageSendResultV1Schema),
      },
    } satisfies ActionSpecSurfaceBindings,
  },
  {
    id: 'session.message.reply', approval: { result: 'optional', flow: 'deferred' },
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    executionPlacement: 'session',
    title: 'Reply to a Session request',
    description: 'Publish an answer or pass for one exact admitted request in the receiving Session.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_message_reply', voiceClientToolName: 'session_message_reply', rpcMethod: 'session.message.reply' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: { title: 'Reply to a Session request', fields: [
      { path: 'sessionId', title: 'Receiving Session', widget: 'text', required: true },
      { path: 'requestLocalId', title: 'Original input id', widget: 'text', required: true },
      { path: 'reply', title: 'Answer or pass', widget: 'json', required: true },
    ] },
    inputSchema: SessionMessageReplyInputSchema,
    outputSchema: SessionMessageReplyMutationResultV1Schema,
  },
  {
    id: 'discussion.pass', approval: { result: 'optional', flow: 'deferred' },
    executionPlacement: 'session',
    title: 'Pass on the current Discussion question',
    description: 'Settle the current participant’s exact admitted Discussion question with a typed pass, without posting an authored substitute message.',
    sideEffectClass: 'external', safety: 'safe', placements: [],
    bindings: { mcpToolName: 'discussion_pass', voiceClientToolName: 'discussion_pass' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [{ path: 'discussionId', title: 'Discussion id', widget: 'text', required: true }] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.pass'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.pass'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'pass'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.exchange.control', approval: { result: 'optional', flow: 'deferred' },
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    title: 'Control autonomous exchange',
    description: 'Continue, continue ten more turns, or stop work rooted in one original input.',
    sideEffectClass: 'danger',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'session_exchange_control', voiceClientToolName: 'session_exchange_control' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: SessionExchangeControlInputSchema,
    outputSchema: AutonomousExchangeStatusV1Schema,
    surfaceBindings: { api: { inputSchema: SessionExchangeControlPublicInputSchema,
      outputSchema: AutonomousExchangeStatusV1Schema },
      plugin: { inputSchema: SessionExchangeControlPublicInputSchema,
        outputSchema: AutonomousExchangeStatusV1Schema } } satisfies ActionSpecSurfaceBindings,
    cli: { commands: [{ path: ['session', 'exchange', 'control'], positionals: ['sessionId', 'originInputLocalId', 'decision'], visibility: 'canonical' }],
      wholeInputSchema: SessionExchangeControlPublicInputSchema },
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'originInputLocalId', title: 'Original input id', widget: 'text', required: true },
      { path: 'decision', title: 'Control', widget: 'select', required: true,
        options: [
          { value: 'continue', label: 'Continue' },
          { value: 'continue_more', label: 'Continue 10 more' },
          { value: 'stop', label: 'Stop' },
        ] },
      { path: 'additionalTurns', title: 'Additional turns', widget: 'number' },
    ] },
  },
  {
    id: 'session.turn.cancel', approval: {result: 'none'},
    sessionTarget: { field: 'sessionId', cardinality: 'many' },
    title: 'Stop current turn',
    description: 'Request cancellation of the current turn while keeping the session process available.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { voiceClientToolName: 'session_turn_cancel', mcpToolName: 'session_turn_cancel', rpcMethod: 'abort' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: {
      title: 'Stop current turn',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }],
    },
    inputSchema: SessionTurnCancelInputSchema,
    outputSchema: StrictJsonValueSchema,
    cli: { commands: [{ path: ['session', 'turn', 'cancel'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.runtime.refresh', approval: { result: 'none' },
    title: 'Refresh Session runtime',
    description: 'Refresh a stale Session runner on its hosting machine through the same planned restart used by the Session banner. Active child work defers replacement.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'session_runtime_refresh' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.strictObject({
      sessionId: z.string().check(z.trim(), z.minLength(1)),
      machineId: z.string().check(z.trim(), z.minLength(1)),
      serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    })),
    outputSchema: RestartSessionRunnerResultV1Schema,
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'machineId', title: 'Hosting machine id', widget: 'text', required: true },
      { path: 'serverId', title: 'Home id', widget: 'text' },
    ] },
    examples: { mcp: { argsExample: '{"sessionId":"{{sessionId}}","machineId":"{{machineId}}"}' } },
  },
  {
    id: 'session.stop', approval: {result: 'none'},
    sessionTarget: { field: 'sessionId', cardinality: 'many' },
    title: 'Stop session',
    description: 'Request that the local daemon stops the specified session.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { voiceClientToolName: 'session_stop', mcpToolName: 'session_stop', rpcMethod: 'stop-session' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      description: 'Stop a running session.',
      title: 'Stop a session',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTargetRequiredInputSchema,
    cli: SESSION_STOP_CLI_PROJECTION,
  },
  {
    id: 'session.terminalComposer.clear', approval: {result: 'required'},
    title: 'Clear terminal composer',
    description: 'Clear the pending terminal composer draft for a session runtime.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: ['pending_messages'],
    bindings: {
      mcpToolName: 'session_terminal_composer_clear',
      rpcMethod: SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR,
    },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'Clear the text waiting in a session\'s terminal composer.',
      title: 'Clear terminal composer',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'expectedStateAtMs', title: 'Expected state timestamp', widget: 'text' },
      ],
    },
    outputSchema: SessionTerminalComposerClearResultV1Schema,
    inputSchema: SessionTerminalComposerClearRequestV1Schema,
    projectSessionConfirmation: (input, { sessionId }) => {
      const parsed = SessionTerminalComposerClearRequestV1Schema.safeParse(input);
      if (!parsed.success || parsed.data.sessionId !== sessionId) return null;
      return { sessionId,
        ...(parsed.data.expectedStateAtMs !== undefined ? { expectedStateAtMs: parsed.data.expectedStateAtMs } : {}),
      };
    },
  },
  {
    id: 'session.pendingInput.interruptAndRun', approval: {result: 'required'},
    title: 'Interrupt and run now',
    description: 'Interrupt the live provider turn so its exact native queued prompt can run now.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: ['pending_messages'],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN,
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'Interrupt what the agent is doing so your queued message runs now.',
      title: 'Interrupt and run now',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'localId', title: 'Pending message local id', widget: 'text', required: true },
        { path: 'expectedStateAtMs', title: 'Expected state timestamp', widget: 'text' },
      ],
    },
    outputSchema: SessionPendingInputInterruptAndRunResultV1Schema,
    inputSchema: SessionPendingInputInterruptAndRunRequestV1Schema,
    projectSessionConfirmation: (input, { sessionId }) => {
      const parsed = SessionPendingInputInterruptAndRunRequestV1Schema.safeParse(input);
      if (!parsed.success || parsed.data.sessionId !== sessionId) return null;
      return { sessionId, localId: parsed.data.localId,
        ...(parsed.data.expectedStateAtMs !== undefined ? { expectedStateAtMs: parsed.data.expectedStateAtMs } : {}),
      };
    },
  },
] as const));

// Keep exact schema carriers in the source tuples and project them below;
// the runtime aggregate must not serialize their complete schema union again.
const ACTION_SPECS_WITHOUT_APPROVAL_PREFIX: readonly PreNormalizedActionSpec[] = Object.freeze([
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_OPENING,
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_MIDDLE,
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_REMAINDER,
]);

const ACTION_SPECS_WITHOUT_APPROVAL_PENDING: readonly PreNormalizedActionSpec[] = Object.freeze(defineActionSpecs([
  {
    id: 'session.pending.action.set', approval: { result: 'required' }, title: 'Update queued message action',
    description: 'Change the requested action or explicitly resume the exact queued input through its existing pending owner.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    approvalPolicy: { uiConfirmation: 'direct', rpcConfirmation: true }, placements: ['pending_messages'],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'session_pending_action_set', rpcMethod: 'session.pending.action.set' },
    serverTransport: { method: 'PATCH', path: '/v2/sessions/:sessionId/pending/:localId/action' },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'action', 'set'], visibility: 'canonical' }] },
    inputHints: { description: 'Update this pending input; explicitly request resume when it becomes available.', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true },
      { path: 'requestedAction', title: 'Requested action', widget: 'json', required: true },
      { path: 'resumeWhenAvailable', title: 'Resume when available', widget: 'boolean' }] },
    inputSchema: SessionPendingActionSetInputV1Schema, outputSchema: SessionPendingActionSetResultV1Schema,
  },
  {
    id: 'session.pending.markHandled', approval: { result: 'required' }, title: 'Mark pending delivery handled',
    description: 'Resolve historical uncertain input you have confirmed was handled, without sending it again.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    approvalPolicy: { rpcConfirmation: true }, placements: ['pending_messages'],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'session_pending_mark_handled', rpcMethod: 'session.pending.markHandled' },
    serverTransport: { method: 'POST', path: '/v2/sessions/:sessionId/pending/:localId/delivery/handled' },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'mark-handled'], visibility: 'canonical' }] },
    inputHints: { description: 'Confirm this exact pending input has already been handled.', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true }] },
    inputSchema: SessionPendingMarkHandledInputV1Schema, outputSchema: SessionPendingDeliveryRecoveryResultV1Schema,
  },
  {
    id: 'session.pending.dismiss', approval: { result: 'required' }, title: 'Dismiss uncertain pending delivery',
    description: 'Set aside a pending message that may not have been delivered, without sending it again.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    approvalPolicy: { rpcConfirmation: true }, placements: ['pending_messages'],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'session_pending_dismiss', rpcMethod: 'session.pending.dismiss' },
    serverTransport: { method: 'POST', path: '/v2/sessions/:sessionId/pending/:localId/delivery/dismiss' },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'dismiss'], visibility: 'canonical' }] },
    inputHints: { description: 'Set aside a message that may not have been delivered, keeping a record of it.', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true }] },
    inputSchema: SessionPendingDeliveryRecoveryInputV1Schema, outputSchema: SessionPendingDeliveryRecoveryResultV1Schema,
  },
  {
    id: 'session.pending.sendAsNew', approval: { result: 'required' }, title: 'Send pending delivery as new',
    description: 'Replace the exact uncertain input with a new server-owned Pending identity; the agent may have seen the original.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    approvalPolicy: { rpcConfirmation: true }, placements: ['pending_messages'],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'session_pending_send_as_new', rpcMethod: 'session.pending.sendAsNew' },
    serverTransport: { method: 'POST', path: '/v2/sessions/:sessionId/pending/:localId/delivery/send-as-new' },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'send-as-new'], visibility: 'canonical' }] },
    inputHints: { description: 'Send uncertain input again under a new Pending identity.', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true }] },
    inputSchema: SessionPendingDeliveryRecoveryInputV1Schema, outputSchema: SessionPendingSendAsNewResultV1Schema,
  },
  {
    id: 'session.pending.withdraw', approval: {result: 'required'}, title: 'Withdraw queued message',
    description: 'Remove an exact pending message before delivery; delivered or uncertain input cannot be moved back.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    placements: ['pending_messages'],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'session_pending_withdraw', rpcMethod: 'session.pending.withdraw' },
    serverTransport: { method: 'POST', path: '/v2/sessions/:sessionId/pending/:localId/withdraw' },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'withdraw'], visibility: 'canonical' }] },
    inputHints: { description: 'Take back a queued message before the agent receives it.', fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true }] },
    inputSchema: SessionPendingWithdrawInputV1Schema, outputSchema: SessionPendingWithdrawResultV1Schema,
  },
  {
    id: 'session.pending.resetStart.set', originalExecution: { accountRoot: 'allowed', nativePurpose: 'pending_reset_start' }, approval: {result: 'required'}, title: 'Start queued work after quota reset',
    description: 'Hold an existing Pending message against an exact accepted quota witness. Only its admitted machine may release it after the same qualified reset.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    placements: ['pending_messages'],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'session_pending_reset_start_set' },
    cli: { acceptsServerId: true, commands: [] },
    inputHints: { description: 'Hold a queued message until your usage limit resets, then send it.', fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true },
      { path: 'reset', title: 'Qualified accepted reset witness', widget: 'json', required: true }] },
    inputSchema: PendingResetStartSetInputV1Schema, outputSchema: PendingResetStartSetResultV1Schema,
  },
  {
    id: 'session.pending.resetStart.cancel', originalExecution: { accountRoot: 'allowed', nativePurpose: 'pending_reset_start' }, approval: {result: 'required'}, title: 'Cancel reset-bound queued work',
    description: 'Withdraw the exact Pending message through its existing custody owner; already delivered or uncertain input cannot be reported as cancelled.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    placements: ['pending_messages'],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'session_pending_reset_start_cancel' },
    cli: { acceptsServerId: true, commands: [] },
    inputHints: { description: 'Stop holding a queued message for a usage-limit reset.', fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true }] },
    inputSchema: PendingResetStartCancelInputV1Schema, outputSchema: PendingResetStartCancelResultV1Schema,
  },
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_OPENING = Object.freeze(defineActionSpecs([
  {
    id: 'session.update.post', approval: {result: 'required'}, title: 'Post an update',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'session',
    placements: [], bindings: { mcpToolName: 'session_update_post', voiceClientToolName: 'session_update_post', rpcMethod: 'session.update.post' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    cli: { commands: [] },
    inputHints: { description: 'Persist an update from the current session for its selected followers.', fields: [{ path: 'summary', title: 'Update', widget: 'text', required: true }] },
    inputSchema: SessionUpdatePostInputV1Schema, outputSchema: SessionUpdatePostOutputV1Schema,
  },
  // The four shared human/Agent Board intents. People reach them through the UI
  // executor and Agents through the generic Action/tool projection; neither gets a
  // Board-specific dispatcher, parser, or approval rule.
  {
    id: 'session.presentation.apply', approval: {result: 'required'},
    cli: { commands: [{ path: ['session', 'presentation', 'apply'], visibility: 'canonical' }] },
    title: 'Present in the current Session',
    description: 'Apply one reversible Board, Companion, Chat, or Computer/Browser viewer presentation intent to the exact focused client bound to this Agent Session. This never mutates durable Board content or target execution.',
    safety: 'safe',
    sideEffectClass: 'write',
    requiredAuthority: 'account_automation',
    executionPlacement: 'session',
    placements: [],
    bindings: { mcpToolName: 'session_presentation_apply' },
    examples: {
      mcp: { argsExample: '{"intent":{"kind":"board.open","mode":"beside_chat"}}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Present in this Session',
      description: 'Change what this session shows you right now, such as its board or browser. Nothing saved is changed.', fields: [
        { path: 'intent', title: 'Presentation intent', widget: 'json', required: true },
      ],
    },
    inputSchema: CurrentSessionPresentationActionInputV1Schema,
    outputSchema: CurrentSessionPresentationActionResultV1Schema,
  },
  {
    id: 'session.board.get', approval: {result: 'required'},
    title: 'Read Session visuals',
    description: 'Read shared Session visuals and Board placement: item identities, exact revisions, and current Session capabilities. Exact itemIds return full item content.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { voiceClientToolName: 'session_board_get', mcpToolName: SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1['session.board.get'] },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","itemIds":["release-checklist"],"limit":100}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Read Board',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'itemIds', title: 'Exact item ids', widget: 'text_list', listSeparator: 'comma' },
        { path: 'cursor', title: 'Page cursor', widget: 'text' },
        { path: 'limit', title: 'Page size', widget: 'integer' },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.get'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.get'],
    cli: SESSION_BOARD_GET_CLI_PROJECTION,
  },
  {
    id: 'session.board.item.upsert', originalExecution: { nativePurpose: 'session_board_write' }, approvalPolicy: {
      uiConfirmation: 'direct',
      uiConfirmationForInput: (input: unknown) => {
        const item = SessionSurfaceItemV1Schema.safeParse(readRecord(input).item);
        if (!item.success) return true;
        const capabilities = readSessionVisualCapabilitiesV1(item.data);
        // Editing content is reversible; declared egress and host Action access
        // retain the consequence review. Agent contextual safety is unchanged.
        return !capabilities || capabilities.network !== 'none' || capabilities.actions.length > 0;
      },
    }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Show or update a Session visual',
    approvalPresentation: { summary: describeSessionVisualApprovalSummary },
    description: 'Show or update one Session visual at a stable id: declarative charts/tables, hostedHtml bundles, or live widgets. For Daily usage, use item.source.kind="widget" with instance.definition={kind:"builtin",id:"usage_daily"}; bind session to this Session id (null for Account usage), period to {relative:"today"}, and metric to "tokens" or "cost". Live usage reads through the viewer\'s ordinary usage.query Resource admission; no separate Resource tool is needed. Supply item content, or copySource with the exact same-Home source Session, item and revision to create an independent copy in another Session. Same-Session Pin uses layout.update. New visuals default to transcript; board and both destinations require atomic first placement. expectedItemRevision is the exact optimistic-concurrency operand.',
    safety: 'danger',
    sideEffectClass: 'write',
    placements: [],
    bindings: { voiceClientToolName: 'session_board_item_upsert', mcpToolName: SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1['session.board.item.upsert'] },
    serverTransport: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","itemId":"orders","expectedItemRevision":null,"destination":"transcript","item":{"v":1,"title":"Orders by channel","frame":"frameless","height":{"mode":"auto","fallback":"regular"},"source":{"kind":"declarative","document":{"version":1,"root":{"kind":"chart","label":"Orders by channel","style":"bar","data":{"kind":"value","value":[{"day":"Mon","channel":"Online","orders":12},{"day":"Mon","channel":"Shop","orders":7},{"day":"Tue","channel":"Online","orders":15},{"day":"Tue","channel":"Shop","orders":9}]},"rows":[],"x":{"path":["day"],"type":"string"},"series":{"path":["channel"],"type":"string"},"value":{"path":["orders"],"type":"number"}}}}}}',
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Show a Session visual',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'itemId', title: 'Item id', widget: 'text', required: true },
        { path: 'expectedItemRevision', title: 'Expected item revision', widget: 'text', required: true },
        SESSION_VISUAL_DESTINATION_HINT,
        { path: 'item', title: 'Item (or copy source)', widget: 'json' },
        { path: 'copySource', title: 'Exact other-Session visual to copy', widget: 'json' },
        { path: 'placement', title: 'Placement', widget: 'json' },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.item.upsert'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.item.upsert'],
    cli: SESSION_BOARD_ITEM_UPSERT_CLI_PROJECTION,
  },
  {
    id: 'session.board.item.remove', approval: {result: 'optional',flow: 'deferred'},
    title: 'Remove a Session visual',
    description: 'Remove one Session visual. Include expectedLayoutRevision to atomically remove its Board placements. All Session readers lose the visual; installed plugins are unaffected.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: [],
    bindings: { voiceClientToolName: 'session_board_item_remove', mcpToolName: SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1['session.board.item.remove'] },
    serverTransport: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","itemId":"release-checklist","expectedItemRevision":"ssr1.AAAACHN5c3JlY18xAAAAAQ","expectedLayoutRevision":"ssr1.AAAACHN5c3JlY18xAAAAAQ"}',
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Remove a Board item',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'itemId', title: 'Item id', widget: 'text', required: true },
        { path: 'expectedItemRevision', title: 'Expected item revision', widget: 'text', required: true },
        { path: 'expectedLayoutRevision', title: 'Expected layout revision', widget: 'text' },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.item.remove'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.item.remove'],
    cli: SESSION_BOARD_ITEM_REMOVE_CLI_PROJECTION,
  },
  {
    id: 'session.board.layout.update', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Organize the Session Board',
    description: 'Apply exactly one semantic Board organization change: create, rename, move or remove a view, or place, move, unpin, resize or set a shared frame style on an item placement. Frame styles are card or plain; null clears the override. Moves use stable sibling anchors, never indices.',
    safety: 'danger',
    sideEffectClass: 'write',
    placements: [],
    bindings: { voiceClientToolName: 'session_board_layout_update', mcpToolName: SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1['session.board.layout.update'] },
    serverTransport: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","expectedLayoutRevision":"ssr1.AAAACHN5c3JlY18xAAAAAQ","operation":{"op":"item.move","itemId":"release-checklist","fromTabId":"overview","toTabId":"metrics","anchor":{"side":"before","itemId":"burndown"}}}',
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Organize the Board',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'expectedLayoutRevision', title: 'Expected layout revision', widget: 'text', required: true },
        { path: 'operation', title: 'Layout operation', widget: 'json', required: true },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.layout.update'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.layout.update'],
    cli: SESSION_BOARD_LAYOUT_UPDATE_CLI_PROJECTION,
  },

  // The Home-owned Discussion family. People reach these through the UI
  // and CLI executors; an Agent reaches the reads and the deliberate post through
  // the same rows under its own admitted execution principal. Discussion content
  // is sealed and opened by the executor through the existing Discussion key, so
  // these inputs carry strict semantic plaintext and never the storage envelope.
] as const));

const DISCUSSION_ACTION_SPECS_V1 = Object.freeze(defineActionSpecs([
  {
    id: 'discussion.second_opinion.start',
    title: 'Get a second opinion',
    description: 'Preview the quoted source and actual source access, then explicitly Ask one ordinary reviewer in an anchored Discussion. Retry retains the original create, quote, question and participant identities. Multiple reviewers require Fresh opinions and report unavailable while that Workflow producer is unavailable.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', requiredAuthority: 'present_user',
    safetyForInput: (input: unknown) => {
      const parsed = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.second_opinion.start'].safeParse(input);
      return parsed.success && parsed.data.intent === 'preview' ? 'safe' as const : 'danger' as const;
    },
    approval: { result: 'optional', flow: 'deferred' }, approvalPolicy: { uiConfirmation: 'direct' },
    originalExecution: { accountRoot: 'allowed' }, placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'discussion_second_opinion_start', voiceClientToolName: 'discussion_second_opinion_start' },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.second_opinion.start'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.second_opinion.start'],
    inputHints: { fields: [
      { path: 'intent', title: 'Preview or Ask', widget: 'select', required: true,
        options: [{ value: 'preview', label: 'Preview' }, { value: 'ask', label: 'Ask' }] },
      { path: 'source', title: 'Exact source', widget: 'json', required: true },
      { path: 'title', title: 'Discussion title', widget: 'text', required: true },
      { path: 'question', title: 'Question', widget: 'textarea', required: true },
      { path: 'reviewers', title: 'Reviewers', widget: 'json', required: true },
      { path: 'retry', title: 'Retained retry identities', widget: 'json', required: true },
      { path: 'confirmedPreview', title: 'Confirmed access preview', widget: 'json' },
    ] },
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'second-opinion', 'start'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.list', approval: {result: 'required'},
    originalExecution: { accountRoot: 'allowed' },
    title: 'List Discussions',
    description: 'List the human discussions in the captured Home, newest activity first. Titles are opened locally; unread and mention counts are the caller’s own private facts.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'discussion_list', voiceClientToolName: 'discussion_list' },
    serverTransport: { method: 'GET', path: DISCUSSION_HTTP_PATHS_V1.collection },
    examples: {
      mcp: { argsExample: '{"state":"active","limit":30}' },
    },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'List discussions',
      fields: [
        { path: 'state', title: 'State', widget: 'text' },
        { path: 'cursor', title: 'Page cursor', widget: 'text' },
        { path: 'limit', title: 'Page size', widget: 'integer' },
      ],
    },
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.list'],
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.list'],
    cli: DISCUSSION_LIST_CLI_PROJECTION,
  },
  {
    id: 'discussion.get', approval: {result: 'required'},
    originalExecution: { accountRoot: 'allowed' },
    title: 'Read one Discussion',
    description: 'Read one human discussion’s opened title, activity, capabilities and the caller’s private unread facts. It returns no message bodies.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'discussion_get', voiceClientToolName: 'discussion_get' },
    serverTransport: { method: 'GET', path: DISCUSSION_HTTP_PATHS_V1.discussion },
    examples: {
      mcp: { argsExample: '{"discussionId":"{{discussionId}}"}' },
    },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Read a discussion',
      fields: [
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      ],
    },
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.get'],
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.get'],
    cli: DISCUSSION_GET_CLI_PROJECTION,
  },
  {
    id: 'discussion.read', approval: {result: 'required'},
    originalExecution: { accountRoot: 'allowed' },
    title: 'Read discussion messages',
    description: 'Read one committed message or a bounded history page, opened locally. Local IDs select only the caller’s authored messages. Reading never advances the caller’s private read cursor.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'discussion_read', voiceClientToolName: 'discussion_read' },
    serverTransport: { method: 'GET', path: DISCUSSION_HTTP_PATHS_V1.messages },
    examples: {
      mcp: { argsExample: '{"discussionId":"{{discussionId}}","limit":30}' },
    },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Read discussion messages',
      fields: [
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
        { path: 'messageId', title: 'Exact message id', widget: 'text' },
        { path: 'localId', title: 'Exact private local id', widget: 'text' },
        { path: 'beforeSeq', title: 'Before sequence', widget: 'integer' },
        { path: 'afterSeq', title: 'After sequence', widget: 'integer' },
        { path: 'limit', title: 'Page size', widget: 'integer' },
      ],
    },
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.read'],
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.read'],
    cli: DISCUSSION_READ_CLI_PROJECTION,
  },
  {
    id: 'discussion.attachment.read', approval: { result: 'required' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'Read a Discussion attachment',
    description: 'Open one file from its committed Discussion message under current access. The executing client verifies the bytes with the Discussion key. Reading never advances a private read cursor.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'discussion_attachment_read', voiceClientToolName: 'discussion_attachment_read' },
    serverTransport: { method: 'GET', path: DISCUSSION_HTTP_PATHS_V1.attachment },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Read a Discussion attachment',
      fields: [
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
        { path: 'messageId', title: 'Committed message id', widget: 'text', required: true },
        { path: 'blobId', title: 'Attachment blob id', widget: 'text', required: true },
        { path: 'throughSeq', title: 'Through sequence', widget: 'integer' },
      ],
    },
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.attachment.read'],
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.attachment.read'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'attachments', 'read'],
      positionals: ['discussionId', 'messageId', 'blobId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.create', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'participants.*.sessionId', cardinality: 'one' },
    originalExecution: { accountRoot: 'allowed' },
    requiredAuthority: 'present_user',
    title: 'Start a Discussion',
    description: 'Start one human discussion with its title and first message in a single atomic write. Agent and MCP callers request present-user approval.',
    safety: 'danger',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'discussion_create', voiceClientToolName: 'discussion_create' },
    serverTransport: { method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.collection },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Start a discussion',
      fields: [
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'firstMessage', title: 'First message', widget: 'json', required: true },
      ],
    },
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.create'],
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.create'],
    cli: DISCUSSION_CREATE_CLI_PROJECTION,
  },
  {
    id: 'discussion.post', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    originalExecution: { accountRoot: 'allowed' },
    title: 'Post a discussion message',
    description: 'Post one authored message to a human discussion. Every currently admitted Discussion reader sees it. An Agent posts under its own authenticated execution Account with visible “via agent” attribution; it never posts as the person who asked.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: [],
    bindings: { mcpToolName: 'discussion_post', voiceClientToolName: 'discussion_post' },
    serverTransport: { method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.messages },
    examples: {
      mcp: { argsExample: '{"discussionId":"{{discussionId}}","content":{"v":1,"parts":[{"t":"text","text":"Migration is green on all three providers."}]}}' },
    },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Post to a discussion',
      fields: [
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
        { path: 'content', title: 'Message', widget: 'json', required: true },
        { path: 'mentionedAccountIds', title: 'Mentioned Account ids', widget: 'text_list', listSeparator: 'comma' },
        { path: 'mentionedSessionIds', title: 'Mentioned Session ids', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.post'],
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.post'],
    cli: DISCUSSION_POST_CLI_PROJECTION,
  },
  {
    id: 'discussion.rename', approval: {result: 'optional',flow: 'deferred'},
    originalExecution: { accountRoot: 'allowed' },
    requiredAuthority: 'present_user',
    title: 'Rename a discussion',
    description: 'Change one human discussion’s title. It does not reorder the discussion or touch its messages.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'discussion_rename', voiceClientToolName: 'discussion_rename' },
    serverTransport: { method: 'PATCH', path: DISCUSSION_HTTP_PATHS_V1.discussion },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Rename a discussion',
      fields: [
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
      ],
    },
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.rename'],
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.rename'],
    cli: DISCUSSION_RENAME_CLI_PROJECTION,
  },
  {
    id: 'discussion.archive', approval: {result: 'optional',flow: 'deferred'},
    originalExecution: { accountRoot: 'allowed' },
    requiredAuthority: 'present_user',
    title: 'Archive a discussion',
    description: 'Archive one human discussion. It stays readable and restorable; new posts and title changes stop.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'discussion_archive', voiceClientToolName: 'discussion_archive' },
    serverTransport: { method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.archive },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Archive a discussion',
      fields: [
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      ],
    },
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.archive'],
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.archive'],
    cli: DISCUSSION_ARCHIVE_CLI_PROJECTION,
  },
  {
    id: 'discussion.restore', approval: {result: 'optional',flow: 'deferred'},
    originalExecution: { accountRoot: 'allowed' },
    requiredAuthority: 'present_user',
    title: 'Restore a discussion',
    description: 'Restore one archived human discussion so it accepts posts again.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'discussion_restore', voiceClientToolName: 'discussion_restore' },
    serverTransport: { method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.restore },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Restore a discussion',
      fields: [
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      ],
    },
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.restore'],
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.restore'],
    cli: DISCUSSION_RESTORE_CLI_PROJECTION,
  },
  {
    id: 'discussion.read_state.set', approval: {result: 'optional',flow: 'deferred'},
    originalExecution: { accountRoot: 'allowed' },
    requiredAuthority: 'present_user',
    title: 'Mark a discussion read',
    description: 'Advance the executing Account’s own private read position in a discussion. Agent and MCP callers request present-user approval.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'discussion_read_state_set', voiceClientToolName: 'discussion_read_state_set' },
    serverTransport: { method: 'PUT', path: DISCUSSION_HTTP_PATHS_V1.read },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: {
      title: 'Mark a discussion read',
      fields: [
        { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
        { path: 'lastReadSeq', title: 'Last read sequence', widget: 'integer', required: true },
      ],
    },
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.read_state.set'],
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.read_state.set'],
    cli: DISCUSSION_READ_STATE_SET_CLI_PROJECTION,
  },
  {
    id: 'discussion.reply', approvalPolicy: { uiConfirmation: 'direct' }, approval: { result: 'optional', flow: 'deferred' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'Reply in a discussion',
    description: 'Reply to one committed message in this Discussion through the same admitted message writer. A reply to an Agent-produced message can address that participant and start a turn, subject to its answer policy and current delivery admission. Replying grants no source access or additional authority.',
    safety: 'danger', sideEffectClass: 'danger', placements: [],
    toolExposure: { agent: 'direct' },
    bindings: { mcpToolName: 'discussion_reply', voiceClientToolName: 'discussion_reply' },
    serverTransport: { method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.messages },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { title: 'Reply in a discussion', fields: [
      { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      { path: 'content', title: 'Reply', widget: 'json', required: true },
      { path: 'replyTarget', title: 'Reply target', widget: 'json', required: true },
      { path: 'localId', title: 'Durable message identity for retry', widget: 'text' },
    ] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.reply'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.reply'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'reply'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.participants.list', approval: { result: 'required' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'List discussion participants',
    description: 'Inspect the authorized Discussion roster through its current grants. Membership and private Follow choices remain separate.',
    safety: 'safe', sideEffectClass: 'read', placements: [],
    bindings: { mcpToolName: 'discussion_participants_list', voiceClientToolName: 'discussion_participants_list' },
    serverTransport: { method: 'GET', path: DISCUSSION_HTTP_PATHS_V1.participants },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [{ path: 'discussionId', title: 'Discussion id', widget: 'text', required: true }] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.participants.list'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.participants.list'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'participants', 'list'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.candidates.list', approval: { result: 'required' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'Find discussion participants',
    description: 'Search eligible people or page accessible Sessions on this Home. Models project only supplied ordinary authoring selections; this read never probes, starts or invites a participant.',
    safety: 'safe', sideEffectClass: 'read', placements: [],
    bindings: { mcpToolName: 'discussion_candidates_list', voiceClientToolName: 'discussion_candidates_list' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [
      { path: 'source', title: 'Candidate source', widget: 'text', required: true },
      { path: 'discussionId', title: 'Existing discussion', widget: 'text' },
      { path: 'query', title: 'People search', widget: 'text' },
      { path: 'cursor', title: 'Source continuation', widget: 'text' },
      { path: 'options', title: 'Selected ordinary model setups', widget: 'json' },
    ] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.candidates.list'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.candidates.list'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'candidates', 'list'], positionals: [], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.settings.get', approval: { result: 'required' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'Read discussion settings',
    description: 'Read the Discussion check-in override. An absent override inherits the Account setting; null never pauses.',
    safety: 'safe', sideEffectClass: 'read', placements: [],
    bindings: { mcpToolName: 'discussion_settings_get', voiceClientToolName: 'discussion_settings_get' },
    examples: { mcp: { argsExample: '{"discussionId":"discussion-1"}' }, voice: { argsExample: '{"discussionId":"discussion-1"}' } },
    serverTransport: { method: 'GET', path: DISCUSSION_HTTP_PATHS_V1.settings },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [{ path: 'discussionId', title: 'Discussion id', widget: 'text', required: true }] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.settings.get'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.settings.get'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'settings', 'get'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.settings.set', approvalPolicy: { uiConfirmation: 'direct' }, approval: { result: 'optional', flow: 'deferred' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'Set discussion settings',
    description: 'Set this Discussion’s check-in override through its current owner or admin authority. Empty settings restore Account inheritance; null never pauses.',
    safety: 'danger', sideEffectClass: 'write', placements: [],
    bindings: { mcpToolName: 'discussion_settings_set', voiceClientToolName: 'discussion_settings_set' },
    examples: { mcp: { argsExample: '{"discussionId":"discussion-1","settings":{"coordination":{"autonomousCheckIn":{"afterTurns":null}}}}' },
      voice: { argsExample: '{"discussionId":"discussion-1","settings":{"coordination":{"autonomousCheckIn":{"afterTurns":null}}}}' } },
    serverTransport: { method: 'PUT', path: DISCUSSION_HTTP_PATHS_V1.settings },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [{ path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      { path: 'settings', title: 'Discussion settings', widget: 'json', required: true }] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.settings.set'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.settings.set'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'settings', 'set'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.invite', approvalPolicy: { uiConfirmation: 'direct' }, approval: { result: 'optional', flow: 'deferred' },
    sessionTarget: { field: 'participant.sessionId', cardinality: 'one' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'Invite a participant to a discussion',
    description: 'Invite a person, bind an existing Session, or reserve a model slot and start its ordinary Session without an initial prompt. Retain the same slot on an uncertain start. This grants no access to an anchored source.',
    safety: 'danger', sideEffectClass: 'write', placements: [],
    bindings: { mcpToolName: 'discussion_invite', voiceClientToolName: 'discussion_invite' },
    serverTransport: { method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.invite },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [
      { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      { path: 'participant', title: 'Participant to invite', widget: 'json', required: true },
      { path: 'answerPolicy', title: 'Session answer policy', widget: 'text' },
    ] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.invite'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.invite'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'invite'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.participant.policy.set', approvalPolicy: { uiConfirmation: 'direct' },
    approval: { result: 'optional', flow: 'deferred' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'Set a discussion participant answer policy',
    description: 'Choose when addressed, reads only, private drafts for review, or watch and speak up. Watching spends model turns even when the agent stays silent. Changing Action confirmation does not waive private draft review.',
    safety: 'danger', sideEffectClass: 'write', placements: [],
    bindings: { mcpToolName: 'discussion_participant_policy_set', voiceClientToolName: 'discussion_participant_policy_set' },
    serverTransport: { method: 'PUT', path: DISCUSSION_HTTP_PATHS_V1.participantPolicy },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [
      { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      { path: 'participant', title: 'Agent participant', widget: 'json', required: true },
      { path: 'answerPolicy', title: 'Answer policy', widget: 'text', required: true },
    ] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.participant.policy.set'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.participant.policy.set'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'participants', 'policy', 'set'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.participant.remove', approvalPolicy: { uiConfirmation: 'direct' },
    approval: { result: 'optional', flow: 'deferred' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'Remove a discussion invitation',
    description: 'Remove a person’s direct grant, detach an existing Session, or archive a Discussion-owned model Session through ordinary Session lifecycle. Inherited Team and Group access remains explicit.',
    safety: 'danger', sideEffectClass: 'write', placements: [],
    bindings: { mcpToolName: 'discussion_participant_remove', voiceClientToolName: 'discussion_participant_remove' },
    serverTransport: { method: 'DELETE', path: DISCUSSION_HTTP_PATHS_V1.participant },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [
      { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      { path: 'participant', title: 'Participant to remove', widget: 'json', required: true },
    ] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.participant.remove'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.participant.remove'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'participants', 'remove'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.leave', approval: { result: 'optional', flow: 'deferred' }, requiredAuthority: 'present_user',
    originalExecution: { accountRoot: 'allowed' },
    title: 'Leave a discussion',
    description: 'Remove only the present person’s direct invitation. An owner must transfer ownership or choose the existing archive operation; inherited access is not removed.',
    safety: 'safe', sideEffectClass: 'write', placements: [],
    bindings: { mcpToolName: 'discussion_leave', voiceClientToolName: 'discussion_leave' },
    serverTransport: { method: 'POST', path: DISCUSSION_HTTP_PATHS_V1.leave },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [{ path: 'discussionId', title: 'Discussion id', widget: 'text', required: true }] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.leave'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.leave'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'leave'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.owner.transfer', approval: { result: 'optional', flow: 'deferred' }, requiredAuthority: 'present_user',
    originalExecution: { accountRoot: 'allowed' },
    title: 'Transfer discussion ownership',
    description: 'The current owner transfers ownership to an eligible person in the same grant transaction. Cancelling approval preserves ownership.',
    safety: 'danger', sideEffectClass: 'write', placements: [],
    bindings: { mcpToolName: 'discussion_owner_transfer', voiceClientToolName: 'discussion_owner_transfer' },
    serverTransport: { method: 'PUT', path: DISCUSSION_HTTP_PATHS_V1.ownerTransfer },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'The selected person becomes the owner. You will need their help to transfer ownership back.', fields: [
      { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      { path: 'accountId', title: 'Successor Account id', widget: 'text', required: true },
    ] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.owner.transfer'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.owner.transfer'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'owner', 'transfer'], positionals: ['discussionId', 'accountId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.access.grants.list', approval: { result: 'required' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'Inspect discussion sharing',
    description: 'Read the Discussion’s effective access and explicit Account, Team and Group grants through the shared resource grant owner.',
    safety: 'safe', sideEffectClass: 'read', placements: [],
    bindings: { mcpToolName: 'discussion_access_grants_list', voiceClientToolName: 'discussion_access_grants_list' },
    serverTransport: { method: 'GET', path: DISCUSSION_HTTP_PATHS_V1.grants },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [{ path: 'discussionId', title: 'Discussion id', widget: 'text', required: true }] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.access.grants.list'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.access.grants.list'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'access', 'grants', 'list'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.access.grants.set', approvalPolicy: { uiConfirmation: 'direct' }, approval: { result: 'optional', flow: 'deferred' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'Share a discussion',
    description: 'Set an explicit resource grant using the shared PrincipalRef and view/edit/admin policy. Source grants remain separate.',
    safety: 'danger', sideEffectClass: 'write', placements: [],
    bindings: { mcpToolName: 'discussion_access_grants_set', voiceClientToolName: 'discussion_access_grants_set' },
    serverTransport: { method: 'PUT', path: DISCUSSION_HTTP_PATHS_V1.grants },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [
      { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      { path: 'principal', title: 'Account, Team or Group', widget: 'json', required: true },
      { path: 'accessLevel', title: 'Access level', widget: 'text', required: true },
    ] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.access.grants.set'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.access.grants.set'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'access', 'grants', 'set'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
  {
    id: 'discussion.access.grants.remove', approval: { result: 'optional', flow: 'deferred' },
    originalExecution: { accountRoot: 'allowed' },
    title: 'Remove discussion sharing',
    description: 'Remove an explicit resource grant through the same shared resource grant owner and current access checks.',
    safety: 'danger', sideEffectClass: 'write', placements: [],
    bindings: { mcpToolName: 'discussion_access_grants_remove', voiceClientToolName: 'discussion_access_grants_remove' },
    serverTransport: { method: 'DELETE', path: DISCUSSION_HTTP_PATHS_V1.grants },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [
      { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      { path: 'principal', title: 'Account, Team or Group', widget: 'json', required: true },
    ] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.access.grants.remove'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.access.grants.remove'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'access', 'grants', 'remove'], positionals: ['discussionId'], visibility: 'canonical' }] },
  },
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_CONTINUATION = Object.freeze(defineActionSpecs([
  {
    id: 'session.coordinator.enable', approvalPolicy: { uiConfirmation: 'direct' }, approval: { result: 'optional', flow: 'deferred' },
    title: 'Make coordinator',
    description: 'Configure this session through existing role, Bot, pin, manager and Important Follow rule Actions; returns each effect separately.',
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_coordinator_enable', voiceClientToolName: 'makeSessionCoordinator' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    examples: { voice: { argsExample: '{"sessionId":"session_123","roleId":"orchestrator","keep":"none","ruleSuggestions":[]}' } },
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session', widget: 'text', required: true },
      { path: 'roleId', title: 'Role', widget: 'text', required: true },
      { path: 'keep', title: 'Where to keep it', widget: 'select', required: true, options: [
        { value: 'rail_bot', label: 'Left rail, as a Bot' }, { value: 'list_pin', label: 'Top of your list' }, { value: 'none', label: 'Just in the list' },
      ] },
      { path: 'answersWorkerQuestions', title: 'Answers its workers’ questions', widget: 'boolean' },
      { path: 'managedBy', title: 'Manager and reviewed current manager', widget: 'json' },
      { path: 'ruleSuggestions', title: 'Selected rule intents', widget: 'json', required: true },
    ] },
    inputSchema: lazyZodSchema(() => z.extend(SessionCoordinatorEnableInputV1Schema, { sessionId: SessionTargetV1Schema })),
    outputSchema: SessionCoordinatorEnableResultV1Schema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'coordinator', 'enable'], visibility: 'canonical' }] },
  },
  {
    id: 'session.status.set_reason', approval: { result: 'none' },
    title: 'Explain session status',
    description: 'Set or clear an explanation for the current session without changing its runtime status.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_status_set_reason', voiceClientToolName: 'setSessionStatusReason' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    examples: { voice: { argsExample: '{"reason":"Waiting for the local build"}' } },
    inputHints: { fields: [{ path: 'reason', title: 'Explanation, or null to clear', widget: 'json', required: true }] },
    inputSchema: SessionStatusReasonSetInputSchema,
    outputSchema: SessionStatusReasonSetResultSchema,
    cli: { commands: [{ path: ['session', 'set-status-reason'], visibility: 'canonical' }] },
  },
  {
    id: 'session.title.set', approval: {result: 'none'},
    title: 'Set session title',
    description: 'Set the title (summary text) shown for a session.',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    bindings: { mcpToolName: 'session_title_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","title":"Fix flaky tests"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Rename a session.',
      title: 'Set title',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'title', title: 'Title', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTitleSetInputSchema,
    cli: SESSION_TITLE_SET_CLI_PROJECTION,
  },
  {
    id: 'session.bot.set', approval: {result: 'none'},
    title: 'Make a session a bot or a regular session',
    description: 'Set the reversible Bot marker through Account metadata without waking its execution host.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_bot_set', voiceClientToolName: 'setSessionBot' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Turn a session into a bot, or back into a regular session.', title: 'Set Bot marker', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'bot', title: 'Bot marker, or null for a regular session', widget: 'json', required: true },
    ] },
    inputSchema: BotSetInputSchema, outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'bot', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.memory.set', approval: {result: 'none'}, title: 'Use memory in this session',
    description: 'Save the Session memory choice without creating or editing documents.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_memory_set', voiceClientToolName: 'setSessionMemory' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Choose whether a session uses your memory.', title: 'Use memory', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'expectedMetadataRevision', title: 'Reviewed metadata revision', widget: 'number', required: true },
      { path: 'enabled', title: 'Use memory', widget: 'json', required: true },
    ] },
    inputSchema: SessionMemorySetInputV1Schema, outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'memory', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.voice.preference.set', approval: {result: 'none'}, title: 'Set session voice preference',
    description: 'Select one declared voice setting without changing provider or Account settings; null inherits Account settings.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_voice_preference_set', voiceClientToolName: 'setSessionVoicePreference' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Choose how Voice behaves in one session without changing your other sessions.', title: 'Session voice', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'expectedMetadataRevision', title: 'Reviewed metadata revision', widget: 'number', required: true },
      { path: 'preference', title: 'Voice preference, or null to inherit', widget: 'json', required: true },
    ] },
    inputSchema: SessionVoicePreferenceSetInputV1Schema, outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'voice', 'preference', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.context.update', approval: {result: 'none'}, title: 'Update session context',
    description: 'Apply one context-entry, inherited-entry switch or Plan Doc selection intent against its reviewed metadata revision.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_context_update', voiceClientToolName: 'updateSessionContext' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Edit session context or select an existing Doc as its Plan with set_plan; a null entryId clears the selection.', title: 'Update context', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'expectedMetadataRevision', title: 'Reviewed metadata revision', widget: 'number', required: true },
      { path: 'intent', title: 'Context intent', widget: 'json', required: true },
    ] },
    inputSchema: SessionContextUpdateInputV1Schema, outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'context', 'update'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.instructions.set', approval: {result: 'none'}, title: 'Set session instructions',
    description: 'Select or detach the reserved Session instruction entry; the document remains in the library.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_instructions_set', voiceClientToolName: 'setSessionInstructions' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Choose the instructions a session follows, or remove them.', title: 'Set instructions', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'serverId', title: 'Home id', widget: 'text', required: true },
      { path: 'expectedMetadataRevision', title: 'Reviewed metadata revision', widget: 'number', required: true },
      { path: 'ref', title: 'Document reference', description: 'Set it to null to detach the document.', widget: 'json', required: true },
    ] },
    inputSchema: SessionInstructionsSetInputV1Schema, outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'instructions', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    // Plan 60 §6: tool visibility belongs to the person reading the transcript;
    // automation must not hide its activity, even with an Action approval waiver.
    id: 'session.view.toolCalls.set', approval: {result: 'none'}, title: 'Show or hide session tool calls',
    description: 'Save a human-owned transcript view choice; null restores the session default.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
    requiredAuthority: 'present_user',
    bindings: { voiceClientToolName: 'setSessionToolCalls' },
    surfaces: { ui: true, voice: true, agent: false, mcp: false, cli: true, rpc: false },
    inputHints: { description: 'Show or hide tool calls in a session\'s conversation.', title: 'Show tool calls', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'showToolCalls', title: 'Show tool calls, or null to use the default', widget: 'json', required: true },
    ] },
    inputSchema: SessionToolCallsSetInputSchema, outputSchema: StrictJsonValueSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'view', 'tools', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.permission_mode.set', approval: {result: 'none'},
    title: 'Set session permission mode',
    description: `Immediately update the permission intent (${SESSION_PERMISSION_INTENT_INPUTS.join('/')}) for the specified session. Compatible aliases are accepted. To apply a mode with the next prompt, use session.message.send with permissionModeOverride.`,
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_permission_mode_set', rpcMethod: 'session.permission_mode.set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","permissionMode":"read_only"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      description: 'Choose how much a session\'s agent may do without asking you.',
      title: 'Set permission mode',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'permissionMode', title: 'Permission mode', widget: 'text', required: true },
        { path: 'applyTiming', title: 'Apply timing', widget: 'select', options: [
          { value: 'immediate', label: 'Immediately' },
        ] },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionPermissionModeSetInputSchema,
    cli: SESSION_PERMISSION_MODE_SET_CLI_PROJECTION,
  },
  {
    id: 'session.model.set', approval: {result: 'none'},
    title: 'Set session model',
    description: 'Set the model override for the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_model_set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","modelId":"default"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Choose the model a session uses.',
      title: 'Set session model',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'modelId', title: 'Model id', widget: 'text', required: true },
        { path: 'providerConnectionId', title: 'Provider connection id', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionModelSetInputSchema,
    cli: SESSION_MODEL_SET_CLI_PROJECTION,
  },
  {
    id: 'session.archive', approval: {result: 'none'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Archive session',
    description: 'Archive the specified session, optionally also archiving its unarchived direct reports. Each report retains its own rights and approval requirements; results include partial outcomes.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_archive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Move a session out of your list without deleting it.',
      title: 'Archive a session',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'alsoArchiveReports', title: 'Also archive direct sub-sessions', widget: 'boolean' },
      ],
    },
    outputSchema: lazyZodSchema(() => SessionArchiveActionResultV1Schema),
    inputSchema: lazyZodSchema(() => z.extend(SessionArchiveActionInputV1Schema, { sessionId: SessionTargetV1Schema })),
    cli: SESSION_ARCHIVE_CLI_PROJECTION,
  },
  {
    id: 'session.delete', approval: {result: 'none'},
    confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true,
    title: 'Delete session',
    description: 'Permanently delete a session. Its daemon removes managed folders through the durable deletion lifecycle.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_delete' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    serverTransport: { method: 'DELETE', path: '/v1/sessions/:sessionId' },
    inputSchema: lazyZodSchema(() => z.strictObject({ sessionId: z.string().check(z.trim(), z.minLength(1)) })),
    outputSchema: lazyZodSchema(() => z.strictObject({ success: z.literal(true) })),
    inputHints: { description: 'Permanently delete a session and the folders Happier made for it.', title: 'Delete a session', fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }] },
    cli: { commands: [{ path: ['session', 'delete'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.folder.set', approval: {result: 'none'},
    title: 'Assign session folder',
    description: 'Assign a session to an existing organization folder, or clear its assignment with null.',
    safety: 'safe', sideEffectClass: 'external', placements: [],
    bindings: { mcpToolName: 'session_folder_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    serverTransport: { method: 'PUT', path: '/v2/session-organization/folder-assignments/:sessionId' },
    inputSchema: lazyZodSchema(() => z.extend(SetSessionFolderAssignmentRequestSchema, { sessionId: z.string().check(z.trim(), z.minLength(1)) })),
    outputSchema: SetSessionFolderAssignmentResponseSchema,
    inputHints: { description: 'Put a session in one of your folders, or take it out.', title: 'Assign session folder', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'folderId', title: 'Folder id, or null to clear', widget: 'text', required: true },
    ] },
    cli: { commands: [{ path: ['session', 'folder', 'set'], positionals: ['sessionId', 'folderId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.tags.set', approval: {result: 'none'},
    title: 'Assign session tags',
    description: 'Replace a session’s tag assignments with existing organization tag ids; an empty list clears them.',
    safety: 'safe', sideEffectClass: 'external', placements: [],
    bindings: { mcpToolName: 'session_tags_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    serverTransport: { method: 'PUT', path: '/v2/session-organization/tag-assignments/:sessionId' },
    inputSchema: lazyZodSchema(() => z.extend(SetSessionTagAssignmentsRequestSchema, { sessionId: z.string().check(z.trim(), z.minLength(1)) })),
    outputSchema: SetSessionTagAssignmentsResponseSchema,
    inputHints: { description: 'Choose the tags on a session.', title: 'Assign session tags', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'tagIds', title: 'Tag ids', widget: 'textarea', required: true },
    ] },
    cli: { commands: [{ path: ['session', 'tags', 'set'], positionals: ['sessionId'], visibility: 'canonical' }] },
  },
  {
    id: 'session.unarchive', approval: {result: 'none'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Unarchive session',
    description: 'Unarchive the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_unarchive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Bring an archived session back to your list.',
      title: 'Unarchive a session',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTargetRequiredInputSchema,
    cli: SESSION_UNARCHIVE_CLI_PROJECTION,
  },
  {
    id: 'session.targets.resolve', sideEffectClass: 'read', approval: { result: 'none' },
    title: 'Preview session targets',
    description: 'Inspect the complete authorized target selection for a host or installed contributed Action without executing it. Final invocation prepares its own current selection.',
    safety: 'safe', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'session_targets_resolve', voiceClientToolName: 'session_targets_resolve', rpcMethod: 'session.targets.resolve' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: SessionTargetsResolveInputV1Schema,
    outputSchema: SessionTargetPreviewV1Schema,
    examples: { voice: { argsExample: '{"target":{"selector":"workers"},"actionId":"session.message.send"}' } },
    inputHints: { title: 'Preview session targets', fields: [
      { path: 'target', title: 'Session target', widget: 'json', required: true },
      { path: 'actionId', title: 'Action', description: 'Host Action id or canonical contributed Action id (<pluginId>/actions/<localId>) from discovery.', widget: 'text', required: true },
    ] },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'targets', 'resolve'], visibility: 'canonical' }] },
  },
  {
    id: 'session.status.get', sideEffectClass: 'read', approval: {result: 'required'},
    sessionTarget: { field: 'sessionId', cardinality: 'many' },
    title: 'Get session status',
    description: 'Get summary status and the content-free Connected selection for a session. Use sessionId:"self" to read your own selection for reuse in child starts. Optionally refresh live agent state or inspect current execution prerequisites.',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'session_status_get', mcpToolName: 'session_status_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","live":true}' },
      voice: { argsExample: '{"sessionId":"session_123","readiness":true}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See whether a session is working, waiting or stopped.',
      title: 'Get session status',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'live', title: 'Live', widget: 'boolean' },
        { path: 'readiness', title: 'Inspect execution readiness', widget: 'boolean' },
      ],
    },
    outputSchema: lazyZodSchema(() => withSessionTargetFanoutResultV1(SessionStatusActionResultV1Schema)),
    inputSchema: SessionStatusGetInputSchema,
    cli: SESSION_STATUS_GET_CLI_PROJECTION,
  },
  {
    id: 'session.work_state.get', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'Get session work state',
    description: 'Get the normalized current goal, task, and todo snapshot for a session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_work_state_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See a session\'s goal, current task and to-dos.',
      title: 'Get session work state',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.goal.get', sideEffectClass: 'read', approval: {result: 'required'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Get session goal',
    description: 'Get the editable session goal when the provider supports native goals.',
    safety: 'safe',
    toolExposure: { agent: 'direct' },
    placements: [],
    bindings: { mcpToolName: 'session_goal_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See the goal a session is working towards.',
      title: 'Get session goal',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTargetRequiredInputSchema,
  },
  {
    id: 'session.goal.set', approval: {result: 'none'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Set session goal',
    description: 'Set or update the native session goal.',
    safety: 'safe',
    toolExposure: { agent: 'direct' },
    placements: [],
    bindings: { mcpToolName: 'session_goal_set', rpcMethod: SESSION_RPC_METHODS.SESSION_GOAL_SET },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","objective":"Ship goal controls"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'Set the goal a session works towards.',
      title: 'Set session goal',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'objective', title: 'Objective', widget: 'textarea' },
        { path: 'status', title: 'Status', widget: 'text' },
        { path: 'tokenBudget', title: 'Token budget', widget: 'text' },
        { path: 'resumeInactiveWithInitialGoal', title: 'Resume inactive session with goal', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionGoalSetInputSchema,
  },
  {
    id: 'session.goal.clear', approval: {result: 'required'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Clear session goal',
    description: 'Clear the native session goal.',
    safety: 'safe',
    toolExposure: { agent: 'direct' },
    placements: [],
    bindings: { mcpToolName: 'session_goal_clear' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Remove a session\'s goal.',
      title: 'Clear session goal',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionTargetRequiredInputSchema,
  },
  {
    id: 'session.access.grants.list', approval: {result: 'none'},
    title: 'List Session access',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'grants', 'list'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_grants_list' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { description: 'See who can open a session and what each of them may do.', fields: [] },
    inputSchema: SessionAccessGrantsListRequestV1Schema,
    outputSchema: SessionAccessGrantsListResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-grants/list' },
  },
  {
    id: 'session.access.grant.set', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Set Session access',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'grant', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_grant_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { description: 'Let a person or a Team open a session, and choose whether they may view, edit or manage it.', fields: [] },
    inputSchema: SessionAccessGrantSetActionInputV1Schema,
    outputSchema: SetSessionAccessGrantResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-grants/set' },
  },
  {
    id: 'session.access.grant.remove', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Remove Session access',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'grant', 'remove'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_grant_remove' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { description: 'Stop a person or a Team opening a session.', fields: [] },
    inputSchema: RemoveSessionAccessGrantRequestV1Schema,
    outputSchema: RemoveSessionAccessGrantResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-grants/remove' },
  },
  {
    id: 'session.access.encryption.prepare', approvalPolicy: { uiConfirmation: 'direct' }, approval: { result: 'optional', flow: 'deferred' },
    title: 'Prepare encrypted Session access',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation', executionPlacement: 'client',
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'access', 'encryption', 'prepare'], visibility: 'canonical' }] },
    placements: [], bindings: { mcpToolName: 'session_access_encryption_prepare' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Prepare this Session’s existing encrypted audience on the answering client. This does not grant access.', fields: [] },
    inputSchema: SessionAccessEncryptionPrepareInputV1Schema, outputSchema: SessionAccessEncryptionPrepareResultV1Schema,
  },
  {
    id: 'session.access.encryption.reprepare', approvalPolicy: { uiConfirmation: 'direct' }, approval: { result: 'optional', flow: 'deferred' },
    title: 'Re-prepare encrypted Session access for a person',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation', executionPlacement: 'client',
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'access', 'encryption', 'reprepare'], visibility: 'canonical' }] },
    placements: [], bindings: { mcpToolName: 'session_access_encryption_reprepare' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Re-seal this Session’s current key for one existing recipient on the answering client.', fields: [] },
    inputSchema: SessionAccessEncryptionReprepareInputV1Schema, outputSchema: SessionAccessEncryptionPrepareResultV1Schema,
  },
  {
    id: 'session.access.layout.update', approvalPolicy: { uiConfirmation: 'policy' }, approval: { result: 'optional', flow: 'deferred' },
    confirmVerb: { key: 'common.update', fallback: 'Update' },
    title: 'Update historical Session sharing layout',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation', executionPlacement: 'client',
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'access', 'layout', 'update'], visibility: 'canonical' }] },
    placements: [], bindings: { mcpToolName: 'session_access_layout_update' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Move an owned historical Session to the current owner/shared layout without changing its content. Requires the answering client’s keys.', fields: [] },
    inputSchema: SessionAccessEncryptionPrepareInputV1Schema, outputSchema: SessionAccessLayoutUpdateResultV1Schema,
  },
  {
    id: 'session.access.context.set', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Set the Team a Session belongs to',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'context', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_context_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { description: 'Choose the Team a session is part of, which decides who sees it by default.', fields: [] },
    inputSchema: SetSessionAccessContextRequestV1Schema,
    outputSchema: SetSessionAccessContextResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-context/set' },
  },
  {
    id: 'session.manager.set', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Set Session manager',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'manager', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_manager_set', voiceClientToolName: 'session_manager_set' },
    examples: { voice: { argsExample: '{"sessionId":"{{sessionId}}","managerSessionId":"manager_session","expectedManagerSessionId":null}' } },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { description: 'Choose which session manages this one, or let it stand on its own.', fields: [
      { path: 'sessionId', title: 'Session', prompt: 'Which session?', widget: 'text' },
      { path: 'managerSessionId', title: 'Manager session', description: 'Leave empty to detach it from its manager.', widget: 'text' },
      { path: 'expectedManagerSessionId', title: 'Expected current manager', widget: 'text' },
    ] },
    inputSchema: lazyZodSchema(() => z.extend(SessionManagerSetActionInputV1Schema, { sessionId: SessionTargetV1Schema })),
    outputSchema: SessionManagerSetResultV1Schema,
    serverTransport: { method: 'POST', path: '/v1/sessions/:sessionId/manager' },
  },
  {
    id: 'session.responsibility.set', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Assign Session to someone',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'responsibility', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_responsibility_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { description: 'Choose who looks after a session and answers what it asks.', fields: [] },
    inputSchema: SetSessionResponsibilityRequestSchema,
    outputSchema: SetSessionResponsibilityResponseSchema,
    serverTransport: { method: 'POST', path: '/v2/sessions/responsibility/set' },
  },
  {
    id: 'session.responsibility.candidates.list', approval: {result: 'none'},
    title: 'Find who can take a Session',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'responsibility', 'candidates', 'list'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_responsibility_candidates_list' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { description: 'See the people a session can be assigned to.', fields: [] },
    inputSchema: SessionResponsibilityCandidatesRequestSchema,
    outputSchema: SessionResponsibilityCandidatesResponseSchema,
    serverTransport: { method: 'POST', path: '/v2/sessions/responsibility/candidates' },
  },
  {
    id: 'session.public_link.get', approval: {result: 'none'},
    title: 'Read Session public link',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'public-link', 'get'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_public_link_get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { description: 'See whether a session has a public link and what the link allows.', fields: [] },
    inputSchema: lazyZodSchema(() => z.strictObject(SessionIdRequiredInputSchema.shape)),
    outputSchema: SessionPublicLinkGetActionResultV1Schema,
    serverTransport: { method: 'GET', path: '/v1/sessions/:sessionId/public-share' },
  },
  {
    id: 'session.public_link.create', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    approvalNarrowing: {
      narrow(original, chosen) {
        const source = SessionPublicLinkCreateActionInputV1Schema.safeParse(original);
        const selection = SessionPublicLinkCreateActionInputV1Schema.safeParse(chosen);
        if (!source.success || !selection.success || selection.data.networkOff !== true) return null;
        const { networkOff: _originalOff, ...originalShare } = source.data;
        const { networkOff: _chosenOff, ...chosenShare } = selection.data;
        return sameStrictJsonValue(originalShare, chosenShare) ? selection.data : null;
      },
    },
    projectObservationOutput: projectPublicLinkCreationObservation,
    title: 'Create Session public link',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'public-link', 'create'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_public_link_create' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { description: 'Make a link that lets anyone who has it read a session.', fields: [] },
    inputSchema: SessionPublicLinkCreateActionInputV1Schema,
    outputSchema: SessionPublicLinkCreateActionResultV1Schema,
    serverTransport: { method: 'POST', path: '/v1/public-shares' },
  },
  {
    id: 'session.public_link.remove', approval: {result: 'optional',flow: 'deferred'},
    title: 'Remove Session public link',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'public-link', 'remove'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_public_link_remove' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { description: 'Turn off a session\'s public link. People who have it can no longer open the session.', fields: [] },
    inputSchema: SessionAccessGrantsListRequestV1Schema,
    outputSchema: SessionPublicLinkRemoveActionResultV1Schema,
    serverTransport: { method: 'DELETE', path: '/v1/sessions/:sessionId/public-share' },
  },
  {
    id: 'follow.get', approval: {result: 'required'},
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    title: 'Get Session Follow',
    description: 'Get Session Follow for the authenticated Account.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'get'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_get', voiceClientToolName: 'follow_get' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['follow.get'],
    outputSchema: SessionFollowActionOutputSchemasV1['follow.get'],
    serverTransport: { method: 'GET', path: SESSION_FOLLOW_HTTP_PATHS_V1.follow },
  },
  {
    id: 'follow.set', approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    title: 'Set Session Follow',
    description: 'Set Session Follow for the authenticated Account.',
    safety: 'danger',
    safetyForInput: (input: unknown) => {
      const parsed = FollowReceiverRefV1Schema.safeParse((input as { receiver?: unknown } | null)?.receiver);
      return parsed.success && parsed.data.kind === 'account' ? 'safe' as const : 'danger' as const;
    },
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_set', voiceClientToolName: 'follow_set' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'write',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['follow.set'],
    outputSchema: SessionFollowActionOutputSchemasV1['follow.set'],
    serverTransport: { method: 'PUT', path: SESSION_FOLLOW_HTTP_PATHS_V1.follow },
  },
  {
    id: 'follow.remove', approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    title: 'Remove Session Follow',
    description: 'Remove Session Follow for the authenticated Account.',
    safety: 'danger',
    safetyForInput: (input: unknown) => {
      const parsed = FollowReceiverRefV1Schema.safeParse((input as { receiver?: unknown } | null)?.receiver);
      return parsed.success && parsed.data.kind === 'account' ? 'safe' as const : 'danger' as const;
    },
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'remove'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_remove', voiceClientToolName: 'follow_remove' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'write',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['follow.remove'],
    outputSchema: SessionFollowActionOutputSchemasV1['follow.remove'],
    serverTransport: { method: 'DELETE', path: SESSION_FOLLOW_HTTP_PATHS_V1.follow },
  },
] as const));

function deliveryMuteActionMetadata(operation: 'set' | 'remove' | 'list') {
  return {
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    approval: operation === 'list' ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
    title: operation === 'list' ? 'List receiver delivery mutes' : operation === 'set' ? 'Mute deliveries to a receiver' : 'Unmute deliveries to a receiver',
    description: 'Inspect or change exact sender and Follow-source suppression for one receiver on this Home.',
    safety: operation === 'list' ? 'safe' : 'danger',
    ...(operation === 'list' ? {} : { safetyForInput: (input: unknown) => {
      const parsed = FollowReceiverRefV1Schema.safeParse((input as { receiver?: unknown } | null)?.receiver);
      return parsed.success && parsed.data.kind === 'account' ? 'safe' as const : 'danger' as const;
    } }),
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'delivery', 'mute', operation], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: `session_delivery_mute_${operation}`, voiceClientToolName: `session_delivery_mute_${operation}` },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: operation === 'list' ? 'read' : 'write',
    inputHints: { fields: [{ path: 'receiver', title: 'Receiver', widget: 'json', required: true },
      ...(operation === 'list' ? [] : [{ path: 'scope', title: 'Mute scope', widget: 'json' as const, required: true }])] },
    serverTransport: { method: operation === 'list' ? 'GET' : operation === 'set' ? 'PUT' : 'DELETE',
      path: DELIVERY_MUTE_HTTP_PATHS_V1.account },
  } as const satisfies Omit<PreNormalizedActionSpec, 'id' | 'inputSchema' | 'outputSchema'>;
}

const ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX = Object.freeze(defineActionSpecs([
  {
    id: 'follow.preferences.get', approval: {result: 'required'},
    title: 'Get Follow defaults',
    description: 'Get Follow defaults for the authenticated Account.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'preferences', 'get'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_preferences_get', voiceClientToolName: 'follow_preferences_get' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['follow.preferences.get'],
    outputSchema: SessionFollowActionOutputSchemasV1['follow.preferences.get'],
    serverTransport: { method: 'GET', path: SESSION_FOLLOW_HTTP_PATHS_V1.preferences },
  },
  {
    id: 'follow.preferences.set', approval: {result: 'optional',flow: 'deferred'},
    title: 'Set Follow defaults',
    description: 'Set Follow defaults for the authenticated Account.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: {
      commands: [{ path: ['follow', 'preferences', 'set'], visibility: 'canonical' }],
      inputSchema: SessionFollowPreferencesCliInputSchema,
      bindInput: (value) => {
        const input = SessionFollowPreferencesCliInputSchema.parse(value);
        return { assigned: input.assigned === 'on', direct: input.direct === 'on', team: input.team === 'on', group: input.group === 'on',
          ...(input.managerPolicy ? { managerPolicy: input.managerPolicy } : {}),
          ...(input.runReportPolicy ? { runReportPolicy: input.runReportPolicy } : {}),
          ...(input.discussionReceivePolicy ? { discussionReceivePolicy: input.discussionReceivePolicy } : {}) };
      },
    },
    placements: [],
    bindings: { mcpToolName: 'follow_preferences_set', voiceClientToolName: 'follow_preferences_set' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'write',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['follow.preferences.set'],
    outputSchema: SessionFollowActionOutputSchemasV1['follow.preferences.set'],
    serverTransport: { method: 'PUT', path: SESSION_FOLLOW_HTTP_PATHS_V1.preferences },
  },
  {
    id: 'follow.list', approval: {result: 'none'},
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    sideEffectClass: 'read',
    title: 'List followed sessions',
    description: 'List the sessions whose updates are included with this session\'s next turn.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'list'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_list', voiceClientToolName: 'follow_list' },
    examples: {
      mcp: { argsExample: '{"direction":"following","receiver":{"kind":"session","sessionId":"{{sessionId}}"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List followed sessions',
      fields: [{ path: 'receiver', title: 'Receiver', widget: 'json', required: false },
        { path: 'source', title: 'Source', widget: 'json', required: false },
        { path: 'direction', title: 'Direction', widget: 'text', required: true }],
    },
    outputSchema: SessionFollowActionOutputSchemasV1['follow.list'],
    inputSchema: SessionFollowActionInputSchemasV1['follow.list'],
    serverTransport: { method: 'GET', path: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.list },
  },
  {
    id: 'follow.preview', sideEffectClass: 'read', approval: {result: 'none'},
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    title: 'Preview Follow rule',
    description: 'Preview the authorized matching corpus without creating Follow enrollments.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'preview'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_preview', voiceClientToolName: 'follow_preview' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Preview Follow rule',
      fields: [
        { path: 'receiver', title: 'Receiver', widget: 'json', required: true },
        { path: 'filter', title: 'Filter', widget: 'json', required: true },
      ],
    },
    outputSchema: SessionFollowActionOutputSchemasV1['follow.preview'],
    inputSchema: SessionFollowActionInputSchemasV1['follow.preview'],
  },
  {
    ...deliveryMuteActionMetadata('set'),
    id: 'session.delivery.mute.set',
    inputSchema: SessionFollowActionInputSchemasV1['session.delivery.mute.set'],
    outputSchema: SessionFollowActionOutputSchemasV1['session.delivery.mute.set'],
  },
  {
    ...deliveryMuteActionMetadata('remove'),
    id: 'session.delivery.mute.remove',
    inputSchema: SessionFollowActionInputSchemasV1['session.delivery.mute.remove'],
    outputSchema: SessionFollowActionOutputSchemasV1['session.delivery.mute.remove'],
  },
  {
    ...deliveryMuteActionMetadata('list'),
    id: 'session.delivery.mute.list',
    inputSchema: SessionFollowActionInputSchemasV1['session.delivery.mute.list'],
    outputSchema: SessionFollowActionOutputSchemasV1['session.delivery.mute.list'],
  },
  {
    id: 'session.read_state.set', approval: {result: 'none'},
    title: 'Mark a session read',
    description: 'Set the caller\u2019s own private read position in a session. Does not resolve approvals, mentions or human attention.',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'session_read_state_set', voiceClientToolName: 'session_read_state_set' },
    sideEffectClass: 'write',
    inputHints: {
      title: 'Mark a session read',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'state', title: 'Read state', widget: 'text', required: true },
      ],
    },
    outputSchema: SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1['session.read_state.set'],
    inputSchema: SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1['session.read_state.set'],
    cli: SESSION_READ_STATE_SET_CLI_PROJECTION,
    serverTransport: { method: 'POST', path: SESSION_READ_STATE_HTTP_PATHS_V1.set },
  },
  {
    id: 'session.usageLimit.waitResume.enable', approval: {result: 'none',flow: 'deferred'},
    title: 'Enable usage-limit wait resume',
    description: 'Arm a durable intent to continue a session when a provider usage limit is lifted.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_wait_resume_enable' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","remember":true}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Continue a session automatically once your usage limit lifts.',
      title: 'Enable usage-limit wait resume',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'issueFingerprint', title: 'Issue fingerprint', widget: 'text' },
        { path: 'remember', title: 'Remember', widget: 'boolean' },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitWaitResumeEnableRequestV1Schema,
  },
  {
    id: 'session.usageLimit.waitResume.cancel', approval: {result: 'none',flow: 'deferred'},
    title: 'Cancel usage-limit wait resume',
    description: 'Cancel the active usage-limit wait/resume intent for a session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_wait_resume_cancel' },
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","issueFingerprint":"usage-limit:provider:turn:1:no-reset","armedAtMs":1000,"runtimeAuthRecoveryAttemptId":"runtime-auth-attempt-1"}',
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Stop waiting to continue a session after a usage limit.',
      title: 'Cancel usage-limit wait resume',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'issueFingerprint', title: 'Issue fingerprint', widget: 'text' },
        { path: 'armedAtMs', title: 'Armed at (ms)', widget: 'number' },
        { path: 'runtimeAuthRecoveryAttemptId', title: 'Runtime auth recovery attempt id', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitWaitResumeCancelRequestV1Schema,
  },
  {
    id: 'session.usageLimit.checkNow', approval: {result: 'required'},
    title: 'Check usage-limit recovery now',
    description: 'Ask the session runtime to perform a safe provider-owned usage-limit recovery check.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_check_now' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Check now whether a session\'s usage limit has lifted.',
      title: 'Check usage-limit recovery now',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        {
          path: 'provider',
          title: 'Provider',
          description: 'Optional provider id for provider-scoped recovery controls.',
          widget: 'text',
        },
        {
          path: 'operation',
          title: 'Operation',
          widget: 'select',
          options: [
            { value: 'check_now', label: 'Check now' },
            { value: 'switch_account_now', label: 'Switch account now' },
          ],
        },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitCheckNowRequestV1Schema,
  },
  {
    id: 'session.usageLimit.consumeResetCredit', approval: {result: 'required'},
    title: 'Apply usage-limit reset credit',
    description: 'Ask the session runtime to spend a connected-service reset credit for usage-limit recovery.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_consume_reset_credit' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Use a reset credit from your connected account to lift a session\'s usage limit now.',
      title: 'Apply reset credit',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        {
          path: 'provider',
          title: 'Provider',
          description: 'Optional provider id for provider-scoped recovery controls.',
          widget: 'text',
        },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitConsumeResetCreditRequestV1Schema,
  },
  {
    id: 'session.vendor_plugin_catalog.list', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'List session vendor plugins',
    description: 'List provider-owned vendor plugins available to the session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_vendor_plugin_catalog_list' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See the agent plugins a session can use.',
      title: 'List vendor plugins',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text' },
      ],
    },
    outputSchema: SessionVendorPluginCatalogListOutputSchema,
    inputSchema: SessionCatalogListInputSchema,
  },
  {
    id: 'session.skill_catalog.list', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'List session skills',
    description: 'List provider-visible skills available to the session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_skill_catalog_list' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See the skills a session\'s agent can use.',
      title: 'List skills',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text' },
      ],
    },
    outputSchema: SessionSkillCatalogListOutputSchema,
    inputSchema: SessionCatalogListInputSchema,
  },
  {
    id: 'session.history.get', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'Get session history',
    description: 'DEPRECATED: use session_events_get. Returns diagnostic session events with cleaner pagination.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_history_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":50,"format":"compact"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Read a session\'s earlier events.',
      title: 'Get session history',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        {
          path: 'format',
          title: 'Format',
          widget: 'select',
          options: [
            { value: 'compact', label: 'Compact' },
            { value: 'raw', label: 'Raw' },
          ],
        },
        { path: 'includeMeta', title: 'Include meta', widget: 'boolean' },
        { path: 'includeStructuredPayload', title: 'Include structured payload', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHistoryGetInputSchema,
  },
  {
    id: 'session.transcript.get', approval: {result: 'required'},
    title: 'Get session transcript',
    sideEffectClass: 'read',
    description: 'Read a semantic transcript page, or select one committed message by messageId, with optional tool/reasoning/event flags.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionTranscript', mcpToolName: 'session_transcript_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":20,"cursor":null,"direction":"before","roles":["user","assistant"],"maxCharsPerMessage":null}' },
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":20,"cursor":null,"direction":"before","roles":["user","assistant"],"maxCharsPerMessage":null}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Read a session\'s conversation.',
      title: 'Get session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'messageId', title: 'Committed message id', description: 'Select one message instead of paging.', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        {
          path: 'direction',
          title: 'Direction',
          description: 'Page away from the cursor: before reads older items (the default), after reads newer ones.',
          widget: 'select',
          options: [
            { value: 'before', label: 'Before cursor (older)' },
            { value: 'after', label: 'After cursor (newer)' },
          ],
        },
        {
          path: 'maxCharsPerMessage',
          title: 'Message truncation chars',
          description: 'Optional per-message truncation budget. Omit or pass null for full message text.',
          widget: 'text',
        },
      ],
    },
    outputSchema: SessionTranscriptGetResultSchema,
    inputSchema: SessionTranscriptGetInputSchema,
    surfaceBindings: {
      api: {
        inputSchema: SessionTranscriptGetPublicInputSchema,
        outputSchema: SessionTranscriptGetResultSchema,
      },
      plugin: {
        inputSchema: SessionTranscriptGetExternalShareableInputV1Schema,
        outputSchema: SessionTranscriptGetExternalShareableResultV1Schema,
      },
    } satisfies ActionSpecSurfaceBindings,
  },
  {
    id: 'session.events.get', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'Get session events',
    description: 'Inspect raw session events (tool calls, tool results, token counts, lifecycle, permission, stream, session events) for diagnostics. Use session_transcript_get for normal transcript reading.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_events_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":50,"kinds":["tool_call","tool_result"]}' },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Look through everything that happened in a session, including tool calls, for troubleshooting.',
      title: 'Get session events',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionEventsGetInputSchema,
  },
  {
    id: 'session.wait.idle', approval: {result: 'required'},
    title: 'Wait for session idle',
    description: 'Wait until the session becomes idle or the timeout elapses.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { voiceClientToolName: 'session_wait_idle', mcpToolName: 'session_wait_idle' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","timeoutSeconds":300}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Wait until a session\'s agent has finished its turn.',
      title: 'Wait for idle',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'timeoutSeconds', title: 'Timeout seconds', widget: 'text' },
      ],
    },
    outputSchema: SessionWaitIdleResultSchema,
    inputSchema: SessionWaitIdleInputSchema,
    cli: SESSION_WAIT_IDLE_CLI_PROJECTION,
    surfaceBindings: {
      api: {
        inputSchema: SessionWaitIdlePublicInputSchema,
        outputSchema: SessionWaitIdleResultSchema,
      },
    } satisfies ActionSpecSurfaceBindings,
  },
  {
    id: 'session.permission.respond', approvalPolicy: { agentDefault: 'authority', requiredSurfaces: ['mcp'] }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Respond to permission request',
    sideEffectClass: 'write',
    description: 'Approve or deny an active permission request in a session.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.permission.respond' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'Allow or deny something a session\'s agent asked to do.',
      title: 'Respond to permission request',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'deny', label: 'Deny' },
          ],
        },
        { path: 'requestId', title: 'Request id', widget: 'text' },
        { path: 'turnId', title: 'Turn id', widget: 'text' },
      ],
    },
    outputSchema: SessionInteractionResponseSuccessSchema,
    inputSchema: SessionPermissionRespondInputSchema,
  },
  {
    id: 'session.approval_reviewer.set', approval: {result: 'none'},
    title: 'Set session approval reviewer',
    description: 'Enable or disable request-only background approval review for this session.',
    safety: 'safe',
    sideEffectClass: 'write',
    requiredAuthority: 'present_user',
    placements: [],
    surfaces: { ui: true, cli: true, agent: false, mcp: false, voice: false, rpc: false },
    inputHints: { description: 'Let a reviewer agent look at a session\'s requests before they reach you.', title: 'Set session approval reviewer', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'enabled', title: 'Enabled', widget: 'boolean', required: true },
    ] },
    inputSchema: lazyZodSchema(() => z.strictObject({ sessionId: z.string().check(z.trim(), z.minLength(1)), enabled: z.boolean() })),
    outputSchema: lazyZodSchema(() => z.strictObject({ updated: z.literal(true) })),
  },
  {
    id: 'session.attention.set', approval: {result: 'none'},
    title: 'Settle or snooze a session',
    description: 'Write the caller\u2019s own Inbox attention standing for a session: settle it (standing false), keep it standing, or snooze it until a time (remindAt). Settle pairs with session.read_state.set. Agent calls use the normal Action approval policy.',
    safety: 'safe',
    sideEffectClass: 'write',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    placements: [],
    surfaces: { ui: true, cli: true, voice: true, agent: true, mcp: true, rpc: false },
    bindings: { mcpToolName: 'session_attention_set', voiceClientToolName: 'session_attention_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","standing":false}' },
    },
    inputHints: {
      title: 'Settle or snooze a session',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'standing', title: 'Keep in Needs you', widget: 'boolean' },
        { path: 'remindAt', title: 'Snooze until (epoch ms)', widget: 'integer' },
      ],
    },
    inputSchema: SessionAttentionSetInputV1Schema,
    outputSchema: SessionAttentionSetResultV1Schema,
    serverTransport: { method: 'PUT', path: SESSION_ATTENTION_STANDING_HTTP_PATH_V1 },
  },
  {
    id: 'session.permission.remote.pending.list', approval: {result: 'none'},
    title: 'List remotely mediated permission requests',
    sideEffectClass: 'read',
    description: 'List the caller mediator’s current permission requests for one exact source authority.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      description: 'See requests from a session that are waiting for someone else\'s answer.',
      title: 'List remotely mediated permission requests',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'sourceRef', title: 'Source reference', widget: 'text', required: true },
        { path: 'sourceRevisionOrEpoch', title: 'Source revision', widget: 'text', required: true },
        { path: 'cursor', title: 'Continuation cursor', widget: 'text' },
      ],
    },
    outputSchema: SessionPermissionRemotePendingListOutputV1Schema,
    inputSchema: SessionPermissionRemotePendingListInputV1Schema,
  },
  {
    id: 'session.permission.remote.respond', approval: {result: 'none'},
    title: 'Respond to a remotely mediated permission request',
    sideEffectClass: 'write',
    description: 'Submit an attributed external-human decision for one current permission request.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      description: 'Answer a session\'s request on someone else\'s behalf.',
      title: 'Respond to a remotely mediated permission request',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'requestId', title: 'Request id', widget: 'text', required: true },
        { path: 'sourceRef', title: 'Source reference', widget: 'text', required: true },
        { path: 'sourceRevisionOrEpoch', title: 'Source revision', widget: 'text', required: true },
        { path: 'idempotencyKey', title: 'Idempotency key', widget: 'text', required: true },
        { path: 'actor.namespace', title: 'External principal namespace', widget: 'text', required: true },
        { path: 'actor.principalId', title: 'External principal id', widget: 'text', required: true },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'deny', label: 'Deny' },
          ],
        },
        {
          path: 'scope',
          title: 'Scope',
          widget: 'select',
          required: true,
          options: [
            { value: 'request', label: 'This request' },
            { value: 'session', label: 'This session' },
          ],
        },
      ],
    },
    outputSchema: SessionPermissionRemoteRespondOutputV1Schema,
    inputSchema: SessionPermissionRemoteRespondInputV1Schema,
  },
  {
    id: 'session.user_action.remote.answer', approval: {result: 'none'},
    title: 'Answer a remotely mediated user-action request',
    sideEffectClass: 'write',
    description: 'Submit bounded indexed answers for one current source-bound AskUserQuestion request.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    inputHints: {
      description: 'Answer a session\'s question on someone else\'s behalf.',
      title: 'Answer a remotely mediated user-action request',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'requestId', title: 'Request id', widget: 'text', required: true },
        { path: 'sourceRef', title: 'Source reference', widget: 'text', required: true },
        { path: 'sourceRevisionOrEpoch', title: 'Source revision', widget: 'text', required: true },
        { path: 'answers', title: 'Indexed answers', widget: 'json', required: true },
      ],
    },
    outputSchema: SessionUserActionRemoteAnswerOutputV1Schema,
    inputSchema: SessionUserActionRemoteAnswerInputV1Schema,
  },
  {
    id: 'session.permission.remote.grants.list', approval: {result: 'none'},
    title: 'List remotely mediated permission grants',
    sideEffectClass: 'read',
    description: 'List source-scoped remote permission grants visible to the authenticated caller.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.permission.remote.grants.list', mcpToolName: 'session_permission_remote_grants_list' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'See what has been allowed for a session on someone else\'s behalf.',
      title: 'List remotely mediated permission grants',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'limit', title: 'Maximum grants', widget: 'text' },
        { path: 'cursor', title: 'Continuation cursor', widget: 'text' },
      ],
    },
    outputSchema: SessionPermissionRemoteGrantsListOutputV1Schema,
    inputSchema: SessionPermissionRemoteGrantsListInputV1Schema,
  },
  {
    id: 'session.permission.remote.grants.revoke', approval: {result: 'none'},
    title: 'Revoke a remotely mediated permission grant',
    sideEffectClass: 'write',
    description: 'Revoke one source-scoped remote permission grant.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.permission.remote.grants.revoke', mcpToolName: 'session_permission_remote_grants_revoke' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'Take back something allowed for a session on someone else\'s behalf.',
      title: 'Revoke a remotely mediated permission grant',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'requestId', title: 'Request id', widget: 'text', required: true },
        { path: 'grantId', title: 'Grant id', widget: 'text', required: true },
      ],
    },
    outputSchema: SessionPermissionRemoteGrantRevokeOutputV1Schema,
    inputSchema: SessionPermissionRemoteGrantRevokeInputV1Schema,
  },
  {
    id: 'session.needs_you.raise', approval: { result: 'optional', flow: 'deferred' },
    title: 'Ask the user',
    description: 'Ask one structured question request in the current session, or withdraw a request you raised.',
    sideEffectClass: 'write',
    executionPlacement: 'session',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'raiseNeedsYou', mcpToolName: 'session_needs_you_raise', rpcMethod: 'session.needs_you.raise' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session', widget: 'text' },
      { path: 'mode', title: 'Wait or continue', widget: 'select', options: [
        { value: 'wait', label: 'Wait' }, { value: 'continue', label: 'Continue' },
      ] },
      { path: 'type', title: 'Question type', widget: 'select', options: [
        { value: 'decision', label: 'Decision' }, { value: 'blocked', label: 'Blocked' },
      ] },
      { path: 'title', title: 'Title', widget: 'text' },
      { path: 'questions', title: 'Questions', widget: 'json' },
      { path: 'assumption', title: 'Continue-mode assumption', widget: 'text' },
      { path: 'lasting', title: 'Lasting decision', widget: 'boolean' },
      { path: 'requestId', title: 'Request to withdraw', widget: 'text' },
      { path: 'withdraw', title: 'Withdrawal reason', widget: 'text' },
    ] },
    inputSchema: SessionNeedsYouRaiseInputV1Schema,
    outputSchema: SessionNeedsYouRaiseOutputV1Schema,
  },
  {
    id: 'session.user_action.answer', approval: {result: 'optional',flow: 'deferred'},
    title: 'Respond to user-action request',
    sideEffectClass: 'write',
    description: 'Approve, reject, request changes, or provide structured answers for an active user-action request.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'answerUserActionRequest', mcpToolName: 'session_user_action_answer', rpcMethod: 'session.user_action.answer' },
    examples: {
      voice: {
        argsExample:
          '{"sessionId":"{{sessionId}}","answers":[{"question":"Continue?","values":["Yes"]}]}',
      },
    },
    surfaceBindings: {
      plugin: {
        inputSchema: SessionUserActionAnswerPluginInputSchema,
        bindInput: bindPluginSessionInteractionInput,
        projectOutput: projectPluginSessionInteractionResponse,
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      description: 'Answer a question or review a request from a session\'s agent.',
      title: 'Respond to user-action request',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'requestId', title: 'Request id', widget: 'text' },
        {
          path: 'decision',
          title: 'Decision',
          description: 'Use approve or reject for general user actions, or request_changes when you need the coding assistant to revise something first.',
          widget: 'select',
          options: [
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
            { value: 'request_changes', label: 'Request changes' },
          ],
        },
        {
          path: 'reason',
          title: 'Reason',
          description: 'Required when requesting changes. Optional extra context for a rejection.',
          widget: 'textarea',
        },
        {
          path: 'answers',
          title: 'Answers',
          description: 'Structured answers for question-style user-action requests such as AskUserQuestion.',
          widget: 'json',
        },
      ],
    },
    outputSchema: SessionInteractionResponseSuccessSchema,
    inputSchema: SessionUserActionAnswerInputSchema,
  },
  {
    id: 'session.control.switch', approval: { result: 'optional', flow: 'deferred' },
    title: 'Switch Session control',
    description: 'Switch between local terminal and remote control through the active Session terminal owner.',
    safety: 'safe',
    sideEffectClass: 'write',
    executionPlacement: 'session',
    placements: [],
    bindings: { mcpToolName: 'session_control_switch', rpcMethod: 'switch' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text' },
      { path: 'to', title: 'Control', widget: 'select', required: true, options: [
        { value: 'remote', label: 'Remote' }, { value: 'local', label: 'Local terminal' },
      ] },
    ] },
    inputSchema: SessionControlSwitchInputSchema,
    outputSchema: SessionControlSwitchOutputSchema,
  },
  {
    id: 'session.mode.set', approval: {result: 'optional',flow: 'deferred'},
    title: 'Set session mode',
    sideEffectClass: 'write',
    description: 'Request a new ACP session mode for the current session when the active provider supports session modes.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setSessionMode', mcpToolName: 'session_mode_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","modeId":"plan"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Switch a session\'s agent to another mode, such as planning.',
      title: 'Set session mode',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', description: 'Optional when the active target session is already correct.', widget: 'text' },
        {
          path: 'modeId',
          title: 'Mode id',
          description: 'Use default to clear the override and return to the provider default mode.',
          widget: 'select',
          required: true,
          optionsSourceId: 'session.modes.available',
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionModeSetInputSchema,
  },
  {
    id: 'session.config_option.set', approval: {result: 'optional',flow: 'deferred'},
    executionPlacement: 'client',
    title: 'Set session configuration option',
    sideEffectClass: 'write',
    description: 'Set one provider-owned configuration option for the current session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_config_option_set' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Set session configuration option',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'configId', title: 'Configuration id', widget: 'text', required: true },
        { path: 'valueId', title: 'Value id', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionConfigOptionSetInputSchema,
  },
  {
    id: 'session.connected_services_auth.set', approval: {result: 'optional',flow: 'deferred'},
    executionPlacement: 'client',
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Set session connected-account routing',
    sideEffectClass: 'write',
    description: 'Apply a confirmed connected-account routing selection to the current session.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'session_connected_services_auth_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    inputHints: { title: 'Set session connected-account routing', fields: [] },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionConnectedServicesAuthSetInputSchema,
  },
  {
    id: 'session.target.primary.set', approval: {result: 'optional',flow: 'deferred'},
    title: 'Set primary action session',
    sideEffectClass: 'write',
    description: 'Set which session the voice assistant should target by default.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setPrimaryActionSession', mcpToolName: 'session_target_primary_set' },
    examples: {
      voice: { argsExample: '{"serverId":"{{serverId}}","sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: true,
      cli: false,
      rpc: false,
      },
    inputHints: {
      description: 'Choose the session Voice talks to by default.',
      title: 'Set primary action session',
      fields: [
        { path: 'serverId', title: 'Home id', widget: 'text' },
        { path: 'sessionId', title: 'Session id (or null)', prompt: 'Which session?', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionPrimaryTargetInputSchema,
  },
  {
    id: 'session.target.tracked.set', approval: {result: 'optional',flow: 'deferred'},
    title: 'Set Include in Voice sessions',
    sideEffectClass: 'write',
    description: 'Set which sessions are included in Voice through Account Follow.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'setTrackedSessions', mcpToolName: 'session_target_tracked_set' },
    examples: {
      voice: { argsExample: '{"sessionAddresses":[{"serverId":"{{serverId}}","sessionId":"{{sessionId}}"}]}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Choose which sessions Voice keeps you up to date on.',
      title: 'Set Include in Voice sessions',
      fields: [{ path: 'sessionIds', title: 'Session ids', widget: 'text_list', required: true, listSeparator: 'comma' }],
    },
    outputSchema: VoiceTrackedTargetsActionResultV1Schema,
    inputSchema: SessionTrackedTargetsInputSchema,
  },
  {
    id: 'session.list', approval: {result: 'required'},
    title: 'List sessions',
    sideEffectClass: 'read',
    description: 'List recent sessions the user can target.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSessions', mcpToolName: 'session_list' },
    examples: {
      voice: { argsExample: '{"limit":20,"cursor":null}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'See your recent sessions.',
      title: 'List sessions',
      fields: [
        {
          // The representation selector belongs to the canonical form hints so every generated
          // UI/CLI/SDK/MCP projection offers the same choice instead of adding a local control.
          path: 'view',
          title: 'View',
          description: 'Summary rows, or the marked operational awareness projection.',
          widget: 'select',
          options: SESSION_VIEW_INPUT_OPTIONS,
        },
        { path: 'underSessionId', title: 'Session led subtree', widget: 'text' },
        { path: 'project', title: 'Project', description: 'Exact Home and accepted Project key.', widget: 'json' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeLastMessagePreview', title: 'Include last message preview', widget: 'boolean' },
      ],
    },
    outputSchema: SessionListActionResultV1Schema,
    inputSchema: SessionListActionInputV1Schema,
    cli: SESSION_LIST_CLI_PROJECTION,
  },
  {
    id: 'session.activity.get', approval: {result: 'required'},
    title: 'Get session activity',
    sideEffectClass: 'read',
    description: 'Get a short activity digest for a session without transcript content.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionActivity', mcpToolName: 'session_activity_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'See a short summary of what a session has been doing.',
      title: 'Get session activity',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        {
          // Same canonical selector as `session.list`: every generated UI/CLI/SDK/MCP projection
          // offers awareness here instead of a caller composing it from a local digest.
          path: 'view',
          title: 'View',
          description: 'The released activity digest, or the canonical awareness projection.',
          widget: 'select',
          options: SESSION_VIEW_INPUT_OPTIONS,
        },
        { path: 'windowSeconds', title: 'Window seconds', widget: 'text' },
      ],
    },
    outputSchema: SessionActivityActionResultV1Schema,
    inputSchema: SessionActivityInputSchema,
    projectSessionConfirmation: (input, { sessionId }) => {
      const parsed = SessionActivityInputSchema.safeParse(input);
      if (!parsed.success || parsed.data.sessionId !== sessionId) return null;
      return {
        sessionId,
        ...(parsed.data.windowSeconds !== undefined ? { windowSeconds: parsed.data.windowSeconds } : {}),
      };
    },
  },
  {
    id: 'session.messages.recent.get', sideEffectClass: 'read', approval: {result: 'required'},
    sessionTarget: { field: 'sessionId', cardinality: 'many' },
    title: 'Get recent messages',
    description: 'DEPRECATED: use session_transcript_get. Returns semantic transcript items with cleaner pagination.',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'getSessionRecentMessages', mcpToolName: 'session_messages_recent_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":3,"cursor":null}' },
      },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Read a session\'s latest messages.',
      title: 'Get recent messages',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeUser', title: 'Include user', widget: 'boolean' },
        { path: 'includeAssistant', title: 'Include assistant', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionRecentMessagesInputSchema,
  },
] as const));

// Keep exact Session row/schema carriers in a separately named tuple so the
// declaration serializer does not have to inline the entire trailing catalog.
const ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX = Object.freeze(defineActionSpecs([
  {
    id: 'ui.voice_global.reset', approval: {result: 'none'},
    title: 'Reset voice agent',
    sideEffectClass: 'write',
    safety: 'danger',
    executionPlacement: 'client',
    requiredAuthority: 'account_automation',
    placements: ['voice_panel', 'command_palette', 'slash_command'],
    slash: { tokens: ['/h.voice.reset'] },
    bindings: { voiceClientToolName: 'resetGlobalVoiceAgent', mcpToolName: 'ui_voice_global_reset' },
    inputHints: {
      title: 'Reset voice agent',
      description: 'Reset the global voice agent state (clears the current voice conversation).',
      fields: [],
    },
    examples: {
      voice: { argsExample: '{}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'ui.pet.choose', approval: { result: 'optional', flow: 'deferred' },
    title: 'Choose pet',
    description: 'Choose an Account pet and inherit it on this device, set a device pet override, or open pet settings with empty input.',
    safety: 'safe',
    sideEffectClass: 'write',
    executionPlacement: 'client',
    requiredAuthority: 'account_automation',
    bindings: { mcpToolName: 'ui_pet_choose' },
    placements: ['slash_command'],
    slash: { tokens: ['/pet', '/h.pet'] },
    inputHints: {
      title: 'Choose pet',
      description: 'Provide petRef for the Account default or deviceOverride for this answering device. Empty input opens pet settings.',
      fields: [],
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    outputSchema: PetChooseResultV1Schema,
    inputSchema: PetChooseInputV1Schema,
    // Empty input is the chooser navigation; a typed selection reads from the spec description.
    approvalPresentation: { summary: (input: unknown) => (
      input !== null && typeof input === 'object' && Object.keys(input).length === 0 ? 'Open pet settings.' : null
    ) },
  },
  {
    id: 'ui.voice_agent.teleport', approval: {result: 'optional',flow: 'deferred'},
    title: 'Teleport voice agent to session root',
    sideEffectClass: 'write',
    description: 'Move the daemon-backed voice agent into the current or specified session root.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'teleportVoiceAgentToSessionRoot', mcpToolName: 'ui_voice_agent_teleport' },
    inputHints: {
      title: 'Teleport voice agent',
      description: 'Teleport the active voice agent into a session root. Defaults to the current action session when omitted.',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' }],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: OptionalSessionIdInputSchema,
  },
  {
    id: 'ui.current_context.read', approval: {result: 'required'},
    title: 'Read current UI context',
    description: 'Read the current local UI navigation context and its complete opaque command inventory.',
    sideEffectClass: 'read',
    safety: 'safe',
    placements: [],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'readCurrentUiContext', mcpToolName: 'read_current_ui_context' },
    cli: { commands: [{ path: ['ui', 'current-context', 'read'], visibility: 'canonical' }], acceptsServerId: true },
    examples: {
      voice: { argsExample: '{}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Read current UI context',
      description: 'Returns only the current local navigation snapshot and opaque command descriptors.',
      fields: [],
    },
    outputSchema: CurrentUiContextSnapshotV1Schema,
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'account.home_continuation.invoke', approval: {result: 'required'},
    title: 'Continue Home connection',
    description: 'Request an exact mounted authenticated Account continuation: choose a Home, retry, refresh, stop waiting, relink or open the enrolled Home. A human in that Account decides; key, credential and QR acquisition remain human-only.',
    requiredAuthority: 'present_user', safety: 'safe', sideEffectClass: 'write', placements: [],
    bindings: { mcpToolName: 'account_home_continuation_invoke' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    inputHints: { title: 'Continue Home connection', fields: [
      { path: 'operation', title: 'Continuation step', widget: 'text', required: true },
      { path: 'commandId', title: 'Current mounted command', widget: 'text', required: true },
      { path: 'homeServerIdentityId', title: 'Chosen Home identity (choose only)', widget: 'text' },
    ] },
    inputSchema: AccountHomeContinuationInputV1Schema,
    outputSchema: AccountHomeContinuationResultV1Schema,
  },
  {
    id: 'ui.current_context.command.invoke', approval: {result: 'required'},
    title: 'Invoke current UI command',
    description: 'Invoke one currently available opaque command from the local current UI context. If the result is `denied`, the person declined the confirmation: report that and do not invoke it again unless they ask.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: [],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'invokeCurrentUiCommand', mcpToolName: 'invoke_current_ui_command' },
    cli: { commands: [{ path: ['ui', 'current-context', 'command', 'invoke'], positionals: ['commandId'], visibility: 'canonical' }], acceptsServerId: true },
    examples: {
      voice: { argsExample: '{"commandId":"current-ui:1:0"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Invoke current UI command',
      description: 'Use only an opaque command id returned by readCurrentUiContext; semantic command data is never accepted here.',
      fields: [
        { path: 'commandId', title: 'Opaque command id', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: CurrentUiContextCommandInvokeInputSchema,
  },
  {
    id: 'memory.search', approval: {result: 'required'},
    title: 'Search memory',
    sideEffectClass: 'read',
    description: 'Search the selected daemon memory index by global, Session, or qualified Project scope. Project search requires explicit support from that daemon and never falls back to global search.',
    safety: 'safe',
    placements: ['voice_panel', 'command_palette'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'memorySearch', mcpToolName: 'memory_search' },
    inputHints: {
      title: 'Search memory',
      description: 'Search across sessions using the daemon-local memory index.',
      fields: [
        {
          path: 'machineId',
          title: 'Machine id',
          description: 'Machine running the daemon memory index.',
          widget: 'text',
          required: true,
        },
        {
          path: 'query.query',
          title: 'Query',
          description: 'What to search for.',
          widget: 'text',
          required: true,
        },
        {
          path: 'query.mode',
          title: 'Mode',
          description: 'Which index to search.',
          widget: 'select',
          required: true,
          options: [
            { value: 'hints', label: 'Hints' },
            { value: 'deep', label: 'Deep' },
            { value: 'auto', label: 'Auto' },
          ],
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","query":{"v":1,"query":"openclaw","scope":{"type":"global"},"mode":"hints"}}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","query":{"v":1,"query":"openclaw","scope":{"type":"global"},"mode":"hints"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: MemorySearchResultV1Schema,
    inputSchema: MemorySearchInputSchema,
  },
  {
    id: 'search.settings.get', approval: {result: 'required'}, title: 'Read Search settings',
    description: 'Read the machine-local memory and conversation Search settings.',
    sideEffectClass: 'read', safety: 'safe', executionPlacement: 'machine', placements: [],
    bindings: { mcpToolName: 'search_settings_get', sdkMethod: 'conversationSearch.settings.get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MemoryMachineInputSchema, outputSchema: MemorySettingsV1Schema,
    inputHints: { title: 'Read Search settings', fields: [{ path: 'machineId', title: 'Machine id', widget: 'text', required: true }] },
  },
  {
    id: 'search.settings.set', approval: {result: 'required'}, title: 'Save Search settings',
    description: 'Save the canonical machine-local memory and conversation Search settings.',
    sideEffectClass: 'write', safety: 'safe', executionPlacement: 'machine', placements: [],
    bindings: { mcpToolName: 'search_settings_set', sdkMethod: 'conversationSearch.settings.set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: SearchSettingsSetInputSchema, outputSchema: MemorySettingsV1Schema,
    inputHints: { title: 'Save Search settings', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
      { path: 'settings', title: 'Settings', widget: 'json', required: true },
    ] },
  },
  {
    id: 'memory.status', approval: {result: 'required'}, title: 'Read memory index status',
    description: 'Read readiness, indexing progress and coverage from the machine memory owner.',
    sideEffectClass: 'read', safety: 'safe', executionPlacement: 'machine', placements: [],
    bindings: { voiceClientToolName: 'memory_status', mcpToolName: 'memory_status' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MemoryMachineInputSchema, outputSchema: MemoryStatusV1Schema,
    inputHints: { title: 'Read memory index status', fields: [{ path: 'machineId', title: 'Machine id', widget: 'text', required: true }] },
  },
  {
    id: 'memory.clear_index', approvalPolicy: { uiConfirmation: 'policy' }, approval: {result: 'none'}, title: 'Clear memory index',
    confirmVerb: { key: 'common.reset', fallback: 'Reset' },
    description: 'Clear the machine-local derived memory index. Agent calls require approval by default.',
    sideEffectClass: 'danger', safety: 'danger', executionPlacement: 'machine', placements: [],
    bindings: { voiceClientToolName: 'memory_clear_index', mcpToolName: 'memory_clear_index' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MemoryMachineInputSchema, outputSchema: MemoryClearIndexOutputSchema,
    inputHints: { title: 'Clear memory index', fields: [{ path: 'machineId', title: 'Machine id', widget: 'text', required: true }] },
  },
  {
    id: 'search.conversations', approval: {result: 'required'}, title: 'Search conversations across machines',
    description: 'Search the machines in scope through the connected app conversation-search owner; omitted machineIds selects all machines in scope.',
    sideEffectClass: 'read', safety: 'safe', executionPlacement: 'client', placements: [],
    bindings: { mcpToolName: 'search_conversations', sdkMethod: 'conversationSearch.search' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    inputSchema: SearchConversationsInputV1Schema, outputSchema: SearchConversationsResultV1Schema,
    inputHints: { title: 'Search conversations across machines', fields: [
      { path: 'query', title: 'Memory search query', widget: 'json', required: true },
      { path: 'machineIds', title: 'Machine ids', widget: 'json' },
      { path: 'retryUnreachableMachines', title: 'Retry unreachable machines', widget: 'boolean' },
      { path: 'mode', title: 'Search mode', widget: 'select', options: [
        { value: 'auto', label: 'Best available' }, { value: 'indexed', label: 'Indexed' }, { value: 'standard', label: 'Standard' },
      ] },
    ] },
  },
  {
    id: 'memory.get_window', approval: {result: 'required'},
    title: 'Get memory window',
    sideEffectClass: 'read',
    description: 'Fetch and decrypt a transcript window (used to verify/quote a memory hit).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'memoryGetWindow', mcpToolName: 'memory_get_window' },
    inputHints: {
      title: 'Get memory window',
      description: 'Read a Happier Session range or a native hit using its source, sourceItemId and optional cursor.',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'seqFrom', title: 'Seq from', widget: 'text' },
        { path: 'seqTo', title: 'Seq to', widget: 'text' },
        { path: 'source', title: 'Native transcript source', widget: 'json' },
        { path: 'sourceItemId', title: 'Native message id', widget: 'text' },
        { path: 'cursor', title: 'Native page cursor', widget: 'text' },
      ],
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
    },
    outputSchema: MemoryWindowV1Schema,
    inputSchema: MemoryGetWindowInputSchema,
  },
  {
    id: 'memory.ensure_up_to_date', approval: {result: 'required'},
    title: 'Ensure memory up to date',
    sideEffectClass: 'write',
    description: 'Trigger the daemon to sync memory hints for a session (or all active sessions).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'memoryEnsureUpToDate', mcpToolName: 'memory_ensure_up_to_date' },
    inputHints: {
      title: 'Ensure memory up to date',
      description: 'Forces the daemon memory worker to process new transcript content.',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id (optional)', prompt: 'Which session?', widget: 'text' },
      ],
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
    },
    outputSchema: MemoryEnsureUpToDateOutputSchema,
    inputSchema: MemoryEnsureUpToDateInputSchema,
  },
  {
    id: 'agents.acp.backends.installFromRegistry',
    approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'policy' },
    title: 'Install registry ACP agent',
    description: 'Add or update a pinned registry agent and optionally install it on the selected machines.',
    safety: 'danger', sideEffectClass: 'write', executionPlacement: 'account', requiredAuthority: 'account_automation',
    placements: [], bindings: { mcpToolName: 'agents_acp_backends_install_from_registry' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: AgentsAcpBackendsInstallFromRegistryInputV1Schema,
    outputSchema: AgentsAcpBackendsInstallFromRegistryOutputV1Schema,
    inputHints: { title: 'Install registry ACP agent', fields: [
      { path: 'fromRegistry.sourceId', title: 'Registry source', widget: 'text', required: true },
      { path: 'fromRegistry.itemId', title: 'Agent id', widget: 'text', required: true },
      { path: 'fromRegistry.version', title: 'Version', widget: 'text', required: true },
      { path: 'installOn', title: 'Install on machines', widget: 'text_list', listSeparator: 'comma' },
    ] },
    cli: { acceptsServerId: true,
      inputSchema: lazyZodSchema(() => z.strictObject({ registryItem: z.optional(z.string().check(z.minLength(1))), version: z.optional(z.string().check(z.minLength(1))),
        install: z.optional(z.enum(['now', 'first-use'])), machine: z.optional(z.array(z.string().check(z.minLength(1)))),
        fromRegistry: z.optional(AgentsAcpBackendsInstallFromRegistryInputV1Schema.shape.fromRegistry),
        installOn: AgentsAcpBackendsInstallFromRegistryInputV1Schema.shape.installOn,
        command: z.optional(z.string().check(z.minLength(1))), name: z.optional(z.string().check(z.minLength(1))), title: z.optional(z.string().check(z.minLength(1))),
        args: z.optional(z.array(z.string())), dryRun: z.optional(z.boolean()) })),
      bindInput: raw => {
        const input = readRecord(raw);
        const locator = typeof input.registryItem === 'string' ? input.registryItem : '';
        return { fromRegistry: input.fromRegistry ?? { ...readRegistryAgentCliLocatorV1(locator), version: input.version },
          ...(input.install === 'first-use' ? {} : input.installOn || input.machine ? { installOn: input.installOn ?? input.machine } : {}) };
      },
      commands: [{ path: ['agents', 'acp', 'backends', 'install-from-registry'], visibility: 'canonical' },
        { path: ['agents', 'add'], positionals: ['registryItem'], visibility: 'alias' }] },
    projectObservationInput: input => {
      const parsed = AgentsAcpBackendsInstallFromRegistryInputV1Schema.safeParse(input);
      return parsed.success ? { fromRegistry: parsed.data.fromRegistry, installOn: parsed.data.installOn } : undefined;
    },
    projectObservationOutput: output => {
      const parsed = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.safeParse(output);
      return parsed.success ? { definitionId: parsed.data.definition.id, jobs: parsed.data.jobs } : undefined;
    },
  },
  {
    id: 'agents.acp.backends.get', approval: {result: 'required'},
    title: 'Read custom ACP agent',
    description: 'Read one full Account-private configured ACP agent definition and its catalog revision.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'agents_acp_backends_get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: AgentsAcpBackendsGetInputV1Schema,
    outputSchema: AgentsAcpBackendsGetOutputV1Schema,
    cli: { acceptsServerId: true, commands: [{ path: ['agents', 'acp', 'backends', 'get'], positionals: ['backendId'], visibility: 'canonical' }] },
    projectObservationOutput: output => {
      const parsed = AgentsAcpBackendsGetOutputV1Schema.safeParse(output);
      return parsed.success ? { backendId: parsed.data.backend.id, revision: parsed.data.revision } : undefined;
    },
    inputHints: { title: 'Read custom ACP agent', fields: [
      { path: 'backendId', title: 'Id', widget: 'text', required: true },
    ] },
  },
  {
    id: 'agents.acp.backends.upsert', approval: {result: 'required'}, approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Save custom ACP agent',
    description: 'Add or replace one custom ACP agent (a command that speaks the Agent Client Protocol) in the Account agent catalog. Names must be unique; an existing id is replaced.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'agents_acp_backends_upsert' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    outputSchema: AgentsAcpBackendsUpsertOutputV1Schema,
    inputSchema: AgentsAcpBackendsUpsertInputV1Schema,
    approvalPresentation: { summary: () => null, projectInput: projectAcpBackendApprovalInput,
      inputSchema: AcpBackendApprovalInputSchema, retainInputOnSettlement: true },
    cli: { acceptsServerId: true, commands: [{ path: ['agents', 'acp', 'backends', 'upsert'], visibility: 'canonical' }] },
    inputHints: {
      title: 'Save custom ACP agent',
      fields: [
        { path: 'backend.id', title: 'Id', widget: 'text', required: true },
        { path: 'backend.name', title: 'Name', widget: 'text', required: true },
        { path: 'backend.title', title: 'Agent', widget: 'text', required: true },
        { path: 'backend.launch', title: 'Launch', widget: 'json', required: true },
        { path: 'backend.description', title: 'Description', widget: 'textarea' },
        { path: 'backend.env', title: 'Environment variables', widget: 'json' },
        { path: 'backend.auth', title: 'Sign-in', widget: 'json' },
        { path: 'backend.runtime', title: 'Runtime behavior', widget: 'json' },
        { path: 'backend.defaultMode', title: 'Default mode', widget: 'text' },
        { path: 'backend.defaultModel', title: 'Default model', widget: 'text' },
        { path: 'backend.capabilities', title: 'Capabilities', widget: 'json' },
        { path: 'backend.origin', title: 'Source', widget: 'json' },
        { path: 'backend.compatibility', title: 'Compatibility', widget: 'json' },
        { path: 'backend.createdAt', title: 'Created at', widget: 'text' },
        { path: 'backend.updatedAt', title: 'Updated at', widget: 'text' },
        { path: 'dryRun', title: 'Preview only', widget: 'boolean' },
        { path: 'expectedRevision', title: 'Reviewed revision', widget: 'text' },
        { path: 'sourceSettingsVersion', title: 'Reviewed settings version', widget: 'text' },
      ],
    },
  },
  {
    id: 'agents.acp.backends.delete', approval: {result: 'required'}, approvalPolicy: { uiConfirmation: 'policy' },
    title: 'Delete custom ACP agent',
    description: 'Remove one custom ACP agent from the Account agent catalog.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'agents_acp_backends_delete' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    outputSchema: AgentsAcpBackendsDeleteOutputV1Schema,
    inputSchema: AgentsAcpBackendsDeleteInputV1Schema,
    cli: { acceptsServerId: true, commands: [{ path: ['agents', 'delete'], positionals: ['backendId'], visibility: 'canonical' },
      { path: ['agents', 'acp', 'backends', 'delete'], positionals: ['backendId'], visibility: 'alias' }] },
    inputHints: {
      title: 'Delete custom ACP agent',
      fields: [
        { path: 'backendId', title: 'Agent', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'prompt_doc.get', approval: {result: 'required'},
    title: 'Read prompt document',
    description: 'Read the current prompt document and its observed Artifact revision.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_get', voiceClientToolName: 'getPromptDoc' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.strictObject({ artifactId: z.string().check(z.minLength(1)) })),
    outputSchema: lazyZodSchema(() => z.strictObject({ ok: z.literal(true), artifactId: z.string().check(z.minLength(1)), title: z.string().check(z.minLength(1)), markdown: z.string(),
      revision: PromptDocRevisionV1Schema })),
    inputHints: { title: 'Read prompt document', fields: [
      { path: 'artifactId', title: 'Prompt artifact id', widget: 'text', required: true },
    ] },
  },
  {
    id: 'prompt_doc.create', approval: {result: 'none'},
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Create prompt document',
    description: 'Create an Account-private prompt document in the Happier prompt library.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_create', voiceClientToolName: 'createPromptDoc' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: PromptDocCreateActionInputV1Schema,
    outputSchema: lazyZodSchema(() => z.strictObject({ ok: z.literal(true), artifactId: z.string().check(z.minLength(1)) })),
    inputHints: { title: 'Create prompt document', fields: [
      { path: 'starter', title: 'Built-in starter', widget: 'text',
        visibleWhen: { op: 'eq', path: 'starter', value: 'happier_guide' } },
      { path: 'title', title: 'Title', widget: 'text', required: true,
        visibleWhen: { op: 'not', predicate: { op: 'eq', path: 'starter', value: 'happier_guide' } } },
      { path: 'markdown', title: 'Markdown', widget: 'textarea', required: true,
        visibleWhen: { op: 'not', predicate: { op: 'eq', path: 'starter', value: 'happier_guide' } } },
      { path: 'folderId', title: 'Folder id', widget: 'text' },
      { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      { path: 'favorite', title: 'Favourite', widget: 'boolean' },
      { path: 'createFolder', title: 'New folder', widget: 'json' },
    ] },
  },
  {
    id: 'models.favorite.set', approval: {result: 'none'},
    title: 'Favorite model',
    description: 'Add or remove an exact Agent, source and model selection from Account favorites.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'models_favorite_set' },
    inputSchema: ModelFavoriteMutationV1Schema,
    outputSchema: lazyZodSchema(() => z.strictObject({ status: z.literal('updated') })),
    inputHints: { fields: [{ path: 'selection', title: 'Model selection', widget: 'json', required: true },
      { path: 'favorite', title: 'Favorite', widget: 'boolean', required: true }] },
    cli: { acceptsServerId: true, commands: [{ path: ['models', 'favorite', 'set'], visibility: 'canonical' }] },
  },
  {
    id: 'session.model.unarm', approval: {result: 'none'}, title: 'Cancel armed model switch',
    description: 'Restore the running Session’s applied route and model for the next message.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'session', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'session_model_unarm' },
    inputSchema: lazyZodSchema(() => z.strictObject({ sessionId: z.string().check(z.minLength(1)) })),
    outputSchema: SessionModelTransitionResultV1Schema,
    inputHints: { fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }] },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'model', 'unarm'], visibility: 'canonical' }] },
  },
  {
    id: 'prompt_doc.favorite.set', approval: {result: 'none'},
    title: 'Set prompt favourite',
    description: 'Set a prompt document favourite without changing its content.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_favorite_set', voiceClientToolName: 'setPromptDocFavorite' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.strictObject({ artifactId: z.string().check(z.minLength(1)), favorite: z.boolean() })),
    outputSchema: lazyZodSchema(() => z.strictObject({ ok: z.literal(true), artifactId: z.string().check(z.minLength(1)) })),
    inputHints: { title: 'Set prompt favourite', fields: [
      { path: 'artifactId', title: 'Prompt artifact id', widget: 'text', required: true },
      { path: 'favorite', title: 'Favourite', widget: 'boolean', required: true },
    ] },
  },
  {
    id: 'prompts.library.list', approval: {result: 'required'},
    title: 'List prompt library',
    description: 'List prompt document headers without fetching their bodies.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'prompts_library_list', voiceClientToolName: 'listPromptLibrary' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.strictObject({ query: z.optional(z.string()) })),
    outputSchema: lazyZodSchema(() => z.strictObject({ coverage: z.enum(['complete', 'partial', 'unavailable']), items: z.array(z.strictObject({
      artifactId: z.string().check(z.minLength(1)), title: z.string(), folderId: z.nullable(z.string()), tags: z.array(z.string()),
      favorite: z.boolean(), updatedAtMs: z.number(),
    })) })),
    inputHints: { title: 'List prompt library', fields: [{ path: 'query', title: 'Search', widget: 'text' }] },
  },
  {
    id: 'prompts.stack.update', approval: {result: 'required'}, title: 'Update account instructions', safety: 'safe', sideEffectClass: 'write',
    requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'prompts_stack_update', rpcMethod: 'prompts.stack.update' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: PromptLibraryStackUpdateInputV1Schema, outputSchema: PromptLibraryStackUpdateResultV1Schema,
    // The private review names the exact semantic edit; shared observations
    // intentionally retain only the stack surface and its revision.
    approvalPresentation: { summary: () => null, projectInput: (input: unknown) => PromptLibraryStackUpdateInputV1Schema.parse(input) },
    projectObservationInput: (input: unknown) => { const value = readRecord(input); return { surface: value.surface, expectedRevision: value.expectedRevision }; },
    projectObservationOutput: (output: unknown) => { const value = readRecord(output); return { status: value.status, revision: value.revision }; },
    inputHints: { description: 'Change the instructions and context every session in your account starts with.', fields: [] },
    cli: { acceptsServerId: true, commands: [{ path: ['prompts', 'stack', 'update'], visibility: 'canonical' }] },
  },
  {
    id: 'prompt_doc.update', approval: {result: 'none'},
    title: 'Update prompt document',
    description: 'Update a prompt document. Supply the reviewed Artifact revision to refuse changed content without rebasing the edit.',
    safety: 'danger',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_update', voiceClientToolName: 'updatePromptDoc' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: z.strictObject({ ok: z.literal(true), artifactId: z.string(), revision: z.optional(PromptDocRevisionV1Schema) }),
    inputSchema: PromptDocUpdateInputSchema,
    inputHints: {
      title: 'Update prompt document',
      fields: [
        { path: 'artifactId', title: 'Prompt artifact id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'markdown', title: 'Markdown', widget: 'textarea', required: true },
        { path: 'expectedRevision.headerVersion', title: 'Reviewed header version', widget: 'text' },
        { path: 'expectedRevision.bodyVersion', title: 'Reviewed body version', widget: 'text' },
        { path: 'createFolder', title: 'New folder', widget: 'json' },
        { path: 'folderId', title: 'Folder id', widget: 'text' },
        { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
  },
  {
    id: 'prompt_bundle.update', approval: {result: 'none'},
    title: 'Update prompt bundle',
    description: 'Update a skill bundle stored in the Happier prompt library.',
    safety: 'danger', sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'prompt_bundle_update', voiceClientToolName: 'updatePromptBundle' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: lazyZodSchema(() => z.strictObject({ ok: z.literal(true), artifactId: z.string().check(z.minLength(1)), revision: z.optional(PromptDocRevisionV1Schema) })),
    inputSchema: PromptBundleUpdateActionInputV1Schema,
    inputHints: {
      title: 'Update prompt bundle',
      fields: [
        { path: 'artifactId', title: 'Bundle artifact id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'skillMarkdown', title: 'SKILL.md markdown', widget: 'textarea' },
        { path: 'entries', title: 'Files', widget: 'json' },
        { path: 'createFolder', title: 'New folder', widget: 'json' },
        { path: 'expectedRevision.headerVersion', title: 'Reviewed header version', widget: 'text' },
        { path: 'expectedRevision.bodyVersion', title: 'Reviewed body version', widget: 'text' },
        { path: 'folderId', title: 'Folder id', widget: 'text' },
        { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
  },
  {
    id: 'prompt_registry.install', approval: {result: 'optional',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    sideEffectClass: 'external',
    title: 'Install prompt registry skill',
    description: 'Import a skill bundle from a registry into the Happier library.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptRegistryInstallInputSchema,
    inputHints: {
      title: 'Install prompt registry skill',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sourceId', title: 'Source id', widget: 'text', required: true },
        { path: 'itemId', title: 'Item id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'daemon.filesystem.readFile', approvalPolicy: { rpcConfirmation: true }, approval: {result: 'required'},
    title: 'Read file',
    description: 'Read a bounded file or byte range under the explicitly admitted workspace root. A range length uses the daemon inline-read ceiling; its offset defaults to zero.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.filesystem.readFile', rpcMethodAliases: [RPC_METHODS.READ_FILE], mcpToolName: 'daemon_filesystem_read_file', voiceClientToolName: 'daemonFilesystemReadFile' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    sideEffectClass: 'read',
    outputSchema: FilesystemReadFileOutputSchema,
    inputSchema: FilesystemReadFileInputSchema,
    inputHints: { fields: [
      { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
      { path: 'path', title: 'File path', widget: 'text', required: true },
      { path: 'offset', title: 'Offset', widget: 'text' },
      { path: 'length', title: 'Length', widget: 'text' },
    ] },
  },
  {
    id: 'daemon.filesystem.writeFile', approvalPolicy: { rpcConfirmation: true, uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    workspaceWrite: true,
    title: 'Write file',
    description: 'Write a bounded file under the explicitly admitted workspace root.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'daemon.filesystem.writeFile', rpcMethodAliases: [RPC_METHODS.WRITE_FILE], mcpToolName: 'daemon_filesystem_write_file', voiceClientToolName: 'daemonFilesystemWriteFile' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    sideEffectClass: 'danger',
    outputSchema: FilesystemWriteFileOutputSchema,
    approvalPresentation: { summary: describeWriteFileApprovalSummary, projectInput: projectWriteFileApprovalInput },
    inputSchema: FilesystemWriteFileInputSchema,
    inputHints: { fields: [
      { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
      { path: 'path', title: 'File path', widget: 'text', required: true },
      { path: 'content', title: 'Content', description: 'Base64-encoded file bytes', widget: 'text', required: true },
      { path: 'expectedHash', title: 'Expected current SHA-256', widget: 'text' },
    ] },
  },
  {
    id: 'daemon.filesystem.createDirectory', approvalPolicy: { rpcConfirmation: true, uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Create directory',
    description: 'Create a directory under the explicitly admitted workspace root.',
    safety: 'danger',
    workspaceWrite: true,
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_FILESYSTEM_CREATE_DIRECTORY, rpcMethodAliases: [RPC_METHODS.CREATE_DIRECTORY], mcpToolName: 'daemon_filesystem_create_directory', voiceClientToolName: 'daemonFilesystemCreateDirectory' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    sideEffectClass: 'danger',
    inputSchema: FilesystemCreateDirectoryInputSchema,
    outputSchema: FilesystemMutationOutputSchema,
    approvalPresentation: { summary: describeCreateDirectoryApprovalSummary },
    inputHints: { fields: [
      { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
      { path: 'path', title: 'Directory path', widget: 'text', required: true },
    ] },
  },
  {
    id: 'daemon.filesystem.rename', approvalPolicy: { rpcConfirmation: true, uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Rename path',
    description: 'Rename a path under the explicitly admitted workspace root.',
    safety: 'danger',
    workspaceWrite: true,
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_FILESYSTEM_RENAME, rpcMethodAliases: [RPC_METHODS.RENAME_PATH], mcpToolName: 'daemon_filesystem_rename', voiceClientToolName: 'daemonFilesystemRename' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    sideEffectClass: 'danger',
    inputSchema: FilesystemRenameInputSchema,
    outputSchema: FilesystemMutationOutputSchema,
    approvalPresentation: { summary: describeRenameApprovalSummary },
    inputHints: { fields: [
      { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
      { path: 'from', title: 'Source path', widget: 'text', required: true },
      { path: 'to', title: 'Destination path', widget: 'text', required: true },
      { path: 'overwrite', title: 'Replace existing destination', widget: 'boolean', required: true },
    ] },
  },
  {
    id: 'daemon.filesystem.delete', approvalPolicy: { rpcConfirmation: true }, approval: {result: 'optional',flow: 'deferred'},
    confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true,
    title: 'Delete path',
    description: 'Delete a path under the explicitly admitted workspace root.',
    safety: 'danger',
    workspaceWrite: true,
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_FILESYSTEM_DELETE, rpcMethodAliases: [RPC_METHODS.DELETE_PATH], mcpToolName: 'daemon_filesystem_delete', voiceClientToolName: 'daemonFilesystemDelete' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    sideEffectClass: 'danger',
    inputSchema: FilesystemDeleteInputSchema,
    outputSchema: FilesystemMutationOutputSchema,
    approvalPresentation: { summary: describeDeleteApprovalSummary },
    inputHints: { fields: [
      { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
      { path: 'path', title: 'Path', widget: 'text', required: true },
      { path: 'recursive', title: 'Delete directory contents', widget: 'boolean', required: true },
    ] },
  },
  {
    id: 'daemon.filesystem.copy', approvalPolicy: { rpcConfirmation: true }, approval: {result: 'required'},
    title: 'Copy path',
    description: 'Copy within an admitted root, or copy admitted entries between qualified filesystem targets.',
    approvalResultCustody: 'live_only',
    projectObservationOutput: () => ({ redacted: true }),
    safety: 'danger',
    workspaceWrite: true,
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_FILESYSTEM_COPY, rpcMethodAliases: [RPC_METHODS.COPY_PATH], mcpToolName: 'daemon_filesystem_copy', voiceClientToolName: 'daemonFilesystemCopy' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    sideEffectClass: 'danger',
    operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'activity' } },
    inputSchema: FilesystemCopyInputSchema,
    outputSchema: FilesystemCopyOutputSchema,
    inputHints: { fields: [
      { path: 'rootPath', title: 'Local workspace root', widget: 'text' },
      { path: 'from', title: 'Local source path', widget: 'text' },
      { path: 'to', title: 'Local destination path', widget: 'text' },
      { path: 'source', title: 'Qualified admitted source', widget: 'json' },
      { path: 'destination', title: 'Qualified destination', widget: 'json' },
      { path: 'overwrite', title: 'Replace existing destination', widget: 'boolean', required: true },
      { path: 'recursive', title: 'Copy directory contents', widget: 'boolean', required: true },
    ] },
  },
  {
    id: 'daemon.filesystem.upload', approvalPolicy: { rpcConfirmation: true, uiConfirmation: 'direct' }, approval: {result: 'required'},
    title: 'Upload file',
    approvalPresentation: { summary: describeUploadApprovalSummary },
    description: 'Upload actual bytes from the prepared source into the admitted workspace root.',
    approvalResultCustody: 'live_only',
    projectObservationOutput: () => ({ redacted: true }),
    safety: 'danger', workspaceWrite: true, sideEffectClass: 'danger', placements: [],
    operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'activity' } },
    bindings: { rpcMethod: RPC_METHODS.DAEMON_FILESYSTEM_UPLOAD, mcpToolName: 'daemon_filesystem_upload', voiceClientToolName: 'daemonFilesystemUpload' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: FilesystemUploadInputSchema, outputSchema: FilesystemUploadOutputSchema,
    inputHints: { fields: [
      { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
      { path: 'path', title: 'Destination path', widget: 'text', required: true },
      { path: 'source', title: 'Prepared source', widget: 'json', required: true },
      { path: 'overwrite', title: 'Replace existing destination', widget: 'boolean', required: true },
    ] },
  },
  {
    id: 'daemon.filesystem.download', approvalPolicy: { rpcConfirmation: true, uiConfirmation: 'direct' }, approval: {result: 'required'},
    title: 'Download file',
    description: 'Download actual bytes into the admitted destination and acknowledge successful destination close.',
    approvalResultCustody: 'live_only',
    projectObservationOutput: () => ({ redacted: true }),
    safety: 'danger', sideEffectClass: 'danger', placements: [],
    operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'activity' } },
    bindings: { rpcMethod: RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD, mcpToolName: 'daemon_filesystem_download', voiceClientToolName: 'daemonFilesystemDownload' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: FilesystemDownloadInputSchema, outputSchema: FilesystemDownloadOutputSchema,
    inputHints: { fields: [
      { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
      { path: 'path', title: 'Source path', widget: 'text', required: true },
      { path: 'destination', title: 'Admitted destination', widget: 'json', required: true },
      { path: 'asZip', title: 'Download as ZIP', widget: 'boolean', required: true },
    ] },
  },
  {
    id: 'daemon.filesystem.transfer.cancel', approvalPolicy: { rpcConfirmation: true }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Cancel file transfer',
    description: 'Cancel only the transfer owned by the admitted requester and workspace root.',
    safety: 'danger', sideEffectClass: 'danger', placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_FILESYSTEM_TRANSFER_CANCEL, mcpToolName: 'daemon_filesystem_transfer_cancel', voiceClientToolName: 'daemonFilesystemTransferCancel' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: FilesystemTransferCancelInputSchema, outputSchema: FilesystemTransferCancelOutputSchema,
    inputHints: { fields: [
      { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
      { path: 'direction', title: 'Transfer direction', widget: 'text', required: true },
      { path: 'transferId', title: 'Owned transfer', widget: 'text', required: true },
    ] },
  },
  {
    id: 'daemon.filesystem.listDirectory', approvalPolicy: { rpcConfirmation: true }, approval: {result: 'required'},
    title: 'List directory',
    description: 'List a directory under the explicitly admitted workspace root.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.LIST_DIRECTORY, mcpToolName: 'daemon_filesystem_list_directory', voiceClientToolName: 'daemonFilesystemListDirectory' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    sideEffectClass: 'read',
    outputSchema: FilesystemListDirectoryOutputSchema,
    inputSchema: FilesystemListDirectoryInputSchema,
    inputHints: { fields: [
      { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
      { path: 'path', title: 'Directory path', widget: 'text', required: true },
      { path: 'includeGitIgnore', title: 'Include Git ignore state', widget: 'boolean' },
    ] },
  },
  {
    id: 'daemon.filesystem.getDirectoryTree', approvalPolicy: { rpcConfirmation: true }, approval: {result: 'required'},
    title: 'Get directory tree',
    description: 'Read a bounded directory tree under the explicitly admitted workspace root.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.filesystem.getDirectoryTree', rpcMethodAliases: [RPC_METHODS.GET_DIRECTORY_TREE], mcpToolName: 'daemon_filesystem_get_directory_tree', voiceClientToolName: 'daemonFilesystemGetDirectoryTree' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    sideEffectClass: 'read',
    outputSchema: FilesystemGetDirectoryTreeOutputSchema,
    inputSchema: FilesystemGetDirectoryTreeInputSchema,
    inputHints: { fields: [
      { path: 'rootPath', title: 'Workspace root', widget: 'text', required: true },
      { path: 'path', title: 'Directory path', widget: 'text', required: true },
      { path: 'maxDepth', title: 'Maximum depth', widget: 'text', required: true },
    ] },
  },
  {
    id: 'daemon.filesystem.listRoots', approval: {result: 'required'},
    title: 'List filesystem roots',
    description: 'List bounded machine file-browser roots resolved from daemon filesystem access policy.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.filesystem.listRoots' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: EmptyObjectSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.browseDirectory', approval: {result: 'required'},
    title: 'Browse filesystem directory',
    description: 'List a machine file-browser directory constrained to a configured browse root.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.filesystem.listDirectory' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: DaemonFilesystemListDirectoryRequestSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.submit', approvalPolicy: { uiConfirmation: 'policy' }, approval: {result: 'required'},
    confirmVerb: { key: 'common.send', fallback: 'Send' }, irreversible: true,
    title: 'Submit bug report',
    description: 'Submit the report and selected diagnostics to the configured report service and Happier issue destination under your approval policy. Crash reporting and replay follow the existing crash-report preference separately.',
    safety: 'danger',
    sideEffectClass: 'external',
    requiredAuthority: 'account_automation',
    executionPlacement: 'client',
    placements: [],
    bindings: { mcpToolName: 'bugreport_submit' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: BugReportSubmitInputSchema,
    outputSchema: BugReportSubmitOutputSchema,
    // The raw report and pasted diagnostics stay on this live invocation.
    // Approval can replay only that retained input through the same owner.
    approvalInputCustody: 'live_only',
    projectObservationInput: projectBugReportSubmitInput,
    approvalPresentation: { summary: () => 'Submit this report and selected diagnostic attachments to the reviewed destination. Ask-first follows your approval policy. Crash reporting and replay retain their separate preference.' },
    inputHints: { fields: [
      { path: 'draft.title', title: 'Report title', widget: 'text', required: true },
      { path: 'draft.summary', title: 'Summary', widget: 'text', required: true },
      { path: 'draft.includeDiagnostics', title: 'Include diagnostics', widget: 'text', required: true },
      { path: 'draft.diagnosticsKinds', title: 'Diagnostic selections', widget: 'json' },
      { path: 'draft.acceptedPrivacyNotice', title: 'Privacy notice acknowledged', widget: 'text', required: true },
      { path: 'pastedCliDoctorSnapshotJson', title: 'Pasted diagnostics', widget: 'secret' },
      { path: 'destination', title: 'Exact report destination', widget: 'json', required: true },
    ] },
  },
  {
    id: 'bugreport.collectDiagnostics', approval: {result: 'required'},
    title: 'Collect bug report diagnostics',
    description: 'Collect bounded, redacted daemon diagnostics for a bug report.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.collectDiagnostics' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: PassthroughEmptyObjectSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.getLogTail', approval: {result: 'required'},
    title: 'Read bug report log tail',
    description: 'Read a bounded daemon log tail from diagnostics-approved candidate paths.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.getLogTail' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: BugReportGetLogTailInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.uploadArtifact', approval: {result: 'optional',flow: 'deferred'},
    title: 'Upload bug report artifact',
    description: 'Return daemon-side bug report artifact upload availability without exposing secret material.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.uploadArtifact' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'none',
    outputSchema: StrictJsonValueSchema,
    inputSchema: BugReportUploadArtifactInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'approval.request.list', approvalPolicy: { control: true }, approval: {result: 'required'},
    title: 'List approval requests',
    description: 'List approval queue entries from targeted approval artifact headers.',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'approval_request_list', mcpToolName: 'approval_request_list', rpcMethod: 'approval.request.list' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestListInputSchema,
    inputHints: {
      title: 'List approval requests',
      description: 'Reads bounded approval queue metadata from artifact headers without transcript hydration.',
      fields: [
        { path: 'actionId', title: 'Action id', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        {
          path: 'status',
          title: 'Status',
          widget: 'select',
          options: [
            { value: 'open', label: 'Open' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'executed', label: 'Executed' },
            { value: 'failed', label: 'Failed' },
            { value: 'canceled', label: 'Canceled' },
          ],
        },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
  },
  {
    id: 'approval.request.get', approvalPolicy: { control: true }, approval: {result: 'required'},
    title: 'Get approval request',
    description: 'Fetch one approval request by approval artifact id.',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'approval_request_get', mcpToolName: 'approval_request_get', rpcMethod: 'approval.request.get' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'read',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestGetInputSchema,
    inputHints: {
      title: 'Get approval request',
      fields: [
        { path: 'artifactId', title: 'Approval artifact id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'approval.request.create', approvalPolicy: { control: true }, approval: {result: 'none'},
    title: 'Create approval request',
    description: 'Create an approval request for another action to run.',
    safety: 'danger',
    placements: [],
    bindings: { voiceClientToolName: 'approval_request_create', mcpToolName: 'approval_request_create', rpcMethod: 'approval.request.create' },
    surfaceBindings: {
      plugin: { inputSchema: PluginSurfaceApprovalRequestCreateInputSchema },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'write',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestCreateInputSchema,
    inputHints: {
      title: 'Request approval',
      description: 'Create an approval request in the global inbox.',
      fields: [
        { path: 'summary', title: 'Summary', widget: 'textarea', required: true },
        { path: 'actionId', title: 'Action id', widget: 'text', required: true },
        { path: 'actionArgs', title: 'Action args (json)', widget: 'textarea', required: true },
      ],
    },
  },
  {
    id: 'approval.request.decide', originalExecution: { accountRoot: 'allowed' }, approvalPolicy: { control: true }, approval: {result: 'none'},
    projectObservationOutput: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const { liveExecution: _liveExecution, ...observed } = value as Record<string, unknown>;
      return observed;
    },
    title: 'Decide approval request',
    description: 'Approve, reject or cancel an open approval request. Cancellation settles without authorizing its effect.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'approval_request_decide', rpcMethod: 'approval.request.decide' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'write',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestDecideInputSchema,
    inputHints: {
      title: 'Approve, reject or cancel',
      fields: [
        { path: 'artifactId', title: 'Approval artifact id', widget: 'text', required: true },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
            { value: 'cancel', label: 'Cancel' },
          ],
        },
      ],
    },
  },
  {
    id: 'session.log.tail', approval: {result: 'required'},
    title: 'Tail session log',
    description: 'Read a bounded byte tail from an allowed session log file.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSION_LOG_TAIL },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: SessionLogTailOutputSchema,
    inputSchema: SessionLogTailInputSchema,
    inputHints: {
      description: 'Read the end of a session\'s log.',
      title: 'Tail session log',
      fields: [
        { path: 'path', title: 'Log path', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'offset', title: 'File offset', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.page', approval: {result: 'required'},
    title: 'Page session transcript',
    description: 'Read a bounded older transcript page using cursor-backed storage.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_PAGE },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptPageOutputSchema,
    inputSchema: TranscriptPageInputSchema,
    inputHints: {
      description: 'Read earlier parts of a session\'s conversation.',
      title: 'Page session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.readAfter', approval: {result: 'required'},
    title: 'Read session transcript after cursor',
    description: 'Read bounded transcript deltas after a cursor.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_READ_AFTER },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptReadAfterOutputSchema,
    inputSchema: TranscriptReadAfterInputSchema,
    inputHints: {
      description: 'Read what a session has said since a point in its conversation.',
      title: 'Read session transcript after cursor',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.follow', approval: {result: 'required'},
    title: 'Follow session transcript',
    description: 'Create or refresh a retained bounded transcript follow lease.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_FOLLOW },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptFollowOutputSchema,
    inputSchema: TranscriptFollowInputSchema,
    inputHints: {
      description: 'Keep up with a session\'s conversation as it happens.',
      title: 'Follow session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
        { path: 'idleTtlMs', title: 'Idle TTL milliseconds', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.unfollow', approval: {result: 'none'},
    title: 'Unfollow session transcript',
    description: 'Release a retained transcript follow lease.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_UNFOLLOW },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: TranscriptUnfollowOutputSchema,
    inputSchema: TranscriptUnfollowInputSchema,
    inputHints: {
      description: 'Stop keeping up with a session\'s conversation.',
      title: 'Unfollow session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'leaseId', title: 'Lease id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'transcript.import', approval: {result: 'optional',flow: 'deferred'},
    title: 'Import session transcript rows',
    description: 'Import a bounded batch of transcript rows through the session transcript writer owner.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_IMPORT },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: TranscriptImportOutputSchema,
    inputSchema: TranscriptImportInputSchema,
    inputHints: {
      description: 'Add messages to a session\'s conversation from another record of it.',
      title: 'Import session transcript rows',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'importId', title: 'Import id', widget: 'text' },
        { path: 'items', title: 'Transcript rows', widget: 'textarea', required: true },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.search', approval: {result: 'required'},
    title: 'Search session transcript',
    description: 'Search transcript rows through bounded forward cursor reads.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_SEARCH },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptReadAfterOutputSchema,
    inputSchema: TranscriptSearchInputSchema,
    inputHints: {
      description: 'Search a session\'s conversation.',
      title: 'Search session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'query', title: 'Query', widget: 'text', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
        { path: 'maxReads', title: 'Maximum reads', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.candidates.list', approval: {result: 'required'},
    title: 'List external session candidates',
    description: 'List attachable external session candidates through the external-session machine RPC.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY],
      sdkMethod: 'sessions.external.listCandidates',
      mcpToolName: 'sessions_external_candidates_list',
    },
    cli: { commands: [{ path: ['sessions', 'external', 'candidates', 'list'], visibility: 'canonical' }], acceptsServerId: true },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionsCandidatesListResponseSchema,
    inputSchema: ExternalSessionsCandidatesListRequestSchema,
    inputHints: {
      description: 'See sessions you started outside Happier that you can bring in.',
      title: 'List external session candidates',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'searchTerm', title: 'Search term', widget: 'text' },
        { path: 'searchTarget', title: 'Search target (metadata or content)', widget: 'text' },
        { path: 'searchMode', title: 'Metadata search mode (fast or full)', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.candidate.delete', approval: {result: 'optional',flow: 'deferred'},
    confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true,
    title: 'Delete external session candidate',
    description: "Delete one Agent-owned session a resume-only external-session listing surfaced. The Agent's own record is removed; no Happier Session is deleted.",
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_CANDIDATE_DELETE,
      mcpToolName: 'sessions_external_candidate_delete',
      // cli-v0.2.1 / ui-web-v0.2.0 name this same operation
      // `daemon.directSessions.candidate.delete` and carry `providerId`. It is
      // the identical Agent-side deletion addressed by the identical opaque
      // identifier, so the released spelling dispatches this canonical Action
      // instead of gaining a second decision-maker; the request reader admits
      // the released identity and the registrar maps the released failure
      // literal back. Remove when no supported client or rollback target sends
      // it.
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_CANDIDATE_DELETE_LEGACY],
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionCandidateDeleteResponseSchema,
    inputSchema: ExternalSessionCandidateDeleteRequestSchema,
    inputHints: {
      description: 'Delete a session you started outside Happier from that agent\'s own list; nothing in Happier is deleted.',
      title: 'Delete external session candidate',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.link.ensure', approval: {result: 'optional',flow: 'deferred'},
    title: 'Ensure external session link',
    description: 'Create or reuse the Happier link for an external provider session.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE,
      mcpToolName: 'sessions_external_link_ensure',
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY],
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionLinkEnsureResponseSchema,
    inputSchema: ExternalSessionLinkEnsureRequestSchema,
    inputHints: {
      description: 'Link a session you started outside Happier so it shows here.',
      title: 'Ensure external session link',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'titleHint', title: 'Title hint', widget: 'text' },
        { path: 'directoryHint', title: 'Directory hint', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.follow', approval: {result: 'optional',flow: 'deferred'},
    title: 'Follow external session lease',
    description: 'Attach an ephemeral follow lease to an external session link.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH,
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionAttachRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionAttachResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionViewerFollowActionResultV1Schema,
    inputSchema: ExternalSessionViewerFollowActionInputV1Schema,
    inputHints: {
      description: 'Keep up with a session you started outside Happier while you watch it.',
      title: 'Follow external session lease',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text' },
        { path: 'ttlMs', title: 'Lease TTL milliseconds', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.unfollow', approval: {result: 'optional',flow: 'deferred'},
    title: 'Unfollow external session lease',
    description: 'Detach an external-session follow lease.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH,
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionDetachRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionDetachResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionViewerUnfollowActionResultV1Schema,
    inputSchema: ExternalSessionViewerUnfollowActionInputV1Schema,
    inputHints: {
      description: 'Stop keeping up with a session you started outside Happier.',
      title: 'Unfollow external session lease',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.backgroundFollow.set', approval: {result: 'optional',flow: 'deferred'},
    title: 'Set external session follow policy',
    description: 'Enable or disable background following for an external session.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionFollowPolicySetRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionFollowPolicySetResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionBackgroundFollowActionInputV1Schema,
        projectOutput: projectExternalSessionBackgroundFollowResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionBackgroundFollowActionResultV1Schema,
    inputSchema: ExternalSessionBackgroundFollowActionInputV1Schema,
    inputHints: {
      description: 'Choose whether Happier keeps up with an outside session even when you are not watching it.',
      title: 'Set external session follow policy',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'enabled', title: 'Enabled', widget: 'boolean', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.status.get', approval: {result: 'required'},
    title: 'Get external session status',
    description: 'Read bounded status and takeover readiness for a linked external session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET_LEGACY],
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionStatusGetRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionStatusGetResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionStatusActionInputV1Schema,
        projectOutput: projectExternalSessionStatusResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionStatusActionResultV1Schema,
    inputSchema: ExternalSessionStatusActionInputV1Schema,
    inputHints: {
      description: 'See the state of a session you started outside Happier, and whether you can take it over.',
      title: 'Get external session status',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.transcript.page', approval: {result: 'required'},
    title: 'Page external session transcript',
    description: 'Read a bounded transcript page for an external provider session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE_LEGACY],
      sdkMethod: 'sessions.external.pageTranscript',
      mcpToolName: 'sessions_external_transcript_page',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionTranscriptPageResponseSchema,
    inputSchema: ExternalSessionTranscriptPageRequestSchema,
    inputHints: {
      description: 'Read earlier parts of a session you started outside Happier.',
      title: 'Page external session transcript',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'direction', title: 'Direction', widget: 'select', required: true, options: [
          { value: 'older', label: 'Older' },
          { value: 'newer', label: 'Newer' },
        ] },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.transcript.readAfter', approval: {result: 'required'},
    title: 'Read external session transcript after cursor',
    description: 'Read bounded transcript deltas after a cursor for an external provider session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER_LEGACY],
      sdkMethod: 'sessions.external.readAfterTranscript',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: lazyZodSchema(() => z.union([
      ExternalSessionTranscriptReadAfterResponseSchema,
      ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
    ])),
    inputSchema: lazyZodSchema(() => z.union([
      ExternalSessionTranscriptReadAfterRequestSchema,
      ExternalSessionTranscriptRefreshReadAfterRequestV1Schema,
    ])),
    inputHints: {
      description: 'Read what an outside session has said since a point in its conversation.',
      title: 'Read external session transcript after cursor',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.takeover', approval: {result: 'optional',flow: 'deferred'},
    title: 'Take over external session',
    description: 'Move a linked external session into a Happier-managed terminal runtime.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER,
      rpcMethodAliases: [
        RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
        RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
      ],
      sdkMethod: 'sessions.external.takeover.execute',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionTakeoverResultV1Schema,
    inputSchema: ExternalSessionTakeoverActionInputSchema,
    inputHints: {
      description: 'Move a session you started outside Happier into Happier so you can steer it here.',
      title: 'Take over external session',
      fields: [
        { path: 'linkedSessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'targetRuntimeMode', title: 'Target runtime mode', widget: 'select', required: true, options: [
          { value: 'terminal', label: 'Terminal' },
        ] },
        { path: 'storageMode', title: 'Storage mode', widget: 'select', required: true, options: [
          { value: 'external-linked', label: 'External linked' },
          { value: 'persisted', label: 'Persisted' },
        ] },
      ],
    },
  },
  // Keep this generated family out of the large suffix tuple's serialized
  // inference. Its exact schemas remain in the canonical family projection.
  ...SCM_GIT_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec),
  ...COMMAND_PALETTE_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec),
  ...FIND_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec),
  ...PROMPT_PICKER_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec),
  ...PROMPT_INVOCATION_CREATE_ACTION_SPECS.map((spec): PreNormalizedActionSpec => spec),
  ...SESSION_PENDING_NEXT_ACTION_SPECS,
] as const));

const ACTION_SPECS_WITHOUT_APPROVAL: readonly (
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_PENDING)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_OPENING)[number]
  | (typeof DISCUSSION_ACTION_SPECS_V1)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_CONTINUATION)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX)[number]
  | (typeof ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX)[number]
)[] = Object.freeze([
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD,
  ...ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES,
  ...ACTION_SPECS_WITHOUT_APPROVAL_PREFIX,
  ...ACTION_SPECS_WITHOUT_APPROVAL_PENDING,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_OPENING,
  ...DISCUSSION_ACTION_SPECS_V1,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_CONTINUATION,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX,
  ...ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX,
]);

// Coordination ruling, 2026-10-14: this plugin-originated request is not a
// user UI capability. Grant/dismiss remain human-owned approval proposals;
// list/revoke are user administration and are exposed to Agent and MCP.
export const AGENT_ACTION_EXCLUSION_REASONS = Object.freeze({
  'plugins.permissions.grants.request': 'Permission requests originate from host-stamped plugin provenance, not a user UI operation.',
  'session.view.toolCalls.set': 'Plan 60 §6 reserves transcript visibility for human UI, user Voice and genuine CLI callers.',
} as const satisfies Readonly<Partial<Record<ActionId, string>>>);

/**
 * API exclusions for plugin protocol operations whose canonical input relies
 * on host-stamped provenance. Agent/MCP user administration is independently
 * declared by each Action's surfaces; this API list does not exclude it.
 */
export const PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_REASONS = Object.freeze({
  'capture.view': 'Viewing requires an exact mounted plugin caller and a live viewer occurrence.',
  'automation.event.sources.list': 'Automation source identity is selected from the host-stamped plugin caller.',
  'automation.event.admit': 'Automation event admission persists the host-stamped plugin source identity.',
  'automation.event.source.status.report': 'Automation source status is attributed to the host-stamped plugin caller.',
  'automation.conversation.targets.list': 'Automation conversation targets are selected from the host-stamped plugin caller.',
  'automation.conversation.target.verify': 'Automation conversation target verification requires host-stamped plugin provenance.',
  'automation.conversation.admit': 'Automation conversation admission persists host-stamped plugin provenance.',
  'session.permission.remote.pending.list': 'The remote-permission mediator identity comes only from the host-stamped plugin caller.',
  'session.permission.remote.respond': 'The remote-permission mediator identity comes only from the host-stamped plugin caller.',
  'session.user_action.remote.answer': 'The remote user-action mediator identity comes only from the host-stamped plugin caller.',
  'plugins.permissions.grants.revoke': 'Plugin self-revocation resolves the grant owner from the host-stamped plugin caller.',
  'plugin.webhook.endpoint.checkCorrespondence': 'Endpoint correspondence verification requires the host-stamped plugin caller; a present user administers endpoints through plugin.webhook.endpoint.read.',
  'plugin.webhook.endpoint.convergeTarget': 'Endpoint target convergence authorizes the host-stamped plugin caller against its own source correspondence; a present user administers endpoints through plugin.webhook.endpoint.retarget.',
  'sessions.external.materialize.start': 'External-session materialization persists plugin-authored intent from the host-stamped caller.',
  'scm.reviewWorkspace.materializePrepared': 'Prepared review-workspace materialization is invoked only by the host-stamped source plugin.',
} as const satisfies Readonly<Partial<Record<ActionId, string>>>);

export type PluginProvenanceOnlyActionId = keyof typeof PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_REASONS;

/**
 * Present-user operations whose canonical input contains human-entered secret
 * material. They remain available to first-party interactive UI/CLI hosts, but
 * are intentionally absent from the generic API and trusted-plugin catalogs.
 */
const CLIENT_EXECUTION_PLACEMENT_ACTION_IDS = [
  ...ACTION_ID_FAMILIES_V1.bug_report_submission,
  'browser.workspace.open',
  ...ACTION_ID_FAMILIES_V1.local_daemon_services,
  ...ACTION_ID_FAMILIES_V1.account_home_continuation,
  ...ACTION_ID_FAMILIES_V1.session_authoring,
  ...ACTION_ID_FAMILIES_V1.composer_ingress,
  ...ACTION_ID_FAMILIES_V1.workflow_authoring,
  ...ACTION_ID_FAMILIES_V1.list_reorder,
  ...ACTION_ID_FAMILIES_V1.session_organization_move,
  'account.encryption.historicalKey.forget',
  'account.encryption.automationTemplates.recover',
  ...NOTIFICATION_CONFIGURATION_ACTION_IDS,
  ...APP_UPDATE_ACTION_IDS,
  ...UPDATES_ACTION_IDS,
  ...ACTION_ID_FAMILIES_V1.session_terminals,
  ...ACTION_ID_FAMILIES_V1.workspace_layout,
  ...APP_SHELL_ACTION_IDS,
  'connectedServices.identityPrivacy.set',
  'connectedServices.billing.open',
  'home.reachNudge.dismiss',
  ...SETTINGS_DECLARATION_ACTION_IDS_V1,
  'homes.connect',
  'machines.add.command',
  'machines.pairing.create',
  'machines.add.ssh.start',
  'machines.add.ssh.status',
  'machines.add.ssh.respond',
  'machines.add.ssh.cancel',
  'servers.list',
  'session.target.primary.set',
  'session.target.tracked.set',
  'devices.simulator.input.orientation',
  ...ACTION_ID_FAMILIES_V1.voice_controls,
  ...ACTION_ID_FAMILIES_V1.current_ui_context,
  ...ACTION_ID_FAMILIES_V1.companion_controls,
] as const satisfies readonly ActionId[];

export type SignedRootActionId = Exclude<
  ActionId,
  InternalActionId
    | HumanSecretApiExcludedActionId
>;

export const PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS = Object.freeze(
  Object.keys(PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_REASONS) as PluginProvenanceOnlyActionId[],
);

const PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_ID_SET = new Set<ActionId>(
  PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS,
);

export function isPluginProvenanceOnlyActionId(actionId: string): actionId is PluginProvenanceOnlyActionId {
  return PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_ID_SET.has(actionId as ActionId);
}

const PRESENT_USER_REQUIRED_ACTION_ID_VALUES = [
  ...ARTIFACT_ACCESS_ACTION_IDS_V1,
  'approval.request.decide',
  'session.user_action.answer',
  'account.plugins.data.erase',
  'account.sessions.signOutEverywhere',
  'sessions.runner.activation.create',
  'sessions.runner.activation.cancel',
  ...ACTION_ID_FAMILIES_V1.account_security.filter(
    (actionId) => actionId !== 'account.security.get',
  ),
  'account.apiTokens.create',
  'account.apiTokens.update',
  'account.apiTokens.revoke',
  'account.apiTokens.revokeAll',
  'plugins.uninstall',
  'plugins.dev.submit',
  'plugins.dev.unregister',
  'plugins.dev.install',
  'plugins.sessionHooks.install',
  'plugins.sessionHooks.disable',
  'plugins.sessionHooks.enable',
  'plugins.sessionHooks.uninstall',
  'plugins.permissions.grants.grant',
  'plugins.permissions.grants.dismissRequest',
  ...(Object.keys(PluginWebhookActionHttpPathsV1) as PluginWebhookPresentUserActionIdV1[])
    .filter(actionId => actionId !== 'plugin.webhook.delivery.replay' && actionId !== 'plugin.webhook.delivery.discard'),
] as const satisfies readonly ActionId[];

type PresentUserRequiredActionId = typeof PRESENT_USER_REQUIRED_ACTION_ID_VALUES[number];

const PRESENT_USER_REQUIRED_ACTION_IDS = new Set<ActionId>(PRESENT_USER_REQUIRED_ACTION_ID_VALUES);

/**
 * External ingress routes from this registry fact. These groups are by the
 * current execution owner, not by Action-id prefix: each exceptional
 * bootstrap/client/session case is named below so a new Action cannot silently
 * inherit a machine route merely because it was added to a neighboring family.
 */
const RUNTIME_ACTION_IDS_WITHOUT_MACHINE_PLACEMENT = new Set<RuntimeActionIdV1>([
  'browser.workspace.open',
  // Intentionally host-internal/fail-closed, so client placement is retained
  // only to keep the registry total while no external owner exists.
  'devices.simulator.input.orientation',
  // Composer attachment is a Session-media operation, not a machine command.
  'browser.recording.attachToComposer',
]);

// These readers resolve a Session id only to load persisted transcript data.
// They can run through any selected available daemon and must not require the
// Session's original publisher to still be present.
const PERSISTED_TRANSCRIPT_READ_ACTION_IDS: readonly ActionId[] = [
  'session.history.get',
  'session.transcript.get',
  'session.events.get',
  'session.messages.recent.get',
  'transcript.page',
  'transcript.readAfter',
  'transcript.search',
];
const PERSISTED_TRANSCRIPT_READ_ACTION_ID_SET = new Set<ActionId>(PERSISTED_TRANSCRIPT_READ_ACTION_IDS);

const ACTION_EXECUTION_PLACEMENT_BY_ID: ReadonlyMap<ActionId, ActionExecutionPlacement> = (() => {
  const placements = new Map<ActionId, ActionExecutionPlacement>();
  const declaredPlacementIds = new Set<ActionId>();
  // Row declarations own placement; the legacy census fills only undeclared rows.
  for (const spec of ACTION_SPECS_WITHOUT_APPROVAL) {
    if ('executionPlacement' in spec && spec.executionPlacement) {
      placements.set(spec.id, spec.executionPlacement);
      declaredPlacementIds.add(spec.id);
    }
  }
  const register = (placement: ActionExecutionPlacement, actionIds: readonly ActionId[]) => {
    for (const actionId of actionIds) {
      if (declaredPlacementIds.has(actionId)) continue;
      if (placements.has(actionId)) {
        throw new Error(`Action ${actionId} has more than one execution placement`);
      }
      placements.set(actionId, placement);
    }
  };

  // Account/server data can run before an exact machine is known.
  register('account', [
    ...MEMORY_DOCUMENT_ACTION_IDS_V1,
    ...ACTION_ID_FAMILIES_V1.project_sources,
    ...MANAGED_MACHINE_ACTION_SPECS.filter((spec) => spec.executionPlacement === 'account').map((spec) => spec.id),
    'home.hub.layout.get',
    'home.hub.layout.update',
    ...ACTION_ID_FAMILIES_V1.todo_session_link,
    ...ACTION_ID_FAMILIES_V1.observation,
    ...ACTION_ID_FAMILIES_V1.connected_services_configuration.filter((id) => id !== 'connectedServices.identityPrivacy.set' && id !== 'connectedServices.quota.reset' && id !== 'connectedServices.billing.open'),
    ...WORK_BOARD_ACTION_IDS_V1,
    ...ARTIFACT_ACCESS_ACTION_IDS_V1,
    ...ARTIFACT_ACTION_IDS_V1.filter((id) => id !== 'artifact.publish_from_file' && id !== 'artifact.export'),
    ...ACTION_ID_FAMILIES_V1.notifications,
    ...ACTION_ID_FAMILIES_V1.session_attention,
    'action.spec.search',
    'action.spec.get',
    'machines.list',
    'session.list',
    // Follow authoring is a Home relation: a valid authorized edge is persisted
    // and waits, so no exact destination runtime has to be reachable.
    ...ACTION_ID_FAMILIES_V1.session_follow,
    // Viewer read state is the same Account-scoped Home relation: the actor's
    // own private frontier, persisted per Account and published only to that
    // Account's devices, so no exact machine has to be reachable.
    ...ACTION_ID_FAMILIES_V1.session_read_state,
    ...ACTION_ID_FAMILIES_V1.session_access,
    'prompt_doc.get',
    'prompt_doc.create',
    'prompt_doc.favorite.set',
    'prompts.library.list',
    'prompts.stack.update',
    'prompts.invocations.list',
    'prompts.invocation.resolve',
    'prompt_doc.update',
    'prompt_bundle.update',
    // The custom ACP catalog is an Account setting: no machine has to be reachable to edit it.
    ...ACTION_ID_FAMILIES_V1.agent_acp_catalog,
    ...ROLE_ACTION_IDS_V1.filter((actionId) => actionId.startsWith('roles.')),
    'launch_profiles.publish',
    ...PROFILE_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'account').map(spec => spec.id),
    ...MCP_SERVER_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'account').map(spec => spec.id),
    ...CAPABILITY_RULES_ACTION_SPECS_V1.map(spec => spec.id),
    ...SKILL_ACTION_SPECS_V1.map(spec => spec.id),
    ...PROVIDER_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'account').map(spec => spec.id),
    ...REMOTE_HOST_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'account').map(spec => spec.id),
    ...ACTION_ID_FAMILIES_V1.approvals,
    ...ACTION_ID_FAMILIES_V1.plugin_permission_grants,
    ...ACTION_ID_FAMILIES_V1.plugin_webhooks,
    ...ACTION_ID_FAMILIES_V1.account_plugin_data,
    ...ACTION_ID_FAMILIES_V1.account_sessions,
    ...ACTION_ID_FAMILIES_V1.discussion,
    ...ACTION_ID_FAMILIES_V1.account_security.filter((id) => id !== 'account.encryption.historicalKey.forget'
      && id !== 'account.encryption.automationTemplates.recover'),
    ...ACTION_ID_FAMILIES_V1.account_api_tokens,
    ...ACTION_ID_FAMILIES_V1.session_organization_resources,
    ...ACTION_ID_FAMILIES_V1.identity_github_apps,
    ...ACTION_ID_FAMILIES_V1.machine_pools,
    ...ACTION_ID_FAMILIES_V1.machine_presets,
    ...ACTION_ID_FAMILIES_V1.ephemeral_runner,
    ...ACTION_ID_FAMILIES_V1.automation_events,
    ...ACTION_ID_FAMILIES_V1.automation_conversation,
    // The Home decides governance, Team and Home-identity operations in its own
    // transaction, so these are Account-placed regardless of which machine
    // invoked them. Identity providers travel the same Home family port.
    ...ACTION_ID_FAMILIES_V1.home_governance,
    ...ACTION_ID_FAMILIES_V1.home_identity,
    ...ACTION_ID_FAMILIES_V1.teams,
    ...ACTION_ID_FAMILIES_V1.identity_providers,
    ...SHARED_SAVED_SECRET_ACTION_IDS_V1,
    ...ACTION_ID_FAMILIES_V1.widgets.filter((id) => id !== 'widgets.item.refresh'),
    ...ACTION_ID_FAMILIES_V1.workflows.filter((actionId) => actionId !== 'workflow.run.start'),
  ]);

  // These actions require an answering app's runtime. Discovery remains
  // placement-neutral; admitted daemon hosts deliver through reverse RPC,
  // while absent client custody returns the canonical typed unavailable result.
  register('client', CLIENT_EXECUTION_PLACEMENT_ACTION_IDS);
  register('client', ACTION_ID_FAMILIES_V1.capture_viewing);
  register('client', ACTION_ID_FAMILIES_V1.scope);
  register('client', ACTION_ID_FAMILIES_V1.command_palette);
  register('client', ACTION_ID_FAMILIES_V1.find);
  register('client', ACTION_ID_FAMILIES_V1.prompt_picker);
  register('client', ACTION_ID_FAMILIES_V1.widgets.filter((id) => id === 'widgets.item.refresh'));
  register('client', PROFILE_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'client').map(spec => spec.id));
  register('client', REMOTE_HOST_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'client').map(spec => spec.id));
  register('client', ACTION_ID_FAMILIES_V1.home_runtime.filter(id => id !== 'home.runtime.restart'));
  register('machine', ['home.runtime.restart']);
  register('machine', PROFILE_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'machine').map(spec => spec.id));
  register('machine', MCP_SERVER_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'machine').map(spec => spec.id));
  register('machine', PROVIDER_ACTION_SPECS_V1.filter(spec => spec.executionPlacement === 'machine').map(spec => spec.id));
  // Workflow effect actions declare their placement on their own spec (`stepActionsV1`).
  for (const spec of WORKFLOW_EFFECT_ACTION_SPECS_V1) register(spec.executionPlacement, [spec.id]);

  // A canonical Session resolves its current machine/daemon owner. Execution
  // runs are intentionally absent: detached runs have no Session owner.
  register('session', [
    ...ROLE_ACTION_IDS_V1.filter((actionId) => actionId.startsWith('session.')),
    ...ACTION_ID_FAMILIES_V1.session_lifecycle.filter((actionId) => actionId !== 'session.spawn_new'),
    'review.engines.list',
    ...ACTION_ID_FAMILIES_V1.messaging,
    ...ACTION_ID_FAMILIES_V1.session_control.filter((actionId) => actionId !== 'session.history.get'),
    ...ACTION_ID_FAMILIES_V1.intent_start,
    ...ACTION_ID_FAMILIES_V1.subagent_registry,
    'session.activity.get',
    ...ACTION_ID_FAMILIES_V1.session_transcripts.filter(
      (actionId) => !PERSISTED_TRANSCRIPT_READ_ACTION_ID_SET.has(actionId),
    ),
    ...ACTION_ID_FAMILIES_V1.session_permissions,
    // The Board lives on the Session's own Home; its records resolve through that owner.
    ...ACTION_ID_FAMILIES_V1.session_board,
    'browser.recording.attachToComposer',
    'sessions.external.follow',
    'sessions.external.unfollow',
    'sessions.external.backgroundFollow.set',
    'sessions.external.status.get',
    'sessions.external.transcript.readAfter',
  ]);

  // The remaining operations are daemon/machine-owned. This includes detached
  // execution runs, local indexes/filesystem/plugin/scm owners, and external
  // session operations whose request selects a concrete daemon runtime.
  register('machine', [
    ...MANAGED_MACHINE_ACTION_SPECS.filter((spec) => spec.executionPlacement === 'machine').map((spec) => spec.id),
    'artifact.publish_from_file',
    'artifact.export',
    'connectedServices.quota.reset',
    ...MACHINE_TERMINAL_ACTION_IDS,
    ...ACTION_ID_FAMILIES_V1.machine_agent_install,
    'action.options.resolve',
    'action.invoke',
    'session.spawn_new',
    ...PERSISTED_TRANSCRIPT_READ_ACTION_IDS,
    'paths.list_recent',
    'projects.open',
    'agents.backends.list',
    'machines.agents.list',
    ...ACTION_ID_FAMILIES_V1.workflow_event_catalog,
    'workspace.files.search',
    ...ACTION_ID_FAMILIES_V1.code_intelligence,
    'workspace.files.replace.preview',
    'workspace.files.replace',
    ...ACTION_ID_FAMILIES_V1.machine_agent_sign_in,
    'agents.models.list',
    'agents.config_options.list',
    'agents.session_modes.list',
    'sessions.spawn.profiles.list',
    'sessions.spawn.connected_services.list',
    'sessions.spawn.mcp_servers.preview',
    ...ACTION_ID_FAMILIES_V1.execution_run_control,
    'workflow.run.start',
    ...ACTION_ID_FAMILIES_V1.memory.filter(id => !MEMORY_DOCUMENT_ACTION_IDS_V1.some(documentId => documentId === id)),
    'prompt_registry.install',
    ...ACTION_ID_FAMILIES_V1.daemon_admin,
    ...ACTION_ID_FAMILIES_V1.filesystem,
    ...ACTION_ID_FAMILIES_V1.plugin_dev_loop,
    ...ACTION_ID_FAMILIES_V1.plugin_settings_administration,
    'sessions.external.candidates.list',
    'sessions.external.candidate.delete',
    'sessions.external.link.ensure',
    'sessions.external.transcript.page',
    'sessions.external.takeover',
    'sessions.external.materialize.start',
    'sessions.external.takeover.start',
    'sessions.external.operation.status.get',
    'sessions.external.operation.cancel',
    'sessions.external.operation.resume',
    'sessions.external.operation.retry',
    'sessions.external.operation.discard',
    ...ACTION_ID_FAMILIES_V1.scm_pull_request,
    ...ACTION_ID_FAMILIES_V1.scm_git,
    ...ACTION_ID_FAMILIES_V1.scm_repository,
    ...ACTION_ID_FAMILIES_V1.scm_diff_summary,
    ...RUNTIME_ACTION_IDS_V1.filter(
      (actionId) => !RUNTIME_ACTION_IDS_WITHOUT_MACHINE_PLACEMENT.has(actionId),
    ),
  ]);

  const missing = ACTION_IDS.filter((actionId) => !placements.has(actionId));
  if (missing.length > 0) {
    throw new Error(`Action execution placement missing for: ${missing.join(', ')}`);
  }
  return placements;
})();

function resolveActionRequiredAuthority(
  spec: Pick<PreNormalizedActionSpec, 'id' | 'requiredAuthority'>,
): ActionRequiredAuthority {
  return spec.requiredAuthority
    ?? (PRESENT_USER_REQUIRED_ACTION_IDS.has(spec.id) ? 'present_user' : 'account_automation');
}

function resolveActionExecutionPlacement(
  spec: Pick<PreNormalizedActionSpec, 'id' | 'executionPlacement'>,
): ActionExecutionPlacement {
  if (spec.executionPlacement) return spec.executionPlacement;
  const placement = ACTION_EXECUTION_PLACEMENT_BY_ID.get(spec.id);
  if (!placement) {
    throw new Error(`Action execution placement missing for: ${spec.id}`);
  }
  return placement;
}

/** Invoke only with schema-admitted input; the spec remains the sole placement owner. */
export function resolveActionExecutionPlacementForInput(
  spec: Pick<ActionSpec, 'executionPlacement' | 'executionPlacementForInput'>,
  input: unknown,
): ActionExecutionPlacement {
  return spec.executionPlacementForInput?.(input) ?? spec.executionPlacement;
}

function normalizeActionPublicExposure(spec: PreNormalizedActionSpec): NormalizedActionSpec {
  const isInternal = isInternalActionId(spec.id);
  const isPluginProvenanceOnly = isPluginProvenanceOnlyActionId(spec.id);
  const isHumanSecretApiExcluded = isHumanSecretApiExcludedActionId(spec.id);
  const isPluginSurfaceExcluded = isPluginSurfaceExcludedActionId(spec.id);
  const executionPlacement = resolveActionExecutionPlacement(spec);
  const requiredAuthority = resolveActionRequiredAuthority(spec);
  const canExposeCli = executionPlacement !== 'client' || spec.cli !== undefined;
  // Automation proposes human-owned effects through the ordinary approval owner.
  const presentUserRequestable = !isInternal
    && !Object.hasOwn(AGENT_ACTION_EXCLUSION_REASONS, spec.id)
    && canRequestPresentUserApprovalForActionInputV1({
      id: spec.id, requiredAuthority, approvalInputCustody: spec.approvalInputCustody,
    });
  return {
    ...spec,
    requiredAuthority,
    executionPlacement,
    cli: canExposeCli ? spec.cli : undefined,
    surfaces: {
      ...spec.surfaces,
      // Explicit client commands use the mounted answering-owner transport;
      // undeclared client-owned Actions remain unavailable as CLI commands.
      cli: canExposeCli && spec.surfaces.cli,
      mcp: spec.surfaces.mcp || presentUserRequestable
        || spec.id === 'account.apiTokens.list' || spec.id === 'account.security.get',
      agent: spec.surfaces.agent || presentUserRequestable
        || spec.id === 'account.apiTokens.list' || spec.id === 'account.security.get',
      api: spec.surfaces.api !== false && !isInternal
        && !isPluginProvenanceOnly
        && !isHumanSecretApiExcluded
        && (requiredAuthority === 'account_automation'
          || (DECISION_ACTION_IDS as readonly string[]).includes(spec.id)
          || (TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS as readonly string[]).includes(spec.id)),
      plugin: !isPluginSurfaceExcluded,
    },
  };
}

const ACTION_SPECS_WITH_PUBLIC_EXPOSURE = Object.freeze(
  ACTION_SPECS_WITHOUT_APPROVAL.map(normalizeActionPublicExposure),
);

/**
 * The generated-family builders above return a broad registry row at runtime.
 * Keep their concrete Zod carriers in this one type-only projection so the
 * public API and Plugin maps remain derived from the same Action ids instead
 * of retaining a second, surface-specific allowlist. Array map cannot retain
 * the correlation between a runtime/generated family id and its indexed schema
 * after the value registry is assembled; changing every builder to a
 * tuple-aware generic would duplicate that machinery across eight existing
 * family owners. This projection therefore reads only their existing schema
 * maps and is checked by the explicit pluginActionDtoCorrespondence gate for
 * exact registry-id and per-row runtime-schema equality. It never decides an Action's runtime behavior, exposure,
 * authority, placement, or policy.
 */
type CanonicalActionSchemaDefinition<
  TActionId extends ActionId,
  TInputSchema extends z.ZodMiniType,
  TOutputSchema extends z.ZodMiniType,
  TSurfaceBindings = never,
  TRequiredAuthority extends ActionRequiredAuthority = TActionId extends PresentUserRequiredActionId
    ? 'present_user'
    : 'account_automation',
> = Readonly<{
  id: TActionId;
  approval: ParsedActionSpec['approval'];
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  surfaceBindings?: TSurfaceBindings;
  requiredAuthority: TRequiredAuthority;
}>;

type LiteralActionSpecDefinition<TSpec> = TSpec extends Readonly<{
  id: infer TActionId;
}>
  ? ActionId extends TActionId
    ? never
    : TSpec
  : never;

// Filter each tuple row before forming its union: widened factory rows would
// otherwise absorb the concrete rows and erase their exact schema carriers.
type LiteralActionSpecTupleDefinition<TSpecs extends readonly PreNormalizedActionSpec[]> = {
  [K in keyof TSpecs]: LiteralActionSpecDefinition<TSpecs[K]>;
}[number];

type DirectActionSpecDefinition =
  | LiteralActionSpecTupleDefinition<typeof CODE_INTELLIGENCE_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof CLIPBOARD_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof SESSION_ORGANIZATION_MOVE_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof LIST_REORDER_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof TODO_SESSION_LINK_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof INTERNAL_TASK_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof APP_SHELL_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof HOME_HUB_LAYOUT_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof PROJECT_SOURCE_ACTION_SPECS_V1>
  | LiteralActionSpecTupleDefinition<typeof WIDGET_SNAPSHOT_ACTION_SPECS_V1>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_OPENING>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD_MIDDLE>
  | LiteralActionSpecTupleDefinition<typeof CAPTURE_VIEW_ACTION_SPECS>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_LEAD>
  | LiteralActionSpecDefinition<(typeof ACTION_SPECS_WITHOUT_APPROVAL_FAMILIES)[number]>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_OPENING>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_MIDDLE>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_PREFIX_REMAINDER>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_OPENING>
  | LiteralActionSpecTupleDefinition<typeof DISCUSSION_ACTION_SPECS_V1>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX_CONTINUATION>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_SESSION_SUFFIX>
  | LiteralActionSpecTupleDefinition<typeof ACTION_SPECS_WITHOUT_APPROVAL_SUFFIX>;

type SessionPendingCustodyActionSpecDefinition =
  | CanonicalActionSchemaDefinition<
      'session.pending.action.set',
      typeof SessionPendingActionSetInputV1Schema,
      typeof SessionPendingActionSetResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.markHandled',
      typeof SessionPendingMarkHandledInputV1Schema,
      typeof SessionPendingDeliveryRecoveryResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.dismiss',
      typeof SessionPendingDeliveryRecoveryInputV1Schema,
      typeof SessionPendingDeliveryRecoveryResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.sendAsNew',
      typeof SessionPendingDeliveryRecoveryInputV1Schema,
      typeof SessionPendingSendAsNewResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.withdraw',
      typeof SessionPendingWithdrawInputV1Schema,
      typeof SessionPendingWithdrawResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.resetStart.set',
      typeof PendingResetStartSetInputV1Schema,
      typeof PendingResetStartSetResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'session.pending.resetStart.cancel',
      typeof PendingResetStartCancelInputV1Schema,
      typeof PendingResetStartCancelResultV1Schema
    >;

type NonRuntimeActionSpecDefinition<TSpec> = TSpec extends Readonly<{
  id: infer TActionId;
}>
  // These families have exact per-ID schema definitions below. Their generic
  // row factories must not reintroduce widened schema unions into the catalog.
  ? TActionId extends RuntimeActionIdV1 | SessionTerminalActionId | SessionAgentTransitionActionId | MachineTerminalActionId | WorkspaceActionId | ProjectDefinitionActionId
    | WidgetInstanceActionIdV1 | WidgetDefinitionActionIdV1 | WidgetLayoutFragmentActionIdV1
    | ArtifactFolderActionIdV1 | ProfileActionIdV1 | ProviderActionIdV1 | RemoteHostActionIdV1 | HomeRuntimeActionIdV1 | ProjectActionIdV1 | WorkflowEffectActionIdV1 | UsageSourceActionId
    ? never
    : TSpec
  : never;

type NonRuntimeDirectActionSpecDefinition = NonRuntimeActionSpecDefinition<
  DirectActionSpecDefinition
>;

type RuntimeActionSpecDefinition = {
  [TActionId in RuntimeActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof RUNTIME_ACTION_INPUT_SCHEMAS)[TActionId],
    (typeof RUNTIME_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}[RuntimeActionIdV1];

type PluginDevLoopActionSpecDefinition = {
  [TActionId in PluginDevLoopActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginDevLoopActionInputSchemas)[TActionId],
    typeof PluginDevLoopActionOutputSchema
  > & (TActionId extends 'plugins.install'
    ? Readonly<{ surfaces: Readonly<{ api: false }> }> : unknown);
}[PluginDevLoopActionIdV1];

type PluginSettingsAdministrationActionSpecDefinition = {
  [TActionId in PluginSettingsAdministrationActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginSettingsAdministrationActionInputSchemasV1)[TActionId],
    typeof PluginSettingsAdministrationActionOutputV1Schema
  > & (TActionId extends `plugins.settings.secret.${'bind' | 'unbind' | 'delete'}`
    ? Readonly<{ surfaces: Readonly<{ api: false }> }> : unknown);
}[PluginSettingsAdministrationActionIdV1];

type PluginPermissionGrantPluginBoundActionId = keyof typeof PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS;
type PluginPermissionGrantPluginBoundActionSpecDefinition = {
  [TActionId in PluginPermissionGrantPluginBoundActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginPermissionGrantActionInputSchemasV1)[TActionId],
    (typeof PluginPermissionGrantActionOutputSchemasV1)[TActionId],
    Readonly<{
      plugin: Readonly<{
        inputSchema: (typeof PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS)[TActionId];
      }>;
    }>
  >;
}[PluginPermissionGrantPluginBoundActionId];
type PluginPermissionGrantUnboundActionId = Exclude<
  PluginPermissionGrantActionIdV1,
  PluginPermissionGrantPluginBoundActionId
>;
type PluginPermissionGrantUnboundActionSpecDefinition = {
  [TActionId in PluginPermissionGrantUnboundActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginPermissionGrantActionInputSchemasV1)[TActionId],
    (typeof PluginPermissionGrantActionOutputSchemasV1)[TActionId]
  >;
}[PluginPermissionGrantUnboundActionId];
type PluginPermissionGrantActionSpecDefinition =
  | PluginPermissionGrantPluginBoundActionSpecDefinition
  | PluginPermissionGrantUnboundActionSpecDefinition;

type PluginReviewCommentActionSpecDefinition = {
  [TActionId in ReviewCommentActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ReviewCommentActionInputSchemasV1)[TActionId],
    (typeof ReviewCommentActionOutputSchemasV1)[TActionId]
  >;
}[ReviewCommentActionIdV1];

type PluginWebhookActionSpecDefinition = {
  [TActionId in PluginWebhookActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof PluginWebhookActionInputSchemasV1)[TActionId],
    (typeof PluginWebhookActionOutputSchemasV1)[TActionId]
  >;
}[PluginWebhookActionIdV1];

type PluginAutomationEventActionSpecDefinition = {
  [TActionId in AutomationEventActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof AutomationEventActionInputSchemasV1)[TActionId],
    (typeof AutomationEventActionOutputSchemasV1)[TActionId]
  >;
}[AutomationEventActionIdV1];

type PluginAutomationConversationActionSpecDefinition = {
  [TActionId in AutomationConversationActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof AutomationConversationActionInputSchemasV1)[TActionId],
    (typeof AutomationConversationActionOutputSchemasV1)[TActionId]
  >;
}[AutomationConversationActionIdV1];

type MachinePoolActionSpecDefinition = {
  [TActionId in MachinePoolActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof MachinePoolActionInputSchemasV1)[TActionId],
    (typeof MachinePoolActionOutputSchemasV1)[TActionId]
  >;
}[MachinePoolActionIdV1];

type MachinePresetActionSpecDefinition = {
  [Id in MachinePresetActionIdV1]: CanonicalActionSchemaDefinition<Id,
    (typeof MachinePresetActionInputSchemasV1)[Id], (typeof MachinePresetActionOutputSchemasV1)[Id]>;
}[MachinePresetActionIdV1];

type ManagedMachineActionSpecDefinition = {
  [TActionId in ManagedMachineActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ManagedMachineActionInputSchemasV1)[TActionId],
    (typeof ManagedMachineActionOutputSchemasV1)[TActionId]
  >;
}[ManagedMachineActionIdV1];

type ProjectWorkerActionSpecDefinition = {
  [TActionId in ProjectWorkerActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ProjectWorkerActionInputSchemasV1)[TActionId],
    (typeof ProjectWorkerActionOutputSchemasV1)[TActionId]
  >;
}[ProjectWorkerActionIdV1];

type ActionOperationActionSpecDefinition = {
  [TActionId in ActionOperationActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ActionOperationActionInputSchemasV1)[TActionId],
    (typeof ActionOperationActionOutputSchemasV1)[TActionId]
  >;
}[ActionOperationActionIdV1];

type EphemeralRunnerActionSpecDefinition = {
  [TActionId in EphemeralRunnerActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof EphemeralRunnerActionInputSchemasV1)[TActionId],
    (typeof EphemeralRunnerActionOutputSchemasV1)[TActionId]
  >;
}[EphemeralRunnerActionIdV1];

type WorkBoardActionSpecDefinition = {
  [TActionId in WorkBoardActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof WorkBoardActionInputSchemasV1)[TActionId],
    (typeof WorkBoardActionOutputSchemasV1)[TActionId]
  >;
}[WorkBoardActionIdV1];

type RoleActionSpecDefinition = {
  [TActionId in RoleActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof RoleActionInputSchemasV1)[TActionId],
    (typeof RoleActionOutputSchemasV1)[TActionId]
  >;
}[RoleActionIdV1];

type ArtifactAccessActionSpecDefinition = {
  [TActionId in ArtifactAccessActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ArtifactAccessActionInputSchemasV1)[TActionId],
    (typeof ArtifactAccessActionOutputSchemasV1)[TActionId],
    never,
    (typeof ARTIFACT_ACCESS_ACTION_SPECS)[number]['requiredAuthority']
  >;
}[ArtifactAccessActionIdV1];

type ArtifactActionSpecDefinition = {
  [TActionId in ArtifactActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof ArtifactActionInputSchemasV1)[TActionId],
    (typeof ArtifactActionOutputSchemasV1)[TActionId],
    never,
    (typeof ARTIFACT_ACTION_SPECS)[number]['requiredAuthority']
  >;
}[ArtifactActionIdV1];

type SettingsDeclarationActionSpecDefinition = {
  [TActionId in SettingsDeclarationActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof SettingsDeclarationActionInputSchemasV1)[TActionId],
    (typeof SettingsDeclarationActionOutputSchemasV1)[TActionId]
  >;
}[SettingsDeclarationActionIdV1];

type ActionPolicyActionSpecDefinition = {
  [Id in ActionPolicyActionId]: CanonicalActionSchemaDefinition<Id,
    (typeof ActionPolicyInputSchemas)[Id], (typeof ActionPolicyOutputSchemas)[Id], never,
    Id extends 'actions.policy.get' ? 'account_automation' : 'present_user'>;
}[ActionPolicyActionId];

type WorkspaceActionSpecDefinition = {
  [TActionId in WorkspaceActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof WORKSPACE_ACTION_INPUT_SCHEMAS)[TActionId],
    (typeof WORKSPACE_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}[WorkspaceActionId];

type ProjectDefinitionActionSpecDefinition = {
  [Id in ProjectDefinitionActionId]: CanonicalActionSchemaDefinition<Id,
    (typeof PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS)[Id], (typeof PROJECT_DEFINITION_ACTION_OUTPUT_SCHEMAS)[Id]>;
}[ProjectDefinitionActionId];

type WidgetInstanceActionSpecDefinition = {
  [TActionId in WidgetInstanceActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof WidgetInstanceActionInputSchemasV1)[TActionId],
    (typeof WidgetInstanceActionOutputSchemasV1)[TActionId],
    never,
    (typeof WIDGET_INSTANCE_ACTION_SPECS_V1)[number]['requiredAuthority']
  >;
}[WidgetInstanceActionIdV1];

type WidgetDefinitionActionSpecDefinition = {
  [TActionId in WidgetDefinitionActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof WidgetDefinitionActionInputSchemasV1)[TActionId],
    (typeof WidgetDefinitionActionOutputSchemasV1)[TActionId],
    never,
    (typeof WIDGET_DEFINITION_ACTION_SPECS_V1)[number]['requiredAuthority']
  >;
}[WidgetDefinitionActionIdV1];

type WidgetLayoutFragmentActionSpecDefinition = {
  [Id in WidgetLayoutFragmentActionIdV1]: CanonicalActionSchemaDefinition<Id,
    (typeof WidgetLayoutFragmentActionInputSchemasV1)[Id], (typeof WidgetLayoutFragmentActionOutputSchemasV1)[Id],
    never, (typeof WIDGET_LAYOUT_FRAGMENT_ACTION_SPECS_V1)[number]['requiredAuthority']>;
}[WidgetLayoutFragmentActionIdV1];

type SessionTerminalActionSpecDefinition = {
  [TActionId in SessionTerminalActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof SESSION_TERMINAL_ACTION_INPUT_SCHEMAS)[TActionId],
    (typeof SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}[SessionTerminalActionId];

type MachineTerminalActionSpecDefinition = {
  [TActionId in MachineTerminalActionId]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS)[TActionId],
    (typeof MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS)[TActionId]
  >;
}[MachineTerminalActionId];

type ScmGitActionSpecDefinition = (typeof SCM_GIT_ACTION_SPECS)[number];

type WorkflowActionSpecDefinition = {
  [TActionId in WorkflowActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof WorkflowActionInputSchemasV1)[TActionId],
    (typeof WorkflowActionOutputSchemasV1)[TActionId],
    never,
    TActionId extends 'workflow.run.invocations.complete_review' ? 'present_user' : 'account_automation'
  >;
}[WorkflowActionIdV1];

type TeamCredentialActionSpecDefinition = {
  [TActionId in TeamCredentialActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1)[TActionId],
    (typeof TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1)[TActionId],
    never,
    TActionId extends 'teams.credentials.test' ? 'present_user' : 'account_automation'
  >;
}[TeamCredentialActionIdV1];

type SharedSavedSecretActionSpecDefinition = {
  [TActionId in SharedSavedSecretActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1)[TActionId],
    (typeof SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
  >;
}[SharedSavedSecretActionIdV1];

type ManagedGitHubAppActionSpecDefinition = {
  [TActionId in ManagedGitHubAppActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1)[TActionId],
    (typeof MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1)[TActionId],
    never,
    TActionId extends 'identity.githubApps.list' ? 'account_automation' : 'present_user'
  >;
}[ManagedGitHubAppActionIdV1];

type ManagedIdentityProviderActionSpecDefinition = {
  [TActionId in ManagedIdentityProviderActionIdV1]: CanonicalActionSchemaDefinition<
    TActionId,
    (typeof MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1)[TActionId],
    (typeof MANAGED_IDENTITY_PROVIDER_ACTION_OUTPUT_SCHEMAS_V1)[TActionId],
    never,
    ManagedIdentityProviderRequiredAuthority<TActionId>
  >;
}[ManagedIdentityProviderActionIdV1];

/**
 * Account Security rows are authored together above, but their shared map
 * deliberately widens to `PreNormalizedActionSpec` while it attaches the
 * common surface metadata. Keep the public/plugin author maps exact by
 * projecting their wire schemas here rather than letting that implementation
 * detail degrade their inputs and results to `unknown`.
 */
type AccountSecurityActionSpecDefinition =
  | CanonicalActionSchemaDefinition<
      'account.plugins.data.erase',
      typeof PluginAccountDataEraseActionInputV1Schema,
      typeof PluginAccountDataEraseActionOutputV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.sessions.signOutEverywhere',
      typeof AccountSessionsSignOutEverywhereActionInputV1Schema,
      typeof AccountSessionsSignOutEverywhereActionOutputV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.encryption.automationTemplates.recover',
      typeof AccountEncryptionAutomationTemplatesRecoverInputV1Schema,
      typeof AccountEncryptionAutomationTemplatesRecoverResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.encryption.historicalKey.forget',
      typeof AccountHistoricalEncryptionKeyForgetInputV1Schema,
      typeof AccountHistoricalEncryptionKeyForgetResultV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.security.terminalPresentUser.set',
      typeof AccountTerminalPresentUserPolicySetRequestV1Schema,
      typeof AccountTerminalPresentUserPolicySetResponseV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.security.get',
      typeof AccountSecurityGetRequestV1Schema,
      typeof AccountSecurityGetResponseV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.password.enroll',
      typeof AccountPasswordEnrollRequestV1Schema,
      typeof AccountPasswordMutationResponseV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.password.change',
      typeof AccountPasswordChangeRequestV1Schema,
      typeof AccountPasswordMutationResponseV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.password.remove',
      typeof AccountPasswordRemoveRequestV1Schema,
      typeof AccountPasswordMutationResponseV1Schema
    >
  | CanonicalActionSchemaDefinition<
      'account.email.change.request',
      typeof AccountEmailChangeRequestV1Schema,
      typeof AccountEmailChangeRequestResponseV1Schema
    >;

export type CanonicalActionSpecDefinition =
  | (typeof DOC_COLLABORATION_ACTION_SPECS_V1)[number]
  | (typeof CAPABILITY_RULES_ACTION_SPECS_V1)[number]
  | (typeof SESSION_CAPABILITIES_ACTION_SPECS_V1)[number]
  | (typeof SKILL_ACTION_SPECS_V1)[number]
  | (typeof ACCOUNT_LIFECYCLE_ACTION_SPECS)[number]
  | (typeof MEMORY_DOCUMENT_ACTION_SPECS_V1)[number]
  | { [Id in PluginExecutionOriginActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof PluginExecutionOriginActionInputSchemas)[Id], (typeof PluginExecutionOriginActionOutputSchemas)[Id], never, 'account_automation'>
    }[PluginExecutionOriginActionId]
  | { [Id in NpmRegistryProfileActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof NpmRegistryProfileActionInputSchemasV1)[Id], (typeof NpmRegistryProfileActionOutputSchemasV1)[Id], never, 'account_automation'>
    }[NpmRegistryProfileActionIdV1]
  | { [Id in PluginAccountAdministrationActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof PluginAccountAdministrationActionInputSchemas)[Id], (typeof PluginAccountAdministrationActionOutputSchemas)[Id], never, 'account_automation'>
    }[PluginAccountAdministrationActionId]
  | { [Id in HomeRuntimeActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[HomeRuntimeActionIdV1]
  | (typeof USAGE_ACTION_SPECS)[number]
  | (typeof USAGE_COACH_ACTION_SPECS)[number]
  | { [Id in UsageSourceActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof USAGE_SOURCE_ACTION_INPUT_SCHEMAS)[Id],
      (typeof USAGE_SOURCE_ACTION_OUTPUT_SCHEMAS)[Id]> }[UsageSourceActionId]
  | { [Id in McpServerActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof MCP_SERVER_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[McpServerActionIdV1]
  | { [Id in RemoteHostActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[RemoteHostActionIdV1]
  | { [Id in ArtifactFolderActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[ArtifactFolderActionIdV1]
  | { [Id in ProfileActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof PROFILE_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof PROFILE_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[ProfileActionIdV1]
  | { [Id in ProviderActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof PROVIDER_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof PROVIDER_ACTION_OUTPUT_SCHEMAS_V1)[Id], never, 'account_automation'>
    }[ProviderActionIdV1]
  | { [Id in ProjectActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof PROJECT_ACTION_INPUT_SCHEMAS_V1)[Id], (typeof PROJECT_ACTION_OUTPUT_SCHEMAS_V1)[Id]>
    }[ProjectActionIdV1]
  | { [Id in WorkflowEffectActionIdV1]: CanonicalActionSchemaDefinition<Id,
      (typeof WorkflowEffectActionInputSchemasV1)[Id], (typeof WorkflowEffectActionOutputSchemasV1)[Id]>
    }[WorkflowEffectActionIdV1]
  | { [Id in VoiceConversationActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof VoiceConversationActionInputSchemas)[Id], (typeof VoiceConversationActionOutputSchemas)[Id]>
    }[VoiceConversationActionId]
  | (typeof COMPOSER_INGRESS_ACTION_SPECS)[number]
  | (typeof WORKFLOW_AUTHORING_ACTION_SPECS)[number]
  | (typeof WORKFLOW_DIAGNOSTIC_ACTION_SPECS)[number]
  | { [Id in NotificationConfigurationActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof NotificationConfigurationActionInputSchemas)[Id], (typeof NotificationConfigurationActionOutputSchemas)[Id]>
    }[NotificationConfigurationActionId]
  | { [Id in AppUpdateActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof AppUpdateActionInputSchemas)[Id], (typeof AppUpdateActionOutputSchemas)[Id]>
    }[AppUpdateActionId]
  | { [Id in UpdatesActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof UpdatesActionInputSchemas)[Id], (typeof UpdatesActionOutputSchemas)[Id]>
    }[UpdatesActionId]
  | SessionTerminalActionSpecDefinition
  | { [Id in SessionAgentTransitionActionId]: CanonicalActionSchemaDefinition<Id,
      (typeof SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS)[Id], (typeof SESSION_AGENT_TRANSITION_ACTION_OUTPUT_SCHEMAS)[Id]>
    }[SessionAgentTransitionActionId]
  | MachineTerminalActionSpecDefinition
  | WorkspaceActionSpecDefinition
  | ProjectDefinitionActionSpecDefinition
  | WidgetInstanceActionSpecDefinition
  | WidgetDefinitionActionSpecDefinition
  | WidgetLayoutFragmentActionSpecDefinition
  | (typeof SCOPE_ACTION_SPECS)[number]
  | (typeof DIAGNOSTICS_ACTION_SPECS)[number]
  | (typeof COMMAND_PALETTE_ACTION_SPECS)[number]
  | (typeof FIND_ACTION_SPECS)[number]
  | (typeof PROMPT_PICKER_ACTION_SPECS)[number]
  | (typeof PROMPT_INVOCATION_CREATE_ACTION_SPECS)[number]
  | (typeof SESSION_PENDING_NEXT_ACTION_SPECS)[number]
  | SessionPendingCustodyActionSpecDefinition
  | SettingsDeclarationActionSpecDefinition
  | ActionPolicyActionSpecDefinition
  | WorkBoardActionSpecDefinition
  | ArtifactAccessActionSpecDefinition
  | ArtifactActionSpecDefinition
  | RoleActionSpecDefinition
  | ScmGitActionSpecDefinition
  | NonRuntimeDirectActionSpecDefinition
  | RuntimeActionSpecDefinition
  | PluginDevLoopActionSpecDefinition
  | PluginSettingsAdministrationActionSpecDefinition
  | PluginPermissionGrantActionSpecDefinition
  | PluginReviewCommentActionSpecDefinition
  | PluginWebhookActionSpecDefinition
  | PluginAutomationEventActionSpecDefinition
  | PluginAutomationConversationActionSpecDefinition
  | MachinePoolActionSpecDefinition
  | MachinePresetActionSpecDefinition
  | ManagedMachineActionSpecDefinition
  | ProjectWorkerActionSpecDefinition
  | ActionOperationActionSpecDefinition
  | EphemeralRunnerActionSpecDefinition
  | WorkflowActionSpecDefinition
  | TeamCredentialActionSpecDefinition
  | SharedSavedSecretActionSpecDefinition
  | ManagedGitHubAppActionSpecDefinition
  | ManagedIdentityProviderActionSpecDefinition
  | AccountSecurityActionSpecDefinition;

// Index the family union once instead of distributing Extract over the whole
// catalog again for every input, result and surface projection.
type CanonicalActionSpecBucketsById = {
  [TSpec in CanonicalActionSpecDefinition as TSpec['id']]: TSpec;
};
type CanonicalActionSpecById = {
  [TActionId in keyof CanonicalActionSpecBucketsById]: Extract<
    CanonicalActionSpecBucketsById[TActionId],
    Readonly<{ id: TActionId }>
  >;
};

type ResultRequiredActionId = {
  // Schema-only family projections widen approval; check every potentially required result.
  [Id in keyof CanonicalActionSpecBucketsById]: 'required' extends CanonicalActionSpecBucketsById[Id]['approval']['result'] ? Id : never;
}[keyof CanonicalActionSpecBucketsById];
type ResultRequiredActionsWithoutSchema = {
  [TActionId in ResultRequiredActionId]: CanonicalActionSpecBucketsById[TActionId] extends Readonly<{
    outputSchema: z.ZodMiniType;
  }> ? never : TActionId;
}[ResultRequiredActionId];
type ResultRequiredActionsMustHaveSchema = AssertNever<ResultRequiredActionsWithoutSchema>;

type ResolveCanonicalActionRequiredAuthority<TSpec> = TSpec extends Readonly<{
  requiredAuthority: infer TRequiredAuthority extends ActionRequiredAuthority;
}>
  ? TRequiredAuthority
  : TSpec extends Readonly<{ id: infer TActionId extends ActionId }>
    ? TActionId extends PresentUserRequiredActionId
      ? 'present_user'
      : 'account_automation'
    : never;

type AccountAutomationActionId = CanonicalActionSpecDefinition extends infer TSpec
  ? TSpec extends Readonly<{ id: infer TActionId extends ActionId }>
    ? ResolveCanonicalActionRequiredAuthority<TSpec> extends 'account_automation'
      ? TActionId
      : never
    : never
  : never;

type DeclaredApiExcludedActionId = {
  [Id in keyof CanonicalActionSpecBucketsById]: CanonicalActionSpecBucketsById[Id] extends Readonly<{
    surfaces: Readonly<{ api: false }>;
  }> ? Id : never;
}[keyof CanonicalActionSpecBucketsById];

export type PublicActionId = Exclude<Extract<SignedRootActionId,
  AccountAutomationActionId | typeof DECISION_ACTION_IDS[number] | typeof TOKEN_CONVERSATIONAL_INPUT_ACTION_IDS[number]>,
  PluginProvenanceOnlyActionId | DeclaredApiExcludedActionId>;

export type PluginInvocableActionSpecDefinition = Extract<
  CanonicalActionSpecBucketsById[PluginInvocableActionId],
  Readonly<{ id: PluginInvocableActionId }>
>;

/**
 * Public Action descriptor shape narrowed to the exact trusted-Plugin Action
 * census. Build this from the explicit descriptor contract rather than the
 * passthrough Zod inference: the latter carries a string index signature, and
 * applying `Omit` to it erases the useful property types to `unknown`.
 * Host surface transforms, execution routing, and caller-authority policy are
 * deliberately absent: authors consume the normalized descriptor and invoke
 * Actions through the service rather than participating in host dispatch.
 */
export type PluginInvocableActionSpec = Readonly<{
  id: PluginInvocableActionId;
  title: ParsedActionSpec['title'];
  confirmVerb?: ParsedActionSpec['confirmVerb'];
  irreversible?: ParsedActionSpec['irreversible'];
  description?: ParsedActionSpec['description'];
  safety: ParsedActionSpec['safety'];
  approval: ParsedActionSpec['approval'];
  placements: ActionUiPlacement[];
  slash?: ParsedActionSpec['slash'];
  bindings?: ParsedActionSpec['bindings'];
  outputSchema?: ParsedActionSpec['outputSchema'];
  sideEffectClass?: ParsedActionSpec['sideEffectClass'];
  examples?: ParsedActionSpec['examples'];
  prompting?: ParsedActionSpec['prompting'];
  toolExposure?: ParsedActionSpec['toolExposure'];
  contextualDefaults?: ParsedActionSpec['contextualDefaults'];
  sessionTarget?: ParsedActionSpec['sessionTarget'];
  operation?: ParsedActionSpec['operation'];
  requiredAuthority: ActionRequiredAuthority;
  executionPlacement: ActionExecutionPlacement;
  surfaces: ParsedActionSpec['surfaces'];
  inputSchema: ParsedActionSpec['inputSchema'];
  inputHints?: ParsedActionSpec['inputHints'];
}>;

type PluginActionSpecForId<TActionId extends PluginInvocableActionId> = CanonicalActionSpecById[TActionId];

// Preserve each row's exact input/output while dynamic catalog lookups consume
// the parser interface, not a union of hundreds of Zod implementation classes.
type ActionSchemaCarriersById<TSchemas> = Readonly<{
  [TActionId in keyof TSchemas]: z.ZodMiniType<z.output<TSchemas[TActionId]>, z.input<TSchemas[TActionId]>>;
}>;

export type PluginActionInputById = Readonly<{
  [TActionId in PluginInvocableActionId]: z.input<PluginActionInputSchemaById[TActionId]>;
}>;

export type PluginActionResultById = Readonly<{
  [TActionId in PluginInvocableActionId]: z.output<PluginActionOutputSchemaById[TActionId]>;
}>;

type PluginActionInputSchemaById = Readonly<{
  [TActionId in PluginInvocableActionId]: TActionId extends TeamCredentialActionIdV1
    ? (typeof TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends SharedSavedSecretActionIdV1
      ? (typeof SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : PluginActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ plugin: Readonly<{ inputSchema: infer TInputSchema extends z.ZodMiniType }> }>;
  }>
    ? TInputSchema
    : PluginActionSpecForId<TActionId>['inputSchema'];
}>;

type PluginActionOutputSchemaById = Readonly<{
  [TActionId in PluginInvocableActionId]: TActionId extends TeamCredentialActionIdV1
    ? (typeof TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends SharedSavedSecretActionIdV1
      ? (typeof SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : PluginActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ plugin: Readonly<{ outputSchema: infer TOutputSchema extends z.ZodMiniType }> }>;
  }>
    ? TOutputSchema
    : PluginActionSpecForId<TActionId> extends Readonly<{
      outputSchema: infer TOutputSchema extends z.ZodMiniType;
    }>
      ? TOutputSchema
      : never;
}>;

// Catalog/type correspondence is checked by pluginActionDtoCorrespondence.ts,
// outside prerequisite compilation. Keep the runtime schema carriers exact here.
type AssertTrue<T extends true> = T;
type IsTypeEqual<TLeft, TRight> = (
  <T>() => T extends TLeft ? 1 : 2
) extends (
  <T>() => T extends TRight ? 1 : 2
) ? true : false;
// This single-row binding references private admission schemas and does not
// instantiate the catalog-wide maps. The full correspondence gate checks all rows.
type PluginSessionMessageInputMustRemainAdmissionOnly = AssertTrue<IsTypeEqual<
  PluginActionInputById['session.message.send'],
  z.input<typeof SessionSendMessagePluginInputV1Schema>
>>;

const PLUGIN_INVOCABLE_ACTION_SPECS = ACTION_SPECS_WITH_PUBLIC_EXPOSURE.filter(
  (spec): spec is ActionSpecWithoutApproval & Readonly<{
    surfaces: ActionSpecWithoutApproval['surfaces'] & Readonly<{ plugin: true }>;
    outputSchema: z.ZodMiniType;
  }> => (
    spec.surfaces.plugin === true && spec.outputSchema !== undefined
  ),
);

function projectPluginActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): ActionSchemaCarriersById<PluginActionInputSchemaById>;
function projectPluginActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): object {
  return Object.freeze(Object.fromEntries(
    specs.map((spec) => {
    const surfaceBindings = 'surfaceBindings' in spec
      ? spec.surfaceBindings
      : undefined;
    const pluginBinding = surfaceBindings && 'plugin' in surfaceBindings
      ? surfaceBindings.plugin
      : undefined;
    return [spec.id, pluginBinding?.inputSchema ?? spec.inputSchema];
    }),
  ));
}

function projectPluginActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): ActionSchemaCarriersById<PluginActionOutputSchemaById>;
function projectPluginActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): object {
  return Object.freeze(Object.fromEntries(
    specs.map((spec) => {
      const surfaceBindings = 'surfaceBindings' in spec
        ? spec.surfaceBindings
        : undefined;
      const pluginBinding = surfaceBindings && 'plugin' in surfaceBindings
        ? surfaceBindings.plugin
        : undefined;
      const pluginOutputSchema = pluginBinding && 'outputSchema' in pluginBinding
        ? pluginBinding.outputSchema
        : undefined;
      return [spec.id, pluginOutputSchema ?? spec.outputSchema];
    }),
  ));
}

export const PLUGIN_ACTION_INPUT_SCHEMAS: ActionSchemaCarriersById<PluginActionInputSchemaById> = projectPluginActionInputSchemas(
  PLUGIN_INVOCABLE_ACTION_SPECS,
);

export const PLUGIN_ACTION_OUTPUT_SCHEMAS: ActionSchemaCarriersById<PluginActionOutputSchemaById> = projectPluginActionOutputSchemas(
  PLUGIN_INVOCABLE_ACTION_SPECS,
);

/**
 * The authenticated public API is the API-surface projection of the same
 * canonical rows. It excludes host-internal and plugin-provenance-only Actions,
 * rather than maintaining a second allowlist; execution placement is resolved
 * when an admitted Action runs.
 */
export type PublicActionSpecDefinition = Extract<
  CanonicalActionSpecBucketsById[PublicActionId],
  Readonly<{ id: PublicActionId }>
>;

type PublicActionSpecForId<TActionId extends PublicActionId> = CanonicalActionSpecById[TActionId];

export type PublicActionInputById = Readonly<{
  [TActionId in PublicActionId]: z.input<PublicActionInputSchemaById[TActionId]>;
}>;

export type PublicActionResultById = Readonly<{
  [TActionId in PublicActionId]: z.output<PublicActionOutputSchemaById[TActionId]>;
}>;

type PublicActionInputSchemaById = Readonly<{
  [TActionId in PublicActionId]: TActionId extends TeamCredentialActionIdV1
    ? (typeof TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends SharedSavedSecretActionIdV1
      ? (typeof SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ProfileActionIdV1
      ? (typeof PROFILE_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends McpServerActionIdV1
      ? (typeof MCP_SERVER_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ProviderActionIdV1
      ? (typeof PROVIDER_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends RemoteHostActionIdV1
      ? (typeof REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends HomeRuntimeActionIdV1
      ? (typeof HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ArtifactFolderActionIdV1
      ? (typeof ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    : PublicActionSpecForId<TActionId> extends Readonly<{
    surfaceBindings: Readonly<{ api: Readonly<{ inputSchema: infer TInputSchema extends z.ZodMiniType }> }>;
  }>
    ? TInputSchema
    : PublicActionSpecForId<TActionId>['inputSchema'];
}>;

type PublicActionOutputSchemaById = Readonly<{
  [TActionId in PublicActionId]: TActionId extends TeamCredentialActionIdV1
    ? (typeof TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends SharedSavedSecretActionIdV1
      ? (typeof SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ProfileActionIdV1
      ? (typeof PROFILE_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends McpServerActionIdV1
      ? (typeof MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ProviderActionIdV1
      ? (typeof PROVIDER_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends RemoteHostActionIdV1
      ? (typeof REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends HomeRuntimeActionIdV1
      ? (typeof HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : TActionId extends ArtifactFolderActionIdV1
      ? (typeof ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    : PublicActionSpecForId<TActionId> extends Readonly<{
      surfaceBindings: Readonly<{ api: Readonly<{ outputSchema: infer TOutputSchema extends z.ZodMiniType }> }>;
    }>
      ? TOutputSchema
      : PublicActionSpecForId<TActionId>['outputSchema'];
}>;

function isSignedRootActionSpec(
  spec: ActionSpecWithoutApproval,
): spec is ActionSpecWithoutApproval & Readonly<{ outputSchema: z.ZodMiniType }> {
  return !isInternalActionId(spec.id)
    && !isHumanSecretApiExcludedActionId(spec.id)
    && spec.outputSchema !== undefined;
}

const SIGNED_ROOT_ACTION_SPECS = ACTION_SPECS_WITH_PUBLIC_EXPOSURE.filter(isSignedRootActionSpec);

/**
 * Signed Account roots retain present-user Actions and plugin-provenance-only
 * shapes. The latter require a mounted claim at ingress and daemon-derived
 * plugin policy; they remain excluded from the PAT catalog.
 */
export const SIGNED_ROOT_ACTION_IDS = Object.freeze(
  SIGNED_ROOT_ACTION_SPECS.map((spec) => spec.id),
) as readonly SignedRootActionId[];

const SIGNED_ROOT_ACTION_ID_SET = new Set<string>(SIGNED_ROOT_ACTION_IDS);

export const SignedRootActionIdSchema = lazyZodSchema(() => z.custom<SignedRootActionId>(
  (actionId) => typeof actionId === 'string' && SIGNED_ROOT_ACTION_ID_SET.has(actionId),
  { message: 'Action is not available to the signed interactive root' },
));

const PUBLIC_ACTION_SPECS = SIGNED_ROOT_ACTION_SPECS.filter(
  (spec): spec is ActionSpecWithoutApproval & Readonly<{
    surfaces: ActionSpecWithoutApproval['surfaces'] & Readonly<{ api: true }>;
    outputSchema: z.ZodMiniType;
  }> => (
    spec.surfaces.api === true
  ),
);

/** Runtime companion generated from the same canonical rows as the API type maps. */
export const PUBLIC_ACTION_IDS = Object.freeze(
  PUBLIC_ACTION_SPECS.map((spec) => spec.id),
) as readonly PublicActionId[];

const PUBLIC_ACTION_ID_SET = new Set<string>(PUBLIC_ACTION_IDS);

/** Runtime parser for the ActionSpec rows explicitly surfaced to authenticated API callers. */
export const PublicActionIdSchema = lazyZodSchema(() => z.custom<PublicActionId>(
  (actionId) => typeof actionId === 'string' && PUBLIC_ACTION_ID_SET.has(actionId),
  { message: 'Action is not available on the public API surface' },
));

function projectPublicActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): ActionSchemaCarriersById<PublicActionInputSchemaById>;
function projectPublicActionInputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
): object {
  return Object.freeze(Object.fromEntries(specs.map((spec) => {
    const surfaceBindings = 'surfaceBindings' in spec
      ? spec.surfaceBindings
      : undefined;
    const apiBinding = surfaceBindings && 'api' in surfaceBindings
      ? surfaceBindings.api
      : undefined;
    return [spec.id, apiBinding?.inputSchema ?? spec.inputSchema];
  })));
}

function projectPublicActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
  projection: 'public',
): ActionSchemaCarriersById<PublicActionOutputSchemaById>;
function projectPublicActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
  projection: 'signed-root',
): Readonly<Record<SignedRootActionId, z.ZodMiniType>>;
function projectPublicActionOutputSchemas(
  specs: readonly ActionSpecWithoutApproval[],
  _projection: 'public' | 'signed-root',
): object {
  return Object.freeze(Object.fromEntries(specs.map((spec) => {
    const surfaceBindings = 'surfaceBindings' in spec
      ? spec.surfaceBindings
      : undefined;
    const apiBinding = surfaceBindings && 'api' in surfaceBindings
      ? surfaceBindings.api
      : undefined;
    const apiOutputSchema = apiBinding && 'outputSchema' in apiBinding
      ? apiBinding.outputSchema
      : undefined;
    return [spec.id, apiOutputSchema ?? spec.outputSchema];
  })));
}

/** Runtime result projection for signed interactive root execution. */
export const SIGNED_ROOT_ACTION_OUTPUT_SCHEMAS = projectPublicActionOutputSchemas(
  SIGNED_ROOT_ACTION_SPECS,
  'signed-root',
);

export const PUBLIC_ACTION_INPUT_SCHEMAS: ActionSchemaCarriersById<PublicActionInputSchemaById> = projectPublicActionInputSchemas(
  PUBLIC_ACTION_SPECS,
);

export const PUBLIC_ACTION_OUTPUT_SCHEMAS: ActionSchemaCarriersById<PublicActionOutputSchemaById> = projectPublicActionOutputSchemas(
  PUBLIC_ACTION_SPECS,
  'public',
);

const HOST_DOMAIN_PLUGIN_CALLER_POLICY: ActionPluginCallerPolicy = {
  kind: 'caller',
};
const PLUGIN_RELOAD_CALLER_POLICY: ActionPluginCallerPolicy = {
  kind: 'self_or_inspector_admin',
  targetPluginIdField: 'pluginId',
  administrativeCallers: [{
    pluginId: 'happier.inspector',
    contributionLocalId: 'inspector-app',
  }],
};
/**
 * The one declaration census for host Actions with a caller policy on the
 * plugin surface.
 * `caller` means the canonical executor requires a current host-stamped
 * plugin caller. A `caller` row names no plugin identity: a built-in plugin
 * and an out-of-tree plugin reach exactly the same host capability. Further
 * identity projection occurs only when the incumbent domain owner has
 * caller-dependent authorization — Account scope, publisher proof, and current
 * materialization are that owner's fences, and they do not depend on which
 * plugin is asking. Reload is the one plugin-*targeted* Action: it administers
 * a peer plugin's development generation, so its self scope and the exact
 * Inspector administrative surface live here rather than in any consumer.
 */
const ACTION_PLUGIN_CALLER_POLICY_BY_ID: Readonly<
  Partial<Record<ActionId, ActionPluginCallerPolicy>>
> = Object.freeze({
  'connectedServices.quota.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'connectedServices.billing.open': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'connectedServices.pools.selection.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.query': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.prices.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.prices.refresh': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.export': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.recap.compose': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.recap.export': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.recap.deliver': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.calendar.export': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.coach.apply': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.coach.undo': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.coach.dismiss': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.coach.snooze': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'capture.view': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.reload': PLUGIN_RELOAD_CALLER_POLICY,
  'plugins.permissions.grants.request': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.permissions.grants.revoke': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.event.admit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.event.source.status.report': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.targets.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.target.verify': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.admit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.create': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.transition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.edit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.reply': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.redact': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.setDisposition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.attachEvidence': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.bulkTransition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.claimPublicationDispatch': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'browser.navigate': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.install': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.disable': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.enable': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.uninstall': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.materialize.start': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.cancel': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.resume': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.retry': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.discard': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  // Destructive Board removal needs a current host-stamped plugin caller; the
  // Session's own access owner still authorizes the record mutation beneath it.
  'session.board.item.remove': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.rollback': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.checkpoint_code_rollback': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.checkpoint': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.restore': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.terminalComposer.clear': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pendingInput.interruptAndRun': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.action.set': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.withdraw': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.markHandled': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.dismiss': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.sendAsNew': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.usageLimit.consumeResetCredit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'agents.acp.backends.upsert': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'agents.acp.backends.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'agents.acp.backends.delete': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'agents.acp.backends.installFromRegistry': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.update': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.create': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.favorite.set': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'models.favorite.set': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.model.unarm': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.library.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.stack.update': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.invocations.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.invocation.resolve': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.invocation.create': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_bundle.update': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_registry.install': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'transcript.import': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.backgroundFollow.set': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.openOrReuse': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.checkout': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.prepareWorktree': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.reviewWorkspace.materializePrepared': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.runStacked': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.clone': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.init': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.removeIndexLock': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.hostingRepository.publish': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
});

function resolveActionPluginCallerPolicy(
  spec: ActionSpecWithoutApproval,
): ActionPluginCallerPolicy | undefined {
  const policy = ACTION_PLUGIN_CALLER_POLICY_BY_ID[spec.id];
  const requiresPolicy = spec.surfaces.plugin && spec.safety !== 'safe';
  if (!spec.surfaces.plugin && policy) {
    throw new Error(`Action ${spec.id} declares pluginCallerPolicy without a plugin surface`);
  }
  // Backed runtime Actions use the same host-stamped Plugin provenance as
  // every other non-safe host Action. Their machine/session routing remains
  // with the runtime owner; callers never supply a plugin identity in input.
  if (requiresPolicy && isRuntimeActionIdV1(spec.id)) {
    return HOST_DOMAIN_PLUGIN_CALLER_POLICY;
  }
  return requiresPolicy ? policy ?? HOST_DOMAIN_PLUGIN_CALLER_POLICY : policy;
}

const CURRENT_SESSION_CONTEXT_ACTION_IDS = new Set<ActionId>([
  'session.needs_you.raise',
  'reviews.comments.create',
  'reviews.comments.list',
  'browser.recording.attachToComposer',
  'localServices.inventory.list',
  'localServices.inventory.refresh',
  'localServices.launcher.snapshot',
  'localServices.launcher.openPreview',
  'localServices.launcher.registerPreview',
  'localServices.launcher.history.clear',
  'localServices.preview.openOrCreate',
  'localServices.preview.status',
  'localServices.preview.revoke',
  'localServices.publicPreview.create',
  'localServices.publicPreview.status',
  'localServices.publicPreview.revoke',
  'localServices.publicPreview.copyUrl',
  'peerMediation.observability.snapshot',
  'sessions.external.operation.status.get',
  'sessions.external.operation.cancel',
  'sessions.external.operation.resume',
  'sessions.external.operation.retry',
  'sessions.external.operation.discard',
  'action.options.resolve',
  'review.start',
  'review.walkthrough',
  'review.explain_findings',
  'subagents.plan.start',
  'subagents.delegate.start',
  'voice_agent.start',
  'execution.run.start',
  'execution.run.list',
  'execution.run.get',
  'execution.run.send',
  'execution.run.ensure',
  'execution.run.ensure_or_start',
  'execution.run.stream.start',
  'execution.run.stream.read',
  'execution.run.stream.cancel',
  'execution.run.stop',
  'execution.run.cancel_turn',
  'execution.run.action',
  'execution.run.wait',
  'session.open',
  'session.fork',
  'session.rollback',
  'session.checkpoint_code_rollback',
  'session.checkpoint',
  'session.restore',
  'session.handoff',
  'session.handoff.prepare_target',
  'review.engines.list',
  'session.message.send',
  'session.turn.cancel',
  'session.stop',
  'session.runtime.refresh',
  'session.control.switch',
  'session.terminalComposer.clear',
  'session.pendingInput.interruptAndRun',
  'session.title.set',
  'session.bot.set',
  'session.organization.pin.set',
  'session.view.toolCalls.set',
  'session.memory.set',
  'session.voice.preference.set',
  'session.context.update',
  'session.instructions.set',
  'session.permission_mode.set',
  'session.approval_reviewer.set',
  'session.attention.set',
  'session.model.set',
  'session.archive',
  'session.unarchive',
  'session.status.get',
  'session.work_state.get',
  'session.goal.get',
  'session.goal.set',
  'session.goal.clear',
  'session.usageLimit.waitResume.enable',
  'session.usageLimit.waitResume.cancel',
  'session.usageLimit.checkNow',
  'session.usageLimit.consumeResetCredit',
  'session.vendor_plugin_catalog.list',
  'session.skill_catalog.list',
  'session.history.get',
  'session.transcript.get',
  'session.events.get',
  'session.wait.idle',
  'session.board.get',
  'session.board.item.upsert',
  'session.board.item.remove',
  'session.board.layout.update',
  'session.permission.respond',
  'session.permission.remote.pending.list',
  'session.permission.remote.respond',
  'session.user_action.remote.answer',
  'session.permission.remote.grants.list',
  'session.permission.remote.grants.revoke',
  'session.user_action.answer',
  'session.mode.set',
  'session.config_option.set',
  'session.connected_services_auth.set',
  'session.target.primary.set',
  'session.activity.get',
  'session.messages.recent.get',
  'ui.voice_agent.teleport',
  'memory.ensure_up_to_date',
  'transcript.page',
  'transcript.readAfter',
  'transcript.follow',
  'transcript.unfollow',
  'transcript.import',
  'transcript.search',
  'sessions.external.follow',
  'sessions.external.unfollow',
  'sessions.external.backgroundFollow.set',
  'sessions.external.status.get',
]);

function resolveBuiltInActionContextualDefaults(actionId: ActionId): ActionContextualDefaults | undefined {
  if (actionId === 'memory.search' || actionId === 'memory.get_window') {
    return { machineId: 'current_session_machine' };
  }
  return CURRENT_SESSION_CONTEXT_ACTION_IDS.has(actionId)
    ? { sessionId: 'current_session' }
    : undefined;
}

// Schema-admitted examples for the newly surfaced Action families. Existing
// authored examples remain on their rows; this catalog-owned supplement adds
// only the missing examples, not a runtime sample generator or another catalog.
const ACTION_VOICE_ARGS_EXAMPLES: Readonly<Partial<Record<ActionId, string>>> = {
  'discussion.second_opinion.start': '{"intent":"preview","title":"Second opinion","question":"What would you change?","source":{"kind":"session","message":{"kind":"session","session":{"serverId":"home","sessionId":"source"},"messageId":"answer"}},"reviewers":[{"selection":{"kind":"session","session":{"serverId":"home","sessionId":"reviewer"}}}],"retry":{"creationLocalId":"opinion-create","quoteLocalId":"opinion-quote","questionLocalId":"opinion-question"}}',
  'discussion.list': '{}',
  'discussion.get': '{"discussionId":"discussion-1"}',
  'discussion.read': '{"discussionId":"discussion-1","limit":30}',
  'discussion.create': '{"title":"Release review","firstMessage":{"localId":"first-post-1","content":{"v":1,"parts":[{"t":"text","text":"What should we check?"}]}}}',
  'discussion.post': '{"discussionId":"discussion-1","content":{"v":1,"parts":[{"t":"text","text":"The migration is ready."}]}}',
  'discussion.reply': '{"discussionId":"discussion-1","replyTarget":{"kind":"message","messageId":"question-1"},"content":{"v":1,"parts":[{"t":"text","text":"The migration is ready."}]}}',
  'discussion.pass': '{"discussionId":"discussion-1"}',
  'discussion.rename': '{"discussionId":"discussion-1","title":"Release readiness"}',
  'discussion.archive': '{"discussionId":"discussion-1"}',
  'discussion.restore': '{"discussionId":"discussion-1"}',
  'discussion.read_state.set': '{"discussionId":"discussion-1","lastReadSeq":1}',
  'discussion.participants.list': '{"discussionId":"discussion-1"}',
  'discussion.candidates.list': '{"source":"people","query":"alex"}',
  'discussion.invite': '{"discussionId":"discussion-1","participant":{"kind":"account","accountId":"account-2"}}',
  'discussion.participant.remove': '{"discussionId":"discussion-1","participant":{"kind":"account","accountId":"account-2"}}',
  'discussion.participant.policy.set': '{"discussionId":"discussion-1","participant":{"kind":"session","sessionId":"participant-1"},"answerPolicy":"reads_only"}',
  'discussion.leave': '{"discussionId":"discussion-1"}',
  'discussion.owner.transfer': '{"discussionId":"discussion-1","accountId":"account-2"}',
  'discussion.access.grants.list': '{"discussionId":"discussion-1"}',
  'discussion.access.grants.set': '{"discussionId":"discussion-1","principal":{"kind":"account","accountId":"account-2"},"accessLevel":"view"}',
  'discussion.access.grants.remove': '{"discussionId":"discussion-1","principal":{"kind":"account","accountId":"account-2"}}',
  'settings.list': '{"pageId":"notifications"}',
  'settings.get': '{"anchor":"notifications.quietHours"}',
  'settings.set': '{"anchor":"notifications.quietHours","value":{"enabled":false}}',
  'settings.reset': '{"anchor":"notifications.quietHours"}',
  'settings.invoke': '{"anchor":"diagnostics.enabled","input":{"kind":"diagnostics_enabled","enabled":true}}',
  'localServices.inventory.list': '{"machineId":"{{machineId}}"}',
  'localServices.inventory.refresh': '{"machineId":"{{machineId}}"}',
  'localServices.launcher.snapshot': '{"machineId":"{{machineId}}"}',
  'localServices.launcher.registerPreview': '{"machineId":"{{machineId}}","targetId":"service-1","scope":"workspace","workspaceRoot":"/workspace"}',
  'localServices.launcher.history.clear': '{"machineId":"{{machineId}}","scope":"workspace","workspaceRoot":"/workspace"}',
  'localServices.preview.openOrCreate': '{"machineId":"{{machineId}}","targetId":"listener-1"}',
  'localServices.preview.status': '{"machineId":"{{machineId}}","previewId":"preview-1"}',
  'localServices.preview.revoke': '{"machineId":"{{machineId}}","previewId":"preview-1"}',
  'localServices.publicPreview.create': '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","previewId":"preview-1","mode":"secret_link","ttlMs":3600000}',
  'localServices.publicPreview.status': '{"machineId":"{{machineId}}","exposureId":"exposure-1"}',
  'localServices.publicPreview.revoke': '{"machineId":"{{machineId}}","exposureId":"exposure-1"}',
  'machines.vitals.get': '{"machineId":"{{machineId}}","view":"summary"}',
  'machines.vitals.summaries.list': '{"serverId":"{{serverId}}"}',
  'machines.resources.policy.get': '{"machineId":"{{machineId}}"}',
  'machines.storage.summary.get': '{"machineId":"{{machineId}}"}',
  'machines.storage.category.list': '{"machineId":"{{machineId}}","categoryId":"logs"}',
  'prompt_bundle.update': '{"artifactId":"bundle-1","title":"Example skill","skillMarkdown":"# Example"}',
  'daemon.filesystem.readFile': '{"rootPath":"/workspace","path":"src/index.ts"}',
  'daemon.filesystem.writeFile': '{"rootPath":"/workspace","path":"notes.txt","content":"SGVsbG8="}',
  'daemon.filesystem.listDirectory': '{"rootPath":"/workspace","path":"src"}',
  'daemon.filesystem.getDirectoryTree': '{"rootPath":"/workspace","path":"src","maxDepth":2}',
  "widgets.group.create": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\"}},\"groupId\":\"group-1\",\"instanceIds\":[\"widget-1\"]}",
  "widgets.group.add": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\"}},\"group\":{\"kind\":\"group\",\"id\":\"group-1\",\"children\":[{\"kind\":\"widget\",\"instance\":{\"v\":1,\"id\":\"widget-1\",\"definition\":{\"kind\":\"installed\",\"surface\":{\"pluginId\":\"example.widgets\",\"localId\":\"example\"}},\"bindings\":{}}}]}}",
  "widgets.group.ungroup": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\"}},\"instanceId\":\"group-1\"}}",
  "widgets.group.set": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\"}},\"instanceId\":\"group-1\"},\"width\":\"full\",\"dividers\":\"none\"}",
  "widgets.group.inputs.set": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\"}},\"instanceId\":\"group-1\"},\"bindings\":{}}",
  "widgets.area.layout.select": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\"}}}",
  "widgets.area.layout.reset": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\"}},\"expectedRevision\":null}",
  "widgets.area.layout.undo": "{\"capture\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\"}},\"previousLayout\":{\"v\":1,\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\"}},\"items\":[]},\"expectedRevision\":{\"headerVersion\":1,\"bodyVersion\":1}}}",
  "widgets.fragment.list": "{\"account\":{\"serverId\":\"home\",\"accountId\":\"example\"}}",
  "widgets.fragment.get": "{\"account\":{\"serverId\":\"home\",\"accountId\":\"example\"},\"artifactId\":\"fragment-1\"}",
  "widgets.fragment.create": "{\"account\":{\"serverId\":\"home\",\"accountId\":\"example\"},\"artifactId\":\"fragment-1\",\"fragment\":{\"name\":\"Project widgets\",\"inputs\":{\"fields\":[]},\"inputSchema\":{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false},\"group\":{\"children\":[{\"kind\":\"widget\",\"instance\":{\"v\":1,\"definition\":{\"kind\":\"installed\",\"surface\":{\"pluginId\":\"example.widgets\",\"localId\":\"example\"}},\"bindings\":{}}}]}}}",
  "widgets.fragment.update": "{\"account\":{\"serverId\":\"home\",\"accountId\":\"example\"},\"artifactId\":\"fragment-1\",\"patch\":{\"name\":\"Project widgets\"}}",
  "widgets.fragment.duplicate": "{\"account\":{\"serverId\":\"home\",\"accountId\":\"example\"},\"artifactId\":\"fragment-1\",\"newArtifactId\":\"fragment-2\"}",
  "widgets.fragment.delete": "{\"account\":{\"serverId\":\"home\",\"accountId\":\"example\"},\"artifactId\":\"fragment-1\"}",
  "memory.remember": "{\"ref\":{\"kind\":\"doc\",\"artifactId\":\"example\"},\"expectedRevision\":{\"headerVersion\":0,\"bodyVersion\":0},\"text\":\"Remember the verified project decision.\"}",
  "memory.decision.save": "{\"ref\":{\"kind\":\"doc\",\"artifactId\":\"example\"},\"expectedRevision\":{\"headerVersion\":0,\"bodyVersion\":0},\"text\":\"Use PostgreSQL.\",\"reason\":\"Reviewed the alternatives.\",\"sourceMessageRef\":{\"kind\":\"session\",\"session\":{\"serverId\":\"home\",\"sessionId\":\"example\"},\"messageId\":\"committed\"}}",
  "memory.update": "{\"ref\":{\"kind\":\"doc\",\"artifactId\":\"example\"},\"expectedRevision\":{\"headerVersion\":0,\"bodyVersion\":0},\"factId\":\"example\",\"text\":\"Remember the verified project decision.\"}",
  "memory.forget": "{\"ref\":{\"kind\":\"doc\",\"artifactId\":\"example\"},\"expectedRevision\":{\"headerVersion\":0,\"bodyVersion\":0},\"factId\":\"example\"}",
  "memory.read": "{\"ref\":{\"kind\":\"doc\",\"artifactId\":\"example\"}}",
  "memory.list": "{}",
  "projects.trust.list": "{}",
  "projects.trust.revoke": "{\"project\":{\"serverId\":\"home\",\"projectId\":\"example\"},\"expectedRevision\":0,\"expectedEffectDigest\":\"example\"}",
  "projects.prepare": "{\"workspace\":{\"serverId\":\"home\",\"workspaceId\":\"example\",\"machineId\":\"machine-1\",\"rootPath\":\"/workspace\"},\"phase\":\"setup\"}",
  "projects.script.run": "{\"workspace\":{\"serverId\":\"home\",\"workspaceId\":\"example\",\"machineId\":\"machine-1\",\"rootPath\":\"/workspace\"},\"selection\":{\"kind\":\"named\",\"name\":\"example\"}}",
  "projects.compute.exec": "{\"workspace\":{\"serverId\":\"home\",\"workspaceId\":\"example\",\"machineId\":\"machine-1\",\"rootPath\":\"/workspace\"},\"executable\":\"example\",\"argv\":[],\"cwd\":\"example\"}",
  "projects.inspect": "{\"workspace\":{\"serverId\":\"home\",\"workspaceId\":\"example\",\"machineId\":\"machine-1\",\"rootPath\":\"/workspace\"}}",
  "projects.manifest.update": "{\"workspace\":{\"serverId\":\"home\",\"workspaceId\":\"example\",\"machineId\":\"machine-1\",\"rootPath\":\"/workspace\"},\"expectedBasis\":{\"kind\":\"absent\"},\"bytes\":\"example\"}",
  "session.organization.pin.set": "{\"pinned\":false,\"sessionId\":\"session-1\"}",
  "widgets.catalog.list": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}}}",
  "widgets.item.list": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}}}",
  "widgets.item.add": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instance\":{\"v\":1,\"id\":\"example\",\"definition\":{\"kind\":\"installed\",\"surface\":{\"pluginId\":\"example.widgets\",\"localId\":\"example\"}},\"bindings\":{}}}",
  "widgets.item.remove": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instanceId\":\"example\"}}",
  "widgets.item.move": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instanceId\":\"example\"},\"toIndex\":0}",
  "widgets.item.rename": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instanceId\":\"example\"},\"displayName\":\"example\"}",
  "widgets.item.size.set": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instanceId\":\"example\"},\"size\":\"small\"}",
  "widgets.item.frame.set": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instanceId\":\"example\"},\"frameStyle\":\"card\"}",
  "widgets.item.network.set": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instanceId\":\"example\"},\"network\":{\"network\":\"none\"}}",
  "widgets.item.inputs.get": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instanceId\":\"example\"}}",
  "widgets.item.inputs.validate": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instanceId\":\"example\"},\"bindings\":{}}",
  "widgets.item.inputs.set": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instanceId\":\"example\"},\"bindings\":{}}",
  "widgets.item.inputs.reset": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instanceId\":\"example\"}}",
  "widgets.item.refresh": "{\"ref\":{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"home\"}},\"instanceId\":\"example\"}}",
  "widgets.area.layout.list": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\",\"layoutId\":\"dashboard-1\"},\"artifactId\":\"dashboard-artifact\"}}",
  "widgets.area.layout.create": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\",\"layoutId\":\"dashboard-1\"},\"artifactId\":\"dashboard-artifact\"},\"layoutId\":\"example\",\"name\":\"example\"}",
  "widgets.area.layout.rename": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\",\"layoutId\":\"dashboard-1\"},\"artifactId\":\"dashboard-artifact\"},\"expectedRevision\":{\"headerVersion\":1,\"bodyVersion\":1},\"name\":\"example\"}",
  "widgets.area.layout.delete": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\",\"layoutId\":\"dashboard-1\"},\"artifactId\":\"dashboard-artifact\"},\"expectedRevision\":{\"headerVersion\":1,\"bodyVersion\":1}}",
  "widgets.area.layout.reorder": "{\"surface\":{\"serverId\":\"home\",\"accountId\":\"example\",\"owner\":{\"kind\":\"project\",\"projectId\":\"project-1\",\"layoutId\":\"dashboard-1\"},\"artifactId\":\"dashboard-artifact\"},\"expectedRevision\":{\"headerVersion\":1,\"bodyVersion\":1},\"position\":{\"anchorId\":\"example\",\"placement\":\"before\"}}",
  "projects.sources.list": "{\"serverId\":\"home\"}",
  "projects.sources.read": "{\"serverId\":\"home\",\"sourceId\":\"example\"}",
  "projects.sources.create": "{\"name\":\"example\",\"repository\":{\"provider\":{\"id\":\"example\",\"kind\":\"github\",\"displayName\":\"example\",\"baseUrl\":\"https://example.com\"},\"repository\":{\"nameWithOwner\":\"example\"},\"protocol\":\"auto\"},\"serverId\":\"home\",\"requestKey\":\"example\"}",
  "projects.sources.update": "{\"serverId\":\"home\",\"sourceId\":\"example\",\"expectedRevision\":1,\"patch\":{}}",
  "projects.sources.delete": "{\"serverId\":\"home\",\"sourceId\":\"example\",\"expectedRevision\":1}",
  "localServices.launcher.start": "{\"machineId\":\"machine-1\",\"targetId\":\"example\"}",
  "localServices.actions.forget": "{\"requestId\":\"example\",\"target\":{\"kind\":\"inventory_entry\",\"inventoryEntryId\":\"example\",\"machineId\":\"machine-1\"},\"action\":\"forget\"}",
  "localServices.actions.stopManaged": "{\"requestId\":\"example\",\"target\":{\"kind\":\"inventory_entry\",\"inventoryEntryId\":\"example\",\"machineId\":\"machine-1\"},\"action\":\"stop_managed\",\"confirmationNonce\":\"{{confirmationNonce}}\"}",
  "localServices.actions.restartManaged": "{\"requestId\":\"example\",\"target\":{\"kind\":\"inventory_entry\",\"inventoryEntryId\":\"example\",\"machineId\":\"machine-1\"},\"action\":\"restart_managed\",\"confirmationNonce\":\"{{confirmationNonce}}\"}",
  "localServices.actions.terminateDetected": "{\"requestId\":\"example\",\"target\":{\"kind\":\"inventory_entry\",\"inventoryEntryId\":\"example\",\"machineId\":\"machine-1\"},\"action\":\"terminate_detected\",\"confirmationNonce\":\"{{confirmationNonce}}\"}",
  "machines.terminal.open": "{\"terminalKey\":\"example\",\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "machines.terminal.list": "{\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "machines.terminal.read": "{\"terminalId\":\"example\",\"byteOffset\":0,\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "machines.terminal.write": "{\"terminalId\":\"example\",\"event\":{\"t\":\"text\",\"text\":\"Remember the verified project decision.\"},\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "machines.terminal.close": "{\"terminalId\":\"example\",\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "machines.terminal.restart": "{\"terminalKey\":\"example\",\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "machines.work.summary.get": "{\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "machines.access.grants.list": "{\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "machines.access.grant.set": "{\"serverId\":\"home\",\"machineId\":\"machine-1\",\"principal\":{\"kind\":\"account\",\"accountId\":\"example\"},\"level\":\"view\"}",
  "machines.access.grant.remove": "{\"serverId\":\"home\",\"machineId\":\"machine-1\",\"principal\":{\"kind\":\"account\",\"accountId\":\"example\"}}",
  "machines.access.leave": "{\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "machines.access.prepareKeys": "{\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "connectedServices.accounts.revoke": "{\"account\":{\"service\":{\"pluginId\":\"example.widgets\",\"localId\":\"example\"},\"accountId\":\"example\"},\"cleanupGroupReferences\":false,\"machineId\":\"machine-1\"}",
  "machines.presets.list": "{\"homeId\":\"example\"}",
  "machines.presets.get": "{\"homeId\":\"example\",\"id\":\"example\"}",
  "machines.presets.create": "{\"id\":\"example\",\"homeId\":\"example\",\"name\":\"example\",\"owner\":{\"kind\":\"account\",\"accountId\":\"example\"},\"recipe\":{\"provider\":{\"pluginId\":\"example.widgets\",\"localId\":\"example\"},\"schemaVersion\":1,\"name\":\"example\",\"choices\":false},\"controller\":{\"machineId\":\"machine-1\",\"installationId\":\"example\"}}",
  "machines.presets.update": "{\"homeId\":\"example\",\"id\":\"example\",\"expectedRevision\":0,\"patch\":{}}",
  "machines.presets.archive": "{\"homeId\":\"example\",\"id\":\"example\",\"expectedRevision\":0}",
  "machines.presets.restore": "{\"homeId\":\"example\",\"id\":\"example\",\"expectedRevision\":0}",
  "machines.provisioners.list": "{\"homeId\":\"example\"}",
  "machines.provisioners.check": "{\"homeId\":\"example\",\"controller\":{\"machineId\":\"machine-1\",\"installationId\":\"example\"},\"contribution\":{\"pluginId\":\"example.widgets\",\"localId\":\"example\"}}",
  "machines.provisioners.options": "{\"homeId\":\"example\",\"controller\":{\"machineId\":\"machine-1\",\"installationId\":\"example\"},\"contribution\":{\"pluginId\":\"example.widgets\",\"localId\":\"example\"},\"selectors\":false}",
  "machines.managed.acquire": "{\"selection\":{\"kind\":\"one-off\",\"homeId\":\"example\",\"launch\":{\"provider\":{\"pluginId\":\"example.widgets\",\"localId\":\"example\"},\"schemaVersion\":1,\"name\":\"example\",\"choices\":false},\"controller\":{\"machineId\":\"machine-1\",\"installationId\":\"example\"},\"retention\":{\"kind\":\"until-delete\"},\"wakeOnAcceptedMessage\":false}}",
  "machines.managed.list": "{\"homeId\":\"example\"}",
  "machines.managed.get": "{\"homeId\":\"example\",\"managedId\":\"example\"}",
  "machines.managed.references.get": "{\"homeId\":\"example\",\"managedId\":\"example\"}",
  "machines.managed.inspect": "{\"homeId\":\"example\",\"managedId\":\"example\"}",
  "machines.managed.bootstrap.retry": "{\"homeId\":\"example\",\"managedId\":\"example\",\"expectedIntentRevision\":0}",
  "machines.managed.setup.skip": "{\"homeId\":\"example\",\"managedId\":\"example\",\"expectedIntentRevision\":0}",
  "machines.environment.apply": "{\"homeId\":\"example\",\"machineId\":\"machine-1\",\"presetId\":\"example\",\"presetRevision\":0}",
  "machines.managed.cancel": "{\"homeId\":\"example\",\"managedId\":\"example\",\"expectedIntentRevision\":0}",
  "machines.managed.power.set": "{\"homeId\":\"example\",\"managedId\":\"example\",\"when\":\"now\",\"expectedRevision\":0,\"intent\":\"start\"}",
  "machines.managed.rebuild": "{\"homeId\":\"example\",\"managedMachineId\":\"machine-1\",\"expectedRevision\":0,\"kind\":\"rebuild\",\"reviewedEffectDigest\":\"example\"}",
  "machines.managed.retention.update": "{\"homeId\":\"example\",\"managedId\":\"example\",\"expectedIntentRevision\":0,\"retention\":{\"kind\":\"until-delete\"},\"wakeOnAcceptedMessage\":false}",
  "machines.managed.delete": "{\"homeId\":\"example\",\"managedId\":\"example\",\"when\":\"now\",\"expectedRevision\":0,\"intent\":\"delete\",\"reviewedDependencies\":true}",
  "machines.managed.controller.update": "{\"homeId\":\"example\",\"managedId\":\"example\",\"expectedIntentRevision\":0,\"controller\":{\"machineId\":\"machine-1\",\"installationId\":\"example\"},\"reviewedPendingEffects\":true}",
  "machines.managed.retire": "{\"homeId\":\"example\",\"managedId\":\"example\",\"expectedIntentRevision\":0,\"manualResponsibility\":true}",
  "action.operations.list": "{\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "action.operations.get": "{\"operationId\":\"example\",\"serverId\":\"home\",\"machineId\":\"machine-1\"}",
  "action.operations.cancel": "{\"serverId\":\"home\",\"machineId\":\"machine-1\",\"operationId\":\"example\"}",
  "projects.execution.output.read": "{\"serverId\":\"home\",\"machineId\":\"machine-1\",\"operationId\":\"example\",\"byteOffset\":0}",
  "projects.execution.output.open": "{\"serverId\":\"home\",\"machineId\":\"machine-1\",\"operationId\":\"example\"}",
  "projects.execution.output.copy": "{\"serverId\":\"home\",\"machineId\":\"machine-1\",\"operationId\":\"example\",\"byteOffset\":0}",
  "projects.context.update": "{\"target\":{\"serverId\":\"home\",\"projectKey\":\"example\"},\"expectedRevision\":0,\"intent\":{\"kind\":\"attach\",\"entry\":{\"id\":\"example\",\"ref\":{\"kind\":\"doc\",\"artifactId\":\"example\"}}}}",
  "projects.visibility.set": "{\"target\":{\"serverId\":\"home\",\"projectKey\":\"example\"},\"expectedRevision\":0,\"hidden\":false}",
  "projects.workspace.update": "{\"serverId\":\"home\",\"workspaceId\":\"example\"}",
  "projects.workspace.forget": "{\"serverId\":\"home\",\"workspaceId\":\"example\"}",
  "projects.list": "{}",
  "session.pending.action.set": "{\"sessionId\":\"session-1\",\"localId\":\"example\",\"requestedAction\":{\"v\":1,\"kind\":\"enqueue\"},\"resumeWhenAvailable\":true}",
  "session.pending.withdraw": "{\"sessionId\":\"session-1\",\"localId\":\"example\"}",
  "session.pending.markHandled": "{\"sessionId\":\"session-1\",\"localId\":\"example\"}",
  "session.pending.dismiss": "{\"sessionId\":\"session-1\",\"localId\":\"example\"}",
  "session.pending.sendAsNew": "{\"sessionId\":\"session-1\",\"localId\":\"example\"}",
  "session.bot.set": "{\"sessionId\":\"session-1\",\"bot\":{\"kind\":\"bot\"}}",
  "session.memory.set": "{\"sessionId\":\"session-1\",\"serverId\":\"home\",\"expectedMetadataRevision\":0,\"enabled\":false}",
  "session.voice.preference.set": "{\"sessionId\":\"session-1\",\"serverId\":\"home\",\"expectedMetadataRevision\":0,\"preference\":{\"providerContributionId\":\"example.voice/speech\",\"settingFieldPath\":\"voice\",\"value\":\"example\"}}",
  "session.context.update": "{\"sessionId\":\"session-1\",\"serverId\":\"home\",\"expectedMetadataRevision\":0,\"intent\":{\"kind\":\"set\",\"entry\":{\"id\":\"example\",\"ref\":{\"kind\":\"doc\",\"artifactId\":\"example\"}}}}",
  "session.instructions.set": "{\"sessionId\":\"session-1\",\"serverId\":\"home\",\"expectedMetadataRevision\":0,\"ref\":{\"kind\":\"doc\",\"artifactId\":\"example\"}}",
  "session.view.toolCalls.set": "{\"sessionId\":\"session-1\",\"showToolCalls\":false}",
  "prompt_doc.get": "{\"artifactId\":\"example\"}",
  "prompt_doc.create": "{\"title\":\"example\",\"markdown\":\"example\"}",
  "prompt_doc.favorite.set": "{\"artifactId\":\"example\",\"favorite\":false}",
  "prompts.library.list": "{}",
  "prompt_doc.update": "{\"artifactId\":\"example\",\"title\":\"example\",\"markdown\":\"example\"}",
  "daemon.filesystem.createDirectory": "{\"rootPath\":\"/workspace\",\"path\":\"/workspace\"}",
  "daemon.filesystem.rename": "{\"rootPath\":\"/workspace\",\"from\":\"example\",\"to\":\"example\",\"overwrite\":false}",
  "daemon.filesystem.delete": "{\"rootPath\":\"/workspace\",\"path\":\"/workspace\",\"recursive\":false}",
  "daemon.filesystem.copy": "{\"rootPath\":\"/workspace\",\"from\":\"example\",\"to\":\"example\",\"overwrite\":false,\"recursive\":false}",
  "daemon.filesystem.upload": "{\"rootPath\":\"/workspace\",\"path\":\"/workspace\",\"source\":{\"sourceId\":\"example\",\"sizeBytes\":0},\"overwrite\":false}",
  "daemon.filesystem.download": "{\"rootPath\":\"/workspace\",\"path\":\"/workspace\",\"destination\":{\"destinationId\":\"example\"},\"asZip\":false}",
  "daemon.filesystem.transfer.cancel": "{\"rootPath\":\"/workspace\",\"direction\":\"upload\",\"transferId\":\"example\"}",
  "scm.history.entries": "{\"cwd\":\"example\",\"folder\":\"example\",\"paths\":[]}",
  "scm.hostingRepository.resolveAddress": "{\"address\":\"example\"}",
};

export const ACTION_SPECS: readonly ActionSpec[] = Object.freeze(
  ACTION_SPECS_WITH_PUBLIC_EXPOSURE.map((spec): ActionSpec => {
    const pluginCallerPolicy = resolveActionPluginCallerPolicy(spec);
    const contextualDefaults = resolveBuiltInActionContextualDefaults(spec.id);
    const argsExample = spec.examples?.voice?.argsExample ?? ACTION_VOICE_ARGS_EXAMPLES[spec.id];
    return {
      ...spec,
      ...(argsExample ? { examples: { ...spec.examples, voice: { ...spec.examples?.voice, argsExample } } } : {}),
      requiredAuthority: resolveActionRequiredAuthority(spec),
      executionPlacement: resolveActionExecutionPlacement(spec),
      ...(pluginCallerPolicy ? { pluginCallerPolicy } : {}),
      ...(contextualDefaults ? { contextualDefaults } : {}),
      placements: [...spec.placements],
    };
  }),
);

assertPublicActionSdkMethodNames(ACTION_SPECS, PUBLIC_ACTION_ID_SET);

const ACTION_SPECS_BY_ID = new Map(ACTION_SPECS.map((spec) => [spec.id, spec] as const));

export function listActionSpecs(): readonly ActionSpec[] {
  return ACTION_SPECS;
}

export function getActionSpec(id: ActionId): ActionSpec {
  const spec = ACTION_SPECS_BY_ID.get(id);
  if (!spec) {
    // This is a programmer error: all call sites should be type-safe and list-backed.
    throw new Error(`Unknown action spec: ${id}`);
  }
  return spec;
}

/** Invocation and inspection prepare targets under their own admitted Action root. */
export function isSessionTargetPreparationAction(id: ActionId): boolean {
  return id === 'session.targets.resolve' || id === 'action.invoke' || Boolean(getActionSpec(id).sessionTarget);
}

export function getActionContextualDefaults(
  action: ActionId | string | ActionSpec,
  input?: unknown,
): ActionContextualDefaults | null {
  const spec = typeof action === 'string'
    ? (() => {
      const parsed = ActionIdSchema.safeParse(action);
      return parsed.success ? getActionSpec(parsed.data) : null;
    })()
    : action;
  if (!spec) return null;
  if (isSourceQualifiedLocalServicePreviewActionInput(spec.id, input)) return null;
  return spec.contextualDefaults ?? null;
}

/**
 * Is `spec` reachable from `surface`? This is the enablement gate for the whole Action catalog:
 * it backs `createActionExecutor`'s `isActionEnabledBySurface` and both MCP tool bridges.
 *
 * It fails CLOSED on a nullish or unknown surface (INV-1). An unattributed caller is not a
 * wildcard — surface attribution is owned by the host that constructs the executor
 * (`createCliActionExecutor` stamps `'cli'`, `createDefaultActionExecutor` stamps `'ui'`, the
 * MCP servers stamp `'agent'`/`'mcp'`, the RPC adapter stamps `'rpc'`, external ingress stamps
 * `'api'`), so a missing surface means the host forgot, not that every surface is permitted.
 * This resolves the same direction as the consent layer, which already treats an unresolvable
 * surface as `ambiguous` and applies the agent approval floor
 * (`actionApprovalPolicy.ts#resolveApprovalSurface`).
 *
 * Callers that mean "no surface filter requested" must short-circuit before calling this
 * (see `actionCatalog.ts`, which guards every use with `params.surface && …`). That is a
 * different question from "may an unknown caller reach this Action".
 */
export function isActionSpecSurfacedOn(spec: ActionSpec, surface: keyof ActionSurfaces | null | undefined): boolean {
  if (!surface) return false;
  return spec.surfaces[surface] === true;
}

export function listActionSpecsForSurface(surface: keyof ActionSurfaces): readonly ActionSpec[] {
  return ACTION_SPECS.filter((spec) => isActionSpecSurfacedOn(spec, surface));
}

export type ActionCliCommandDeclaration = Readonly<{
  spec: ActionSpec;
  binding: ActionCliCommandBinding;
}>;

/**
 * Every friendly CLI path the catalog declares, flattened for the one CLI
 * compiler. Ordering follows the catalog so a compiled command list is stable.
 */
export function listActionCliCommandDeclarations(): readonly ActionCliCommandDeclaration[] {
  return Object.freeze(ACTION_SPECS.flatMap((spec) => (
    (spec.cli?.commands ?? []).map((binding) => Object.freeze({ spec, binding }))
  )));
}

/**
 * A command path has exactly one admitted Action owner. Two Actions claiming the
 * same spelling is a declaration defect, not a dispatch-time tiebreak, so it
 * fails at catalog load rather than silently letting the first one win.
 */
function assertActionCliCommandPathsAreUnique(
  declarations: readonly ActionCliCommandDeclaration[],
): void {
  const ownerByPath = new Map<string, ActionId>();
  for (const { spec, binding } of declarations) {
    const path = binding.path.join(' ');
    const existing = ownerByPath.get(path);
    if (existing) {
      throw new Error(
        `Action CLI command path "${path}" is declared by both ${existing} and ${spec.id}`,
      );
    }
    ownerByPath.set(path, spec.id);
  }
}

assertActionCliCommandPathsAreUnique(listActionCliCommandDeclarations());

export function listVoiceToolActionSpecs(): readonly ActionSpec[] {
  return listActionSpecsForSurface('voice').filter((spec) => Boolean(spec.bindings?.voiceClientToolName));
}

export { describeActionForVoiceTool } from './actionVoiceToolSummary.js';

/**
 * Canonical tool projection for provider SDK callbacks that cannot retain a
 * stable host call/result identity across reconnects. Such callbacks may
 * expose only none/read actions and must never advertise mutations.
 */
export function isVoiceSdkSafeActionSpec(spec: Pick<ActionSpec, 'sideEffectClass'>): boolean {
  return spec.sideEffectClass === 'none' || spec.sideEffectClass === 'read';
}

/** Effect projection only: it grants no authority and never admits a replay. */
export function isReadOnlyMachineRpcMethod(method: string): boolean {
  const governance = resolveMachineRpcGovernance(method);
  if (governance.rpcClassification === 'action_spec_bound') {
    const actionId = ActionIdSchema.safeParse(governance.actionSpecId);
    return actionId.success && isVoiceSdkSafeActionSpec(getActionSpec(actionId.data));
  }
  return governance.readOnly === true;
}

export function listVoiceSdkSafeToolActionSpecs(): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter(isVoiceSdkSafeActionSpec);
}

export function isVoicePromptHotPathSpec(spec: Pick<ActionSpec, 'prompting'>): boolean {
  return spec.prompting?.voiceHotPath === true;
}

export function listVoicePromptHotPathSpecs(): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter(isVoicePromptHotPathSpec);
}

export function listVoiceActionBlockSpecs(): readonly ActionSpec[] {
  return listActionSpecsForSurface('voice').filter((spec) => Boolean(spec.bindings?.voiceClientToolName));
}

export function listVoiceClientToolNames(): readonly string[] {
  const names = listVoiceToolActionSpecs()
    .map((spec) => String(spec.bindings?.voiceClientToolName ?? '').trim())
    .filter((name) => name.length > 0);
  names.sort();
  return names;
}

export function resolveVoiceClientToolNameAlias(value: string): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;

  for (const spec of listVoiceToolActionSpecs()) {
    const toolName = String(spec.bindings?.voiceClientToolName ?? '').trim();
    if (!toolName) continue;
    if (toolName === normalized || spec.id === normalized) return toolName;
  }

  return null;
}
export { requiresExplicitScmMachineTarget } from './scmGitActionSpecs.js';
