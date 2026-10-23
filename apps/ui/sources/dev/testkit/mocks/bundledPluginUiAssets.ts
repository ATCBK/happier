import type { BundledPluginUiAppArtifactInventory, PluginHostBundledUiDeclaration } from '@/sync/domains/plugins/availability/bundledPluginUiArtifactInventory';

// Package/Expo asset boundary only: this test app contains no preseeded bundle
// bytes. Artifact selection, source adapters, leases, and catalogs remain real.
export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = Object.freeze([]) satisfies BundledPluginUiAppArtifactInventory;
export const BUNDLED_PLUGIN_UI_APP_DECLARATIONS = Object.freeze([]) satisfies readonly PluginHostBundledUiDeclaration[];
export const BUNDLED_PLUGIN_BRAND_MARKS = Object.freeze([]);

export const emptyBundledPluginUiAssetsModule = Object.freeze({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS,
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS,
    BUNDLED_PLUGIN_BRAND_MARKS,
});
