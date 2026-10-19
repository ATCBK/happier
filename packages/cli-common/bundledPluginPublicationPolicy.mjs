// Host-owned imports and direct runtime staging require these packages even when
// their generated bundled-plugin locator is absent. Review this set whenever a
// host adds or removes a first-party executable dependency, including generated
// Voice activation imports. Data-only projections do not make a package required.
export const REQUIRED_BUNDLED_PLUGIN_PACKAGES = Object.freeze([
  '@happier-dev/plugins-codex',
  '@happier-dev/plugins-elevenlabs',
  '@happier-dev/plugins-openai',
  '@happier-dev/plugins-xai',
]);

export const BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH = '.project/tmp/bundled-plugin-publication/failures.json';

export const BUNDLED_PLUGIN_PUBLICATION_DIAGNOSTIC_CODES = Object.freeze([
  'plugin_package_build_failed',
  'plugin_manifest_invalid',
  'plugin_ui_artifact_invalid',
]);

const requiredPackages = new Set(REQUIRED_BUNDLED_PLUGIN_PACKAGES);
const publicationDiagnosticCodes = new Set(BUNDLED_PLUGIN_PUBLICATION_DIAGNOSTIC_CODES);

export function parseBundledPluginPublicationFailures(raw) {
  const failures = JSON.parse(raw);
  if (!Array.isArray(failures) || !failures.every((failure) => (
    failure && typeof failure === 'object'
    && typeof failure.packageName === 'string'
    && failure.packageName.startsWith('@happier-dev/plugins-')
    && typeof failure.pluginId === 'string' && failure.pluginId.trim()
    && failure.diagnostic && typeof failure.diagnostic === 'object'
    && publicationDiagnosticCodes.has(failure.diagnostic.code)
    && typeof failure.diagnostic.message === 'string'
    && failure.diagnostic.message.trim()
    && Buffer.byteLength(failure.diagnostic.message, 'utf8') <= 2_048
  ))) {
    throw new Error('Invalid bundled plugin publication failures');
  }
  return failures;
}

export function isRequiredBundledPluginPackage(packageName) {
  return requiredPackages.has(packageName);
}

export function assertHostCanExcludeBundledPlugin(_repoRoot, packageName, originalError) {
  if (!isRequiredBundledPluginPackage(packageName)) return;
  const detail = originalError instanceof Error ? originalError.message : String(originalError ?? '').trim();
  throw new Error(
    `Bundled plugin '${packageName}' is required by host code${detail ? `: ${detail}` : ''}`,
    originalError instanceof Error ? { cause: originalError } : undefined,
  );
}
