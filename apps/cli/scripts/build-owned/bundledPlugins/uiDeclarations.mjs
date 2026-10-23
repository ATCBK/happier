/** Semantic bundled UI projection. The app inventory supplies compiler facts,
 * while the build-owned declaration projector owns their interpretation. */
export async function projectBundledPluginUiDeclaration({ packageName, packageVersion, manifest, artifactGraphs }) {
  const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
  const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui');
  const { normalizePluginAccountCollectionContractsV1 } = await import('@happier-dev/protocol/plugins/data/collectionsV1');
  const { normalizeStrictJsonValue } = await import('@happier-dev/protocol/json/strictJsonValue');
  const declaration = PluginPortableReleaseManifestV1Schema.safeParse(manifest);
  if (!declaration.success) return undefined;
  const normalizedManifest = { ...declaration.data, version: packageVersion };
  // JSON publication must not silently omit opaque schema members (for
  // example enum: undefined) and thereby change their authored meaning.
  normalizeStrictJsonValue(normalizedManifest);
  const pluginId = normalizedManifest.id;
  return {
    pluginId, pluginVersion: packageVersion, packageName,
    displayName: typeof normalizedManifest.displayName === 'string' ? normalizedManifest.displayName : normalizedManifest.displayName.fallback,
    normalizedManifest,
    artifactGraphs,
    declaredExecution: {
      daemonActions: normalizedManifest.contributes.actions?.some(action => !action.execution || action.execution.target === 'daemon') === true,
      contributionPoints: (normalizedManifest.contributes.pluginContributionPoints?.length ?? 0) > 0,
    },
    entriesById: projectPluginPortableUiDeclarationsV1(normalizedManifest, artifactGraphs),
    collectionContracts: normalizePluginAccountCollectionContractsV1({ pluginId,
      contributions: normalizedManifest.contributes.accountCollections }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) =>
      ({ pluginId, collectionId, schemaVersion, contractDigest })),
  };
}
