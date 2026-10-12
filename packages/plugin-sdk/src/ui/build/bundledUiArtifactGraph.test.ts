import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS } from '@happier-dev/protocol/plugins/ui';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../../cli-common/sourceRuntimeEntries.mjs';
import { buildUniversalPluginUiArtifacts } from './buildUniversalUiArtifacts.js';
import { discoverExecutablePluginUiArtifacts } from './manifestArtifactDiscovery.js';
import { compileUniversalPluginUiCommonJs } from './universalCommonJsCompiler.js';

const pluginNames = ['channels', 'inspector', 'posthog', 'scm-azure-devops', 'scm-bitbucket', 'scm-github', 'scm-gitlab', 'sentry', 'triage'];

describe('bundled Plugin UI artifact graph', () => {
    it.each(pluginNames)('publishes and evaluates every declared %s executable through the canonical source compiler', async (plugin) => {
        const repositoryRoot = resolve(import.meta.dirname, '../../../../..');
        const packages = await readWorkspacePackages(repositoryRoot);
        const scratch = await mkdtemp(join(tmpdir(), 'happier-plugin-ui-artifact-graph-'));
        const resolveSourceImport = (specifier: string) => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native'] }) : undefined;
        // Host UI is outside the compiler process. This evaluation-only boundary
        // supplies framework namespaces; rendering remains the surface owner's gate.
        const hostUi = new Proxy({}, { get: (_target, property) => property === '__esModule' ? true
            : property === 'defineUiSurface' ? (surface: unknown) => surface : () => undefined });
        const requireHost = (specifier: string) => {
            if (!(PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS as readonly string[]).includes(specifier)) {
                throw new Error(`Unexpected require: ${specifier}`);
            }
            return specifier === 'react' ? React : hostUi;
        };
        try {
            const projectRoot = join(repositoryRoot, 'packages/plugins', plugin);
            const authored = await import(pathToFileURL(join(projectRoot, 'src/manifest.ts')).href);
            const manifestPath = join(scratch, `${plugin}.json`);
            await writeFile(manifestPath, JSON.stringify(authored.PLUGIN_MANIFEST), 'utf8');
            const declarations = await discoverExecutablePluginUiArtifacts(projectRoot, manifestPath, ['happier-source']);
            const outputDir = join(scratch, plugin);
            const publication = await buildUniversalPluginUiArtifacts(projectRoot, manifestPath, {
                outputDir, exportConditions: ['happier-source'], resolveSourceImport,
            });
            const executableEntries = publication.manifest.entries.filter(entry => entry.tier === 'reactNative');
            expect(executableEntries.map(entry => entry.artifactId).sort()).toEqual(declarations.map(entry => entry.artifactId).sort());
            for (const declaration of declarations) {
                const compiled = await compileUniversalPluginUiCommonJs({
                    ...declaration, projectRoot, exportConditions: ['happier-source'], resolveSourceImport,
                });
                const artifact = executableEntries.find(entry => entry.artifactId === declaration.artifactId)!;
                const bytes = await readFile(join(outputDir, artifact.entry));
                expect(bytes.byteLength).toBe(artifact.files[0].byteSize);
                const retained = Object.values(compiled.metafile.outputs).flatMap(output =>
                    Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0));
                const libraries = Object.fromEntries(['protocol', 'zod', 'ajv', 'ajv-formats', 'semver', 'tweetnacl', '@noble'].map(name => [name,
                    retained.filter(([path]) => path.replaceAll('\\', '/').includes(`/${name}/`))
                        .reduce((total, [, input]) => total + input.bytesInOutput, 0),
                ]));
                const imports = Object.entries(compiled.metafile.inputs).flatMap(([path, input]) =>
                    input.imports.filter(edge => edge.original?.startsWith('@happier-dev/')
                        && /(?:^src\/ui\/|plugins\/.+\/src\/ui\/|triage-sources\/src\/|plugin-sdk\/src\/(?:protocol|actions)\/)/u.test(path))
                        .map(edge => ({ importer: path, specifier: edge.original, target: edge.path })));
                const protocolInputs = retained.filter(([path]) => path.includes('/protocol/'))
                    .sort((left, right) => right[1].bytesInOutput - left[1].bytesInOutput).slice(0, 8);
                const heavyEdges = Object.entries(compiled.metafile.inputs).flatMap(([path, input]) =>
                    input.imports.filter(edge => /(?:actionSpecs|jsonSchemaValidation|ed25519)\.(?:ts|js)$/u.test(edge.path))
                        .map(edge => ({ importer: path, specifier: edge.original, target: edge.path })));
                console.log('PLUGIN_UI_GRAPH', JSON.stringify({ plugin, artifactId: artifact.artifactId,
                    bytes: bytes.byteLength, libraries, imports, protocolInputs, heavyEdges }));
                const module = { exports: {} as Record<string, unknown> };
                runInNewContext(bytes.toString('utf8'), { module, exports: module.exports, require: requireHost,
                    TextEncoder, TextDecoder, URL, AbortController, console });
                for (const name of declaration.requestedExports) {
                    expect(module.exports[name], `${plugin}/${artifact.artifactId}:${name}`).toBeTypeOf('function');
                }
            }
        } finally {
            await rm(scratch, { recursive: true, force: true });
        }
    }, 120_000);
});
