import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
  packageNameOfSpecifier,
  readWorkspacePackages,
  resolveWorkspaceSource,
} from '../../../cli-common/sourceRuntimeEntries.mjs';
import { compileUniversalPluginUiCommonJs } from '../../../plugin-sdk/src/ui/build/universalCommonJsCompiler.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID } from './observations/githubAutomationEventCheckpoint.js';

describe('the GitHub Collection migration artifact', () => {
  it('compiles its real source closure portably and retains the complete canonical manifest', async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const packages = await readWorkspacePackages(resolve(packageRoot, '../../..'));
    const compiled = await compileUniversalPluginUiCommonJs({
      projectRoot: packageRoot,
      entryPath: 'src/collectionMigrationArtifact.ts',
      artifactId: 'github-collection-migrations',
      requestedExports: ['collectionMigrations'],
      collectionMigrationManifest: { ...PLUGIN_MANIFEST },
      exportConditions: ['happier-source'],
      resolveSourceImport: (specifier) => packages.has(packageNameOfSpecifier(specifier))
        ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    expect(compiled.externalSpecifiers).toEqual([]);
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(new TextDecoder().decode(compiled.bytes), {
      module, exports: module.exports, TextEncoder, TextDecoder,
    });
    const factory = module.exports.collectionMigrations;
    if (typeof factory !== 'function') throw new Error('Missing migration artifact export');
    const payload: unknown = factory();
    expect(payload).toMatchObject({ manifest: PLUGIN_MANIFEST });
    if (typeof payload !== 'object' || payload === null || !('collectionMigrations' in payload)) {
      throw new Error('Missing migration callbacks');
    }
    expect(payload.collectionMigrations).toMatchObject({
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID]: [{
        id: 'automation-event-checkpoints-v1-to-v2', fromSchemaVersion: 1, toSchemaVersion: 2,
        migrate: expect.any(Function),
      }],
    });
  });
});
