import type { Asset } from 'expo-asset';
import type { PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiArtifactsManifestEntryV2 } from '@happier-dev/protocol/plugins/ui';
import type { PluginDeclaredUiEntriesV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

export type PluginHostBundledUiDeclaration = Readonly<{
    pluginId: string;
    pluginVersion: string;
    /** Canonical package custody locator from the app dependency inventory. */
    packageName: string;
    displayName: string;
    entriesById: PluginDeclaredUiEntriesV1;
}>;

/**
 * The immutable app-package projection of one Plugin UI Artifact. Availability
 * remains the owner of selection and currentness; this projection retains the
 * app's first-party UI declarations beside bytes it already contains.
 */
export type BundledPluginUiAppArtifactFile = Readonly<{
    relativePath: string;
    asset: Parameters<typeof Asset.fromModule>[0];
}>;

export type BundledPluginUiAppArtifact = Readonly<{
    pluginId: string;
    artifactId: string;
    tier: 'hostedWeb' | 'reactNative';
    digest: PluginUiArtifactDigestV1;
    releaseVersion: string;
    artifactGraph?: PluginUiArtifactsManifestEntryV2;
    uiDeclaration?: PluginHostBundledUiDeclaration;
    files: readonly BundledPluginUiAppArtifactFile[];
}>;

export type BundledPluginUiAppArtifactInventory = readonly BundledPluginUiAppArtifact[];

/** Manifest-declared packaged marks; descriptive app bytes, never execution authority. */
export type BundledPluginBrandMark = Readonly<{
    pluginId: string;
    displayName: string;
    resourceId: string;
    releaseVersion: string;
    digest: PluginUiArtifactDigestV1;
    bytes: Uint8Array;
    monochrome?: boolean;
}>;
