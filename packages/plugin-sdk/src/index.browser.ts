export type { ActionOperationDeclarationV1 } from './definePlugin.js';
export type { PluginAccountApi, PluginAccountActivationModule } from './activation.js';
export type { DefinePluginInput } from './definePlugin.js';
export type { DefinedPlugin } from './definePlugin.js';
export type { DefinedPluginActionContracts } from './definePlugin.js';
export type { DefinedPluginContributes } from './definePlugin.js';
export type { DefinedPluginManifest } from './definePlugin.js';
export type {
    PluginCaptureSourceDefinition,
    PluginConnectedAccountDefinition,
    ReadonlyAuthorDeclaration,
} from './definePlugin.js';
export type {
    EntityDragItemV1,
    EntityDragKindV1,
    EntityDragScopeV1,
    EntityDropAdmissionV1,
    EntityDropEffectV1,
    EntityDropOutcomeV1,
    EntityDropPreviewV1,
    EntityDropReasonV1,
    PluginDragSourceRuntime,
    PluginDropTargetRuntime,
} from './entityDragDrop.js';
export type {
    PluginCaptureCodecIdV1,
    PluginCaptureFrameV1,
    PluginCaptureReceiptV1,
    PluginCaptureSourceDeclaration,
    PluginCaptureSourceRuntime,
} from './captureSources.js';
export type {
    PluginDragSourceContributionV1,
    PluginDropTargetContributionV1,
    PluginInputTypeReferenceV1,
    PluginProjectNativeAdapterContributionV1,
    PluginWorkflowContributionV1,
} from './manifest.js';
export type {
    PluginProjectNativeAdapterDeclarationV1,
    PluginProjectNativeAdapterDefinitionV1,
    PluginProjectNativeAdapterRuntimeV1,
    PluginProjectNativeCommandRequestV1,
    PluginProjectNativeCommandResultV1,
    PluginProjectNativeCommandV1,
    PluginProjectNativeEnvironmentRequestV1,
    PluginProjectNativeEnvironmentResultV1,
    PluginProjectNativeFailureV1,
    PluginProjectNativeFileFactV1,
    PluginProjectNativeInspectionV1,
    ProjectDefinitionDetectionV1,
    ProjectEnvironmentSelectionV1,
    ProjectNativeAdapterRoleV1,
    ProjectNativeRefV1,
} from './projectNativeAdapters.js';
export type {
    ComposerAttachmentAuthorDeclaration,
    ComposerAttachmentAuthorDisplay,
    ComposerAttachmentAuthorPreview,
    ComposerControlAuthorInteraction,
    ComposerRendererChainAuthorInput,
    PluginComposerAttachmentDefinition,
    PluginComposerControlDefinition,
    PluginComposerDefinition,
    PluginComposerReferenceDefinition,
    PluginComposerRegionDefinition,
} from './definePlugin.js';
export type {
    ProtocolActionSchemaInput,
    ProtocolActionSchemaOutput,
} from './definePlugin.js';
export type {
    PluginAccountCollectionMigrationRuntimeProjection,
    PluginDaemonDatabaseDeclaration,
    PluginDaemonDatabaseDefinition,
    PluginDaemonDatabaseRuntimeProjection,
} from './definePlugin.js';
export type { Disposable, PluginCancellationOptions } from './lifecycle.js';
export type {
    JsonValue,
    PluginContributionLocalId,
    PluginContributionRef,
    PluginIdentity,
    PluginInvocationContributionIdentity,
    PluginJsonValueV2,
    PluginReference,
} from './identity.js';
export type { PluginClientActivationModule } from './activation.js';
export type { PluginClientApi } from './activation.js';
export type { PluginRequestInterceptorDefinition } from './definePlugin.js';
export type { PluginDiagnosticData } from './diagnostics.js';
export type {
    PluginEphemeralSharedScope,
    PluginEphemeralSharedValueLease,
} from './ephemeralSharedScope.js';
export type { PluginErrorData } from './errors.js';
export type { PluginOperationAvailability, PluginRemediationData } from './availability.js';
export { isPluginError, PluginError } from './errors.js';
export { computeCanonicalDomainSeparatedDigest } from './identity.js';
export { createCanonicalJsonSigningInput } from './identity.js';
export {
  arePluginMachineExecutionOriginsEqual,
  getPluginMachineExecutionOriginRef,
  arePluginMachineMaterializationRefsEqual,
} from './executionOrigin.js';
export { definePlugin } from './definePlugin.js';
export {
    defineComposerAttachment,
    defineComposerControl,
    defineComposerReference,
    defineComposerRegion,
} from './composer.js';
export {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
} from './composer.js';
export type {
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectResultV1,
    ComposerContentMediaKindV1,
    ComposerContentMimeTypeV1,
    ComposerContentPickMediaRequestV1,
    ComposerMediaContentCapabilityV1,
    ComposerSessionMediaContentV1,
    ComposerStagedMediaContentV1,
} from './composer.js';
export { defineUiSurfaceDefinition } from './ui/surface.js';
export type {
    UiSurface,
    UiSurfaceAppPageDefinition,
    UiSurfaceAppPageDefinitionFor,
    UiSurfaceDeclarativeDefinition,
    UiSurfaceDeclarativeRendererDefinition,
    UiSurfaceDefinition,
    UiSurfaceDetailedDefinition,
    UiSurfaceDetailedDefinitionFor,
    UiSurfaceHostedHtmlRendererDefinition,
    UiSurfaceHostedWebDefinition,
    UiSurfaceHostedWebRendererDefinition,
    UiSurfacePlacement,
    UiSurfaceReactNativeDefinition,
    UiSurfaceReactNativeRendererDefinition,
    UiSurfaceRendererDefinition,
    UiSurfaceRendererOnlyDefinition,
    UiSurfaceSettingsPageDefinition,
} from './ui/surface.js';
export type {
    ContributionAdmittedEntry,
    ContributionOperationContracts,
    ContributionSurfaceHandles,
    DefinedContributionPointRef,
    DefinedContributionPoints,
} from './targetedContributionAuthoring.js';
export { ComposerReferenceCandidateIdV1Schema } from './composerReferenceProviders.js';
export {
    MAX_PLUGIN_SEARCH_ITEM_COMMAND_UTF8_BYTES_V1,
    PluginSearchItemV1Schema,
    PluginSearchQueryV1Schema,
    PluginSearchResultV1Schema,
} from './searchProviders.js';
export type {
    ComposerReferenceCandidatePageV1,
    ComposerReferenceResolutionV1,
} from './composerReferenceProviders.js';
export type {
    PluginSearchItemV1,
    PluginSearchProviderContributionV1,
    PluginSearchQueryV1,
    PluginSearchResultV1,
} from './searchProviders.js';
export { selectCurrentTargetedContribution } from './services/targetedContributions.js';
export {
    isRecord,
    parseJsonLine,
    parseTimestampMs,
    readString,
    readTrimmedString,
} from './sessions/fileStores/records.js';
export {
    projectPluginFailureText,
    redactBugReportSensitiveText,
    trimBugReportTextToMaxBytes,
} from './diagnostics.js';
