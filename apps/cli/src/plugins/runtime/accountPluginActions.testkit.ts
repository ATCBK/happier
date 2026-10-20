import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema,
    normalizePluginReleaseFactsV1 } from '@happier-dev/protocol/plugins/availability';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1,
    createPluginUiArtifactArchiveV1, encodePluginUiArtifactArchiveBodyV1, PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectVerifiedPluginUiReleaseSlotsV2 } from '@/plugins/availability/releaseFacts';
import { registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { compileUniversalPluginUiCommonJs } from '../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler';
import { readWorkspacePackages, packageNameOfSpecifier, resolveWorkspaceSource } from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { manifest as authoredAccountManifest } from '../../../../../packages/plugin-sdk/fixtures/account-actions/src/index';

/** Real public-author compiler and release producers, with only Home HTTP storage replaced. */
export async function registerAuthoredAccountActionRelease(app: FastifyInstance, accountId: string) {
    const pluginId = authoredAccountManifest.id;
    const artifactId = 'a7e5d73f-88a7-44bc-98ed-23edbffb6214';
    const manifest = normalizePluginManifestV2(authoredAccountManifest);
    const projectRoot = resolve(import.meta.dirname, '../../../../../packages/plugin-sdk/fixtures/account-actions');
    const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../..'));
    const compiled = await compileUniversalPluginUiCommonJs({ projectRoot, entryPath: join(projectRoot, 'src/index.ts'),
        artifactId: 'account-runtime', requestedExports: ['manifest', 'activate'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined });
    const bytes = compiled.bytes;
    const entry = 'react-native/account-runtime/entry.cjs.bundle';
    const files = [{ relativePath: entry, bytes }];
    const generated = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: [{
        artifactId: 'account-runtime', tier: 'reactNative', entry,
        files: [{ relativePath: entry, byteSize: bytes.length, digest: computePluginUiArtifactSha256DigestV1(bytes) }],
        digest: computePluginUiArtifactFileSetSha256DigestV1(files), builtWith: { bundler: 'esbuild', version: '0.27.2' },
        executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0' }] });
    const archive = createPluginUiArtifactArchiveV1({ pluginId, artifactGraph: generated.entries[0], files });
    if (!archive) throw new Error('invalid canonical fixture');
    const release = normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version },
        archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest, collectionContracts: [],
        uiSlots: projectVerifiedPluginUiReleaseSlotsV2({ manifest, generatedUiArtifacts: generated }),
        packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] } });
    let enabled = true;
    const response = () => PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
        hostingCapability: { enabled: false }, intent: { pluginId, desiredVersion: manifest.version, enabled,
            offlineUiHosting: 'disabled', revision: '1', writableCollections: [] }, release,
        uiArtifacts: release.uiSlots.map(slot => ({ release: release.ref, contributionId: slot.contributionId,
            artifactId: slot.artifactId, tier: slot.tier, platform: slot.platform,
            artifactDigest: slot.artifactDigest, hostUiApiRange: slot.hostUiApiRange, accountArtifactId: artifactId })), packageAssets: [] });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async () => ({
        availabilityCursor: 1, pluginIds: [pluginId], intentReads: [{ pluginId, response: response() }], failedPluginIds: [] }));
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () => response());
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    artifacts.seed(artifactId, encodePlainArtifactStoredContent(archive.header),
        encodePlainArtifactStoredContent({ body: encodePluginUiArtifactArchiveBodyV1(archive.body) }));
    return { pluginId, manifest, artifacts, setEnabled: (value: boolean) => { enabled = value; } };
}
