import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS, BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from '../../../../../cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { resolveBundledAgentIdFromPluginId } from '@/agents/catalog/resolveBundledAgentIdFromContributionIdentity';
import { lightTheme } from '@/theme';

it('every bundled first-party plugin declares a mark that resolves to packaged bytes or its declared Agent artwork', async () => {
  const missing: string[] = [];
  for (const locator of BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS) {
    const ingestion = ingestPluginManifestV2(JSON.parse(readFileSync(
      resolve(import.meta.dirname, '../../../../../cli', locator.manifestRelativePath), 'utf8',
    )));
    if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
    const manifest = ingestion.manifest;
    if (manifest.brand) {
      const resource = manifest.contributes.resources.find(entry => entry.id === manifest.brand!.iconResourceId);
      expect(resource?.kind, manifest.id).toBe('asset');
      if (!resource || !('path' in resource)) throw new Error(`Missing brand Resource: ${manifest.id}`);
      expect(resource.contentType, manifest.id).toBe('image/png');
      const directory = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find(entry => entry.pluginId === manifest.id)?.pluginPackageId;
      if (!directory) throw new Error(`Missing bundled package: ${manifest.id}`);
      const root = resolve(import.meta.dirname, '../../../../../../packages/plugins', directory);
      const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { files?: string[] };
      expect(packageJson.files, manifest.id).toContain(resource.path.split('/')[0]);
      const image = sharp(readFileSync(resolve(root, resource.path)));
      expect((await image.metadata()).format, manifest.id).toBe('png');
      const decoded = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(decoded.info.width, manifest.id).toBe(decoded.info.height);
      expect(decoded.data.some((value, index) => index % 4 === 3 && value > 0), manifest.id).toBe(true);
      continue;
    }
    const agentId = resolveBundledAgentIdFromPluginId(manifest.id);
    if (!agentId || !hasAgentIconMark(agentId, lightTheme)) missing.push(manifest.id);
  }
  expect(missing, `Missing plugin marks: ${missing.join(', ')}`).toEqual([]);
});
