import { describe, expect, it } from 'vitest';

import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '../../browser/index.js';
import * as publicBuildApi from './index.js';

describe('public plugin UI build contract', () => {
    it('keeps the daemon-owned universal compiler out of the public author surface', () => {
        expect(Object.keys(publicBuildApi).sort()).toEqual([
            'PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1',
            'PublicToolchainCompatibilityV1Schema',
            'createPublicToolchainCompatibilityV1',
            'createPublicToolchainScaffoldBindingsV1',
            'createZodMiniEnglishLocaleCompilerPlugin',
        ].sort());
        expect(publicBuildApi).not.toHaveProperty('buildUniversalPluginUiArtifacts');
    });

    it('keeps the generated packet browser-safe and derives scaffold dependencies from it', () => {
        expect(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1).toMatchObject({
            schemaVersion: 1,
            ui: { artifactGrammarVersion: 2 },
        });
        expect(publicBuildApi.PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1).toEqual(
            publicBuildApi.createPublicToolchainScaffoldBindingsV1(
                PUBLIC_TOOLCHAIN_COMPATIBILITY_V1,
            ),
        );
        expect(publicBuildApi).not.toHaveProperty('PUBLIC_TOOLCHAIN_COMPATIBILITY_V1');
        expect(Object.isFrozen(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1)).toBe(true);
        expect(Object.isFrozen(publicBuildApi.PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1)).toBe(true);
    });
});
