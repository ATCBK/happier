import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { computeCanonicalDomainSeparatedHexDigest } from '../../crypto/canonicalDigest.js';
import type { PluginUiArtifactDigestV1 } from '../ui/artifactIntegrity.js';
import type { PluginSourceCustodyV1 } from '../runtime/sourceCustody.js';
import { PluginPortableReleaseManifestV1Schema, type PluginPortableReleaseManifestV1 } from './compatibilityProjectionV1.js';
import { normalizePluginReleaseFactsV1, type PluginAccountAvailabilityIntentReadResponseV1, type PluginReleaseFactsV1 } from './v1.js';

/** Cross-host declaration correspondence, independent of each host's executable bytes. */
export function computePluginAccountBundledDeclarationDigestV1(
  manifest: PluginPortableReleaseManifestV1,
): `sha256:${string}` {
  return `sha256:${computeCanonicalDomainSeparatedHexDigest('happier.plugin.account.declaration.v1', [
    createCanonicalJsonSigningInput(PluginPortableReleaseManifestV1Schema.parse(manifest)),
  ])}`;
}

/** Content custody changes for declaration-only edits as well as portable bundle changes. */
export function computePluginAccountBundledCustodyIdV1(input: Readonly<{
  packageName: string;
  manifest: PluginPortableReleaseManifestV1;
  artifacts: readonly Readonly<{ artifactId: string; digest: PluginUiArtifactDigestV1 }>[];
}>): string {
  return computeCanonicalDomainSeparatedHexDigest('happier.plugin.account.bundled-custody.v1', [
    createCanonicalJsonSigningInput({ packageName: input.packageName,
      declarationDigest: computePluginAccountBundledDeclarationDigestV1(input.manifest),
      artifacts: input.artifacts.map(({ artifactId, digest }) => ({ artifactId, digest }))
        .sort((left, right) => left.artifactId.localeCompare(right.artifactId)
        || left.digest.localeCompare(right.digest)),
    }),
  ]);
}

export type PluginAccountExecutionSelectionV1 =
  | Readonly<{
      kind: 'available';
      manifest: PluginPortableReleaseManifestV1;
      sourceCustody: PluginSourceCustodyV1;
      custodyId: string;
      release: PluginReleaseFactsV1 | null;
    }>
  | Readonly<{
      kind: 'unavailable';
      code: 'plugin_disabled' | 'plugin_release_unavailable' | 'plugin_account_execution_unavailable';
    }>;

/**
 * One Account selection policy for invoking hosts. Callers prove the captured
 * Account read is loaded; this owner never treats a Machine occurrence as custody.
 */
export function resolvePluginAccountExecutionSelectionV1(input: Readonly<{
  pluginId: string;
  intentRead: PluginAccountAvailabilityIntentReadResponseV1 | null;
  bundled?: Readonly<{
    manifest: PluginPortableReleaseManifestV1;
    sourceCustody: PluginSourceCustodyV1;
    custodyId: string;
  }>;
}>): PluginAccountExecutionSelectionV1 {
  const intent = input.intentRead?.intent;
  if (intent && intent.pluginId !== input.pluginId) {
    return { kind: 'unavailable', code: 'plugin_release_unavailable' };
  }
  if (intent?.enabled === false) return { kind: 'unavailable', code: 'plugin_disabled' };
  if (intent?.desiredVersion) {
    const release = input.intentRead?.release;
    if (!release || release.ref.pluginId !== input.pluginId || release.ref.version !== intent.desiredVersion) {
      return { kind: 'unavailable', code: 'plugin_release_unavailable' };
    }
    const normalized = normalizePluginReleaseFactsV1(release);
    const sourceCustody: PluginSourceCustodyV1 = Object.freeze({
      kind: 'account_release', pluginId: normalized.ref.pluginId,
      version: normalized.ref.version, archiveDigestSha256: normalized.archiveDigestSha256,
    });
    return Object.freeze({ kind: 'available', manifest: normalized.normalizedManifest,
      sourceCustody, custodyId: createCanonicalJsonSigningInput(sourceCustody), release: normalized });
  }
  if (!input.bundled || input.bundled.manifest.id !== input.pluginId
    || input.bundled.sourceCustody.kind !== 'bundled_first_party' || !input.bundled.custodyId.trim()) {
    return { kind: 'unavailable', code: 'plugin_account_execution_unavailable' };
  }
  return Object.freeze({ kind: 'available',
    manifest: PluginPortableReleaseManifestV1Schema.parse(input.bundled.manifest),
    sourceCustody: input.bundled.sourceCustody, custodyId: input.bundled.custodyId, release: null });
}
