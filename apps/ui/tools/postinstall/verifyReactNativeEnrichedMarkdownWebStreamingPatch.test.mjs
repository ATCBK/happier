import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
    REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES,
    REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS,
    findReactNativeEnrichedMarkdownPackageDirs,
    formatReactNativeEnrichedMarkdownWebStreamingPatchFailure,
    verifyReactNativeEnrichedMarkdownWebStreamingPatch,
    verifyUiPatchedDependencies,
} from './verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';

const INSTALLED_PACKAGE_DIR = path.dirname(createRequire(import.meta.url).resolve('react-native-enriched-markdown/package.json'));

const STREAMING_REVEAL_ARTIFACTS = [
    'lib/module/web/streamingReveal.js',
    'lib/module/web/streamingReveal.d.ts',
    'lib/typescript/src/web/streamingReveal.d.ts',
    'src/web/streamingReveal.ts',
];

const PATCHED_TYPE_DECLARATION = 'lib/typescript/src/types/MarkdownStyle.d.ts';
const PATCHED_TYPE_MARKER = 'texMathBackslashDelimiters?: boolean';
const PATCHED_PARSER_MODULE = 'lib/module/web/parseMarkdown.js';
const PARSER_CACHE_DELETE_MARKER = 'parseCache.delete(cacheKey)';
const VISIBILITY_MARKERS = [
    ['src/web/EnrichedMarkdownText.tsx', 'if (syncAst) return;'],
    ['lib/module/web/EnrichedMarkdownText.js', 'if (syncAst) return;'],
    ['src/web/streamingReveal.ts', '.start <= start'],
    ['lib/module/web/streamingReveal.js', '.start <= start'],
];

test('dependency preflight rejects a native renderer retaining its factory', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        const relativePath = 'ios/renderer/StrongRenderer.m';
        const filePath = path.join(fixtureDir, relativePath);
        const original = fs.readFileSync(filePath, 'utf8');
        assert.ok(original.includes('__weak RendererFactory *_rendererFactory;'));
        fs.writeFileSync(filePath, original.replace('__weak RendererFactory *_rendererFactory;', 'RendererFactory *_rendererFactory;'));
        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });
        assert.equal(result.status, 'failed');
        assert.ok(result.missingMarkers.some(([file]) => file === relativePath));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test('UI dependency preflight verifies both app-local and hoisted patched copies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-patched-copy-preflight-'));
    const fixture = createPatchedPackageFixture();
    const uiPackageDir = path.join(root, 'apps', 'ui');
    const appCopy = path.join(uiPackageDir, 'node_modules', 'react-native-enriched-markdown');
    const hoistedCopy = path.join(root, 'node_modules', 'react-native-enriched-markdown');
    try {
        fs.cpSync(fixture, appCopy, { recursive: true });
        fs.cpSync(fixture, hoistedCopy, { recursive: true });
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'patchedDependencies: {}\n');
        assert.doesNotThrow(() => verifyUiPatchedDependencies({ uiPackageDir }));
        fs.unlinkSync(path.join(hoistedCopy, 'lib/module/web/streamingReveal.js'));
        assert.throws(() => verifyUiPatchedDependencies({ uiPackageDir }));
        fs.cpSync(fixture, hoistedCopy, { recursive: true });
        fs.unlinkSync(path.join(appCopy, 'lib/module/web/streamingReveal.js'));
        assert.throws(() => verifyUiPatchedDependencies({ uiPackageDir }));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('UI dependency preflight finds ancestor-hoisted packages and rejects their missing markers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-ancestor-preflight-'));
    const fixture = createPatchedPackageFixture();
    const uiPackageDir = path.join(root, 'apps', 'ui');
    const packageDir = path.join(root, 'apps', 'node_modules', 'react-native-enriched-markdown');
    try {
        fs.mkdirSync(uiPackageDir, { recursive: true });
        fs.cpSync(fixture, packageDir, { recursive: true });
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'patchedDependencies: {}\n');
        assert.doesNotThrow(() => verifyUiPatchedDependencies({ uiPackageDir }));
        fs.mkdirSync(path.join(uiPackageDir, 'node_modules'));
        fs.symlinkSync(packageDir, path.join(uiPackageDir, 'node_modules/react-native-enriched-markdown'),
            process.platform === 'win32' ? 'junction' : 'dir');
        assert.deepEqual(findReactNativeEnrichedMarkdownPackageDirs({ repoRootDir: root, expoAppDir: uiPackageDir }),
            [fs.realpathSync(packageDir)]);
        fs.unlinkSync(path.join(packageDir, 'lib/module/web/streamingReveal.js'));
        assert.throws(() => verifyUiPatchedDependencies({ uiPackageDir }), /streamingReveal/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('UI dependency preflight verifies other patches resolved from an ancestor', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-ancestor-other-patch-'));
    const fixture = createPatchedPackageFixture();
    const uiPackageDir = path.join(root, 'apps', 'ui');
    const packageDir = path.join(root, 'apps', 'node_modules', 'fixture-dependency');
    try {
        fs.cpSync(fixture, path.join(root, 'node_modules/react-native-enriched-markdown'), { recursive: true });
        fs.mkdirSync(uiPackageDir, { recursive: true });
        fs.mkdirSync(packageDir, { recursive: true });
        writePackageManifest(packageDir, 'fixture-dependency');
        fs.mkdirSync(path.join(root, 'patches'));
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'),
            'patchedDependencies:\n  fixture-dependency@1.0.0: patches/fixture.patch\n');
        fs.writeFileSync(path.join(root, 'patches', 'fixture.patch'),
            '--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-unpatched\n+patched\n');
        fs.writeFileSync(path.join(packageDir, 'index.js'), 'unpatched\n');
        assert.throws(() => verifyUiPatchedDependencies({ uiPackageDir }), /fixture-dependency/);
        fs.writeFileSync(path.join(packageDir, 'index.js'), 'patched\n');
        assert.doesNotThrow(() => verifyUiPatchedDependencies({ uiPackageDir }));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('UI dependency preflight verifies other patches even when enriched-markdown is ready', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-all-patches-preflight-'));
    const fixture = createPatchedPackageFixture();
    const uiPackageDir = path.join(root, 'apps', 'ui');
    try {
        fs.cpSync(fixture, path.join(uiPackageDir, 'node_modules/react-native-enriched-markdown'), { recursive: true });
        fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'),
            'patchedDependencies:\n  fixture-dependency@1.0.0: patches/fixture-dependency@1.0.0.patch\n');
        fs.writeFileSync(path.join(root, 'patches', 'fixture-dependency@1.0.0.patch'),
            'diff --git a/index.js b/index.js\n'
            + '--- a/index.js\n+++ b/index.js\n'
            + '@@ -1 +1 @@\n-export const patched = false;\n+export const patched = true;\n'
            + 'diff --git a/feature.js b/feature.js\n'
            + 'new file mode 100644\n--- /dev/null\n+++ b/feature.js\n'
            + '@@ -0,0 +1 @@\n+export const feature = true;\n');
        for (const packageDir of [path.join(root, 'node_modules/fixture-dependency'), path.join(uiPackageDir, 'node_modules/fixture-dependency')]) {
            fs.mkdirSync(packageDir, { recursive: true });
            writePackageManifest(packageDir, 'fixture-dependency');
            fs.writeFileSync(path.join(packageDir, 'index.js'), 'export const patched = true;\n');
            fs.writeFileSync(path.join(packageDir, 'feature.js'), 'export const feature = true;\n');
        }
        assert.doesNotThrow(() => verifyUiPatchedDependencies({ uiPackageDir }));
        const file = path.join(root, 'node_modules/fixture-dependency/index.js');
        fs.writeFileSync(file, 'export const patched = false;\n');
        assert.throws(() => verifyUiPatchedDependencies({ uiPackageDir }), /fixture-dependency/);
        fs.writeFileSync(file, 'export const patched = true;\n');
        fs.writeFileSync(path.join(uiPackageDir, 'node_modules/fixture-dependency/index.js'), 'export const patched = false;\n');
        assert.throws(() => verifyUiPatchedDependencies({ uiPackageDir }), /fixture-dependency/);
        fs.writeFileSync(path.join(uiPackageDir, 'node_modules/fixture-dependency/index.js'), 'export const patched = true;\n');
        fs.writeFileSync(path.join(uiPackageDir, 'node_modules/fixture-dependency/feature.js'), 'export const feature = false;\n');
        assert.throws(() => verifyUiPatchedDependencies({ uiPackageDir }), /fixture-dependency/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('UI dependency preflight ignores a manifest-less cache directory but still verifies installed copies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-cache-dir-preflight-'));
    const fixture = createPatchedPackageFixture();
    const uiPackageDir = path.join(root, 'apps', 'ui');
    const hoistedCopy = path.join(root, 'node_modules', 'fixture-dependency');
    const appLocalDir = path.join(uiPackageDir, 'node_modules', 'fixture-dependency');
    try {
        fs.cpSync(fixture, path.join(root, 'node_modules/react-native-enriched-markdown'), { recursive: true });
        fs.mkdirSync(path.join(root, 'patches'));
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'),
            'patchedDependencies:\n  fixture-dependency@1.0.0: patches/fixture.patch\n');
        fs.writeFileSync(path.join(root, 'patches', 'fixture.patch'),
            '--- a/lib/index.js\n+++ b/lib/index.js\n@@ -1 +1 @@\n-unpatched\n+patched\n');
        fs.mkdirSync(path.join(hoistedCopy, 'lib'), { recursive: true });
        writePackageManifest(hoistedCopy, 'fixture-dependency');
        fs.writeFileSync(path.join(hoistedCopy, 'lib/index.js'), 'patched\n');
        // A tool cache left under the app's node_modules, with no package in it.
        fs.mkdirSync(path.join(appLocalDir, '.worklets'), { recursive: true });
        assert.doesNotThrow(() => verifyUiPatchedDependencies({ uiPackageDir }));

        writePackageManifest(appLocalDir, 'fixture-dependency');
        assert.throws(() => verifyUiPatchedDependencies({ uiPackageDir }), /fixture-dependency/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

function createPatchedPackageFixture() {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enriched-markdown-patch-fixture-'));
    const markersByFile = new Map();
    for (const [relativePath, marker, minOccurrences = 1] of REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS) {
        const markers = markersByFile.get(relativePath) ?? [];
        markers.push(...Array.from({ length: minOccurrences }, () => marker));
        markersByFile.set(relativePath, markers);
    }
    for (const relativePath of REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES) {
        const filePath = path.join(fixtureDir, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, (markersByFile.get(relativePath) ?? []).join('\n'), 'utf8');
    }
    writePackageManifest(fixtureDir, 'react-native-enriched-markdown');
    return fixtureDir;
}

function writePackageManifest(packageDir, name) {
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
}

test('dependency preflight rejects an installed eager math loader', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        const file = 'lib/module/web/katex.js';
        fs.mkdirSync(path.dirname(path.join(fixtureDir, file)), { recursive: true });
        fs.writeFileSync(path.join(fixtureDir, file), "export const loadKaTeX = () => Promise.resolve(require('katex'));\n");
        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });
        assert.equal(result.status, 'failed');
        assert.ok(result.missingMarkers.some(([relativePath]) => relativePath === file));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});
test('installed app-local enriched-markdown materializes every patch-owned streaming-reveal artifact', () => {
    const missing = STREAMING_REVEAL_ARTIFACTS.filter(
        (relativePath) => !fs.existsSync(path.join(INSTALLED_PACKAGE_DIR, relativePath)),
    );

    assert.deepEqual(missing, []);

    const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: INSTALLED_PACKAGE_DIR });
    assert.equal(result.status, 'ok', formatReactNativeEnrichedMarkdownWebStreamingPatchFailure(result));
});

test('DISCRIMINATES: the package type entrypoint exposes the patch-owned TeX flag', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        const declarationPath = path.join(fixtureDir, PATCHED_TYPE_DECLARATION);
        fs.mkdirSync(path.dirname(declarationPath), { recursive: true });
        fs.writeFileSync(declarationPath, 'export interface Md4cFlags { latexMath?: boolean; }', 'utf8');

        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });

        assert.equal(result.status, 'failed');
        assert.ok(result.missingMarkers.some(([relativePath, marker]) => (
            relativePath === PATCHED_TYPE_DECLARATION && marker === PATCHED_TYPE_MARKER
        )));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test('DISCRIMINATES: an installed package missing patch-owned source/types cannot be certified from its built module alone', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        fs.rmSync(path.join(fixtureDir, 'src', 'web', 'streamingReveal.ts'));
        fs.rmSync(path.join(fixtureDir, 'lib', 'typescript', 'src', 'web', 'streamingReveal.d.ts'));

        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });

        assert.equal(result.status, 'failed');
        assert.deepEqual(
            result.missingFiles.filter((relativePath) => STREAMING_REVEAL_ARTIFACTS.includes(relativePath)).sort(),
            ['lib/typescript/src/web/streamingReveal.d.ts', 'src/web/streamingReveal.ts'],
        );
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test('DISCRIMINATES: the public splitter export must be present in the built module the plain-text consumer imports', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        const builtModulePath = path.join(fixtureDir, 'lib', 'module', 'web', 'streamingReveal.js');
        const original = fs.readFileSync(builtModulePath, 'utf8');
        fs.writeFileSync(builtModulePath, original.replaceAll('splitStreamingRevealTextParts', 'removedStreamingRevealSplitter'), 'utf8');

        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });

        assert.equal(result.status, 'failed');
        assert.ok(result.missingMarkers.some(([relativePath, marker]) => (
            relativePath === 'lib/module/web/streamingReveal.js' && marker === 'splitStreamingRevealTextParts'
        )));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test('DISCRIMINATES: all four parser cache-cleanup branches remain installed', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        const parserPath = path.join(fixtureDir, PATCHED_PARSER_MODULE);
        const parserContents = fs.readFileSync(parserPath, 'utf8');
        fs.writeFileSync(
            parserPath,
            `${parserContents.replaceAll(PARSER_CACHE_DELETE_MARKER, '')}\n${PARSER_CACHE_DELETE_MARKER}\n`,
            'utf8',
        );

        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });

        assert.equal(result.status, 'failed');
        assert.ok(result.missingMarkers.some(([relativePath, marker, minOccurrences]) => (
            relativePath === PATCHED_PARSER_MODULE
            && marker === PARSER_CACHE_DELETE_MARKER
            && minOccurrences === 4
        )));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test('DISCRIMINATES: the obsolete global parser cache reset remains forbidden', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        const parserPath = path.join(fixtureDir, PATCHED_PARSER_MODULE);
        fs.appendFileSync(parserPath, '\nparseCache.clear()\n', 'utf8');

        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });

        assert.equal(result.status, 'failed');
        assert.ok(result.forbiddenMarkers.some(([relativePath, marker]) => (
            relativePath === PATCHED_PARSER_MODULE && marker === 'parseCache.clear()'
        )));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test('rejects stale visibility behavior independently in every consumed source and compiled owner', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        for (const [relativePath, marker] of VISIBILITY_MARKERS) {
            const filePath = path.join(fixtureDir, relativePath);
            const original = fs.readFileSync(filePath, 'utf8');
            fs.writeFileSync(filePath, original.replaceAll(marker, ''), 'utf8');
            const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });
            assert.equal(result.status, 'failed', relativePath);
            assert.ok(result.missingMarkers.some(([file, missing]) => file === relativePath && missing === marker));
            fs.writeFileSync(filePath, original, 'utf8');
        }
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});
