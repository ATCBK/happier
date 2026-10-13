/** @moduleRealm daemon */
import type {
    PromptAssetBundleRecordV1,
    PromptAssetCapabilitiesV1,
    PromptAssetDefaultRootV1,
    PromptAssetDeleteRequest,
    PromptAssetDiscoverRequest,
    PromptAssetDiscoverResponseV1,
    PromptAssetDiscoveryItemV1,
    PromptAssetDocRecordV1,
    PromptAssetExternalRefV1,
    PromptAssetInstallModeV1,
    PromptAssetLibraryKindV1,
    PromptAssetListTypesResponseV1,
    PromptAssetMutationErrorCodeV1,
    PromptAssetMutationPreviewV1,
    PromptAssetMutationResponseV1,
    PromptAssetReadRequest,
    PromptAssetReadResponseV1,
    PromptAssetScopeV1,
    PromptAssetSupportsScopeV1,
    PromptAssetTypeDescriptor,
    PromptAssetWriteBundleRequest,
    PromptAssetWriteDocRequest,
} from '@happier-dev/protocol';

import type { PluginCancellationOptions } from './lifecycle.js';

/** @realm any */
export type {
    PluginPromptAssetContributionV1 as PromptAssetContribution,
    PluginResourceKind,
    PluginResourceContributionV2 as ResourceContribution,
    PromptAssetTypeDescriptor,
} from '@happier-dev/protocol';
export type {
    PromptAssetDeleteRequest,
    PromptAssetDiscoverRequest,
    PromptAssetReadRequest,
    PromptAssetWriteBundleRequest,
    PromptAssetWriteDocRequest,
    PromptAssetWriteRequest,
} from '@happier-dev/protocol';

export type {
    PluginDynamicResourceRuntime,
    PluginDynamicResourceInvocationOptionsV1,
    PluginResourceContextV1,
    PluginResourceDescriptor as ResourceDescriptor,
    ResourcesService,
} from './services/resources.js';

/** Final `/resources` prompt author projection; publication remains owned by EU-3/EU-4. */
export type PromptAssetScope = PromptAssetScopeV1;
export type PromptAssetLibraryKind = PromptAssetLibraryKindV1;
export type PromptAssetInstallMode = PromptAssetInstallModeV1;
export type PromptAssetSupportsScope = PromptAssetSupportsScopeV1;
/** @realm any */
export type PromptAssetCapabilities = PromptAssetCapabilitiesV1;
export type PromptAssetDefaultRoot = PromptAssetDefaultRootV1;
export type PromptAssetExternalRef = PromptAssetExternalRefV1;
export type PromptAssetDiscoveryItem = PromptAssetDiscoveryItemV1;
export type PromptAssetBundleRecord = PromptAssetBundleRecordV1;
export type PromptAssetDocRecord = PromptAssetDocRecordV1;
export type PromptAssetMutationErrorCode = PromptAssetMutationErrorCodeV1;
export type PromptAssetMutationPreview = PromptAssetMutationPreviewV1;
export type PromptAssetMutationResult = PromptAssetMutationResponseV1;
export type PromptAssetListTypesResult = PromptAssetListTypesResponseV1;
export type PromptAssetDiscoverResult = PromptAssetDiscoverResponseV1;
export type PromptAssetReadResult = PromptAssetReadResponseV1;


export interface PromptAssetAdapter {
    readonly descriptor: PromptAssetTypeDescriptor;
    discover(
        request: PromptAssetDiscoverRequest,
        options?: PluginCancellationOptions,
    ): Promise<readonly PromptAssetDiscoveryItem[]>;
    read(
        request: PromptAssetReadRequest,
        options?: PluginCancellationOptions,
    ): Promise<PromptAssetReadResult>;
    writeDoc(
        request: PromptAssetWriteDocRequest,
        options?: PluginCancellationOptions,
    ): Promise<PromptAssetMutationResult>;
    writeBundle(
        request: PromptAssetWriteBundleRequest,
        options?: PluginCancellationOptions,
    ): Promise<PromptAssetMutationResult>;
    delete(
        request: PromptAssetDeleteRequest,
        options?: PluginCancellationOptions,
    ): Promise<PromptAssetMutationResult>;
}
