import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { computeCanonicalDomainSeparatedHexDigest } from '../../crypto/canonicalDigest.js';
import type { PluginUiArtifactDigestV1 } from '../ui/artifactIntegrity.js';
import type { PluginSourceCustodyV1 } from '../runtime/sourceCustody.js';
import type { PluginPortableReleaseManifestV1 } from './compatibilityProjectionV1.js';
import type { PluginAccountAvailabilityIntentReadResponseV1, PluginReleaseFactsV1 } from './v1.js';

/** Cross-host correspondence of the canonical manifest parser's output,
 * independent of each host's executable bytes. Acquisition/selection already
 * parses this typed value; hashing must not repeat the whole contribution walk.
 */
export function computePluginAccountBundledDeclarationDigestV1(
  manifest: PluginPortableReleaseManifestV1,
): `sha256:${string}` {
  return `sha256:${computeCanonicalDomainSeparatedHexDigest('happier.plugin.account.declaration.v1', [
    createCanonicalJsonSigningInput(manifest),
  ])}`;
}

type PluginAccountBundledCustodyInput = Readonly<{
  packageName: string;
  manifest: PluginPortableReleaseManifestV1;
  artifacts: readonly Readonly<{ artifactId: string; digest: PluginUiArtifactDigestV1 }>[];
}>;

/** One immutable declaration acquisition supplies both content correspondence and custody. */
export function computePluginAccountBundledCustodyV1(input: PluginAccountBundledCustodyInput): Readonly<{
  declarationDigest: `sha256:${string}`;
  custodyId: string;
}> {
  const declarationDigest = computePluginAccountBundledDeclarationDigestV1(input.manifest);
  const custodyId = computeCanonicalDomainSeparatedHexDigest('happier.plugin.account.bundled-custody.v1', [
    createCanonicalJsonSigningInput({ packageName: input.packageName,
      declarationDigest,
      artifacts: input.artifacts.map(({ artifactId, digest }) => ({ artifactId, digest }))
        .sort((left, right) => left.artifactId.localeCompare(right.artifactId)
        || left.digest.localeCompare(right.digest)),
    }),
  ]);
  return Object.freeze({ declarationDigest, custodyId });
}

/** Content custody changes for declaration-only edits as well as portable bundle changes. */
export function computePluginAccountBundledCustodyIdV1(input: PluginAccountBundledCustodyInput): string {
  return computePluginAccountBundledCustodyV1(input).custodyId;
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
 * One Account selection policy for invoking hosts. Acquisition validates and
 * snapshots canonical release facts; callers prove the captured Account read is
 * loaded. This policy runs afresh without repeating that immutable acquisition.
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
    const sourceCustody: PluginSourceCustodyV1 = Object.freeze({
      kind: 'account_release', pluginId: release.ref.pluginId,
      version: release.ref.version, archiveDigestSha256: release.archiveDigestSha256,
    });
    return Object.freeze({ kind: 'available', manifest: release.normalizedManifest,
      sourceCustody, custodyId: createCanonicalJsonSigningInput(sourceCustody), release });
  }
  if (!input.bundled || input.bundled.manifest.id !== input.pluginId
    || input.bundled.sourceCustody.kind !== 'bundled_first_party' || !input.bundled.custodyId.trim()) {
    return { kind: 'unavailable', code: 'plugin_account_execution_unavailable' };
  }
  return Object.freeze({ kind: 'available',
    // Acquisition already parsed this typed declaration. Currentness checks run
    // per host method; rewalking/cloning its contribution graph stalls the UI.
    manifest: input.bundled.manifest,
    sourceCustody: input.bundled.sourceCustody, custodyId: input.bundled.custodyId, release: null });
}
