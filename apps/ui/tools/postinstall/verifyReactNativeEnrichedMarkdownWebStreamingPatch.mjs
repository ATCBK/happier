import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { listApplicablePatchFiles } from './filteredPatchDirectory.mjs';

export function verifyUiPatchedDependencies({
    uiPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
} = {}) {
    const packageDirs = findReactNativeEnrichedMarkdownPackageDirs({
        repoRootDir: path.resolve(uiPackageDir, '../..'),
        expoAppDir: uiPackageDir,
    });
    if (packageDirs.length === 0) {
        throw new Error(
            '[ui] react-native-enriched-markdown is not installed. Run the canonical UI dependency preparation: '
            + 'yarn --cwd apps/ui postinstall:real',
        );
    }
    const failures = packageDirs.flatMap(packageDir => {
        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir });
        return result.status === 'ok' ? [] : [`${packageDir}\n${formatReactNativeEnrichedMarkdownWebStreamingPatchFailure(result)}`];
    });
    const patchDir = path.join(uiPackageDir, 'patches');
    const require = createRequire(import.meta.url);
    for (const cwd of [path.resolve(uiPackageDir, '../..'), uiPackageDir]) {
        for (const patchFile of listApplicablePatchFiles({ patchDir, nodeModulesDir: path.join(cwd, 'node_modules') })) {
            try {
                // Reuse patch-package's own installed-patch test without applying
                // or reversing any bytes. The postinstall remains the sole writer.
                const { parsePatchFile } = require('patch-package/dist/patch/parse.js');
                const { reversePatch } = require('patch-package/dist/patch/reverse.js');
                const { executeEffects } = require('patch-package/dist/patch/apply.js');
                const patch = parsePatchFile(fs.readFileSync(path.join(patchDir, patchFile), 'utf8'));
                for (const effect of patch) {
                    // Reverse dry-run checks only existence for created files.
                    // Verify their complete patch-owned content as well.
                    if (effect.type === 'file creation') {
                        const contents = effect.hunk ? effect.hunk.parts[0].lines.join('\n')
                            + (effect.hunk.parts[0].noNewlineAtEndOfFile ? '' : '\n') : '';
                        if (fs.readFileSync(path.join(cwd, effect.path), 'utf8') !== contents) {
                            throw new Error(`Incorrect patched contents for ${effect.path}`);
                        }
                    }
                    if (effect.type !== 'mode change') continue;
                    if (process.platform !== 'win32' && (fs.statSync(path.join(cwd, effect.path)).mode & 0o111) !== (effect.newMode & 0o111)) {
                        throw new Error(`Incorrect patched mode for ${effect.path}`);
                    }
                }
                // patch-package 8's mode-change effect calls chmod even in dryRun.
                executeEffects(reversePatch(patch.filter(effect => effect.type !== 'mode change')), {
                    dryRun: true, bestEffort: false, cwd,
                });
            } catch (error) {
                failures.push(`${cwd}: ${patchFile}\n${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    if (failures.length > 0) throw new Error(`[ui] patched dependency preflight failed:\n${failures.join('\n\n')}`);
}

// AttributedRenderer owns the factory; cached child renderers must not retain it.
const WEAK_FACTORY_RENDERERS = [
    'Blockquote', 'CodeBlock', 'Code', 'ENRMSpoiler', 'Emphasis', 'Heading',
    'Link', 'ListItem', 'List', 'Paragraph', 'Strikethrough', 'Strong', 'Underline',
].map((name) => `ios/renderer/${name}Renderer.m`);
const UNUSED_FACTORY_RENDERERS = [
    'ios/renderer/ENRMImageRenderer.m',
    'ios/renderer/ENRMMathInlineRenderer.m',
];

export const REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES = Object.freeze([
    ...WEAK_FACTORY_RENDERERS,
    ...UNUSED_FACTORY_RENDERERS,
    'lib/module/web/EnrichedMarkdownText.js',
    'lib/module/web/parseMarkdown.js',
    'lib/module/web/katex.js',
    'lib/module/web/streamingReveal.d.ts',
    'lib/module/web/streamingReveal.js',
    'lib/typescript/src/types/MarkdownStyle.d.ts',
    'lib/typescript/src/web/streamingReveal.d.ts',
    'src/web/EnrichedMarkdownText.tsx',
    'src/web/parseMarkdown.ts',
    'src/web/katex.ts',
    'src/web/streamingReveal.ts',
    'cpp/wasm/build.sh',
    'src/web/wasm/md4c.js',
    'lib/module/web/wasm/md4c.js',
    'ios/utils/ENRMTailFadeInAnimator.m',
    'android/src/main/java/com/swmansion/enriched/markdown/utils/text/TailFadeInAnimator.kt',
    'ios/attachments/ENRMReferenceAttachment.h',
    'ios/attachments/ENRMReferenceAttachment.m',
    'android/src/main/java/com/swmansion/enriched/markdown/spans/ReferenceChipSpan.kt',
    'ios/renderer/LinkRenderer.m',
    'android/src/main/java/com/swmansion/enriched/markdown/renderer/LinkRenderer.kt',
]);

export const REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS = Object.freeze([
    ['lib/module/web/katex.js', "import('katex')"],
    ['src/web/katex.ts', "import('katex')"],
    ...WEAK_FACTORY_RENDERERS.map((file) => [file, '__weak RendererFactory *_rendererFactory;']),
    ['lib/module/web/EnrichedMarkdownText.js', 'markStreamingRevealOffsets'],
    ['lib/module/web/EnrichedMarkdownText.js', 'streamingAnimation'],
    ['lib/module/web/EnrichedMarkdownText.js', 'updateStreamingRevealRanges'],
    ['lib/module/web/EnrichedMarkdownText.js', 'if (syncAst) return;'],
    ['src/web/EnrichedMarkdownText.tsx', 'if (syncAst) return;'],
    ['lib/module/web/streamingReveal.js', '.start <= start'],
    ['src/web/streamingReveal.ts', '.start <= start'],
    ['lib/module/web/streamingReveal.js', 'data-happier-enriched-markdown-reveal'],
    ['lib/module/web/streamingReveal.js', 'updateStreamingRevealRanges'],
    ['lib/module/web/streamingReveal.js', 'splitStreamingRevealTextParts'],
    ['lib/module/web/streamingReveal.d.ts', "../../typescript/src/web/streamingReveal"],
    ['lib/typescript/src/types/MarkdownStyle.d.ts', 'texMathBackslashDelimiters?: boolean'],
    ['lib/typescript/src/web/streamingReveal.d.ts', 'splitStreamingRevealTextParts'],
    ['src/web/streamingReveal.ts', 'splitStreamingRevealTextParts'],
    ['src/web/streamingReveal.ts', 'updateStreamingRevealRanges'],
    ['lib/module/web/parseMarkdown.js', 'preloadMarkdownRuntime'],
    ['lib/module/web/parseMarkdown.js', "import createMd4cModule from './wasm/md4c.js'"],
    ['lib/module/web/parseMarkdown.js', "['number', 'number', 'number', 'number']"],
    ['lib/module/web/parseMarkdown.js', 'texMathBackslashDelimiters'],
    ['lib/module/web/parseMarkdown.js', 'stringToUTF8(markdown'],
    ['lib/module/web/parseMarkdown.js', 'parseCache.delete(cacheKey)', 4],
    ['src/web/parseMarkdown.ts', 'lengthBytesUTF8(markdown)'],
    ['src/web/parseMarkdown.ts', "import createMd4cModule from './wasm/md4c.js'"],
    ['src/web/parseMarkdown.ts', 'parserPromise = null'],
    ['src/web/parseMarkdown.ts', 'texMathBackslashDelimiters'],
    ['src/web/EnrichedMarkdownText.tsx', 'lastChildStyles.paragraph'],
    ['cpp/wasm/build.sh', 'STACK_SIZE=8MB'],
    ['cpp/wasm/build.sh', 'SINGLE_FILE_BINARY_ENCODE=0'],
    ['cpp/wasm/build.sh', 'ALLOW_MEMORY_GROWTH=1'],
    ['cpp/wasm/build.sh', 'EXPORT_ES6=1'],
    ['cpp/wasm/build.sh', '"_parseMarkdown","_malloc","_free"'],
    ['cpp/wasm/build.sh', '"stringToUTF8","lengthBytesUTF8"'],
    ['src/web/wasm/md4c.js', 'export default createMd4cModule'],
    ['lib/module/web/wasm/md4c.js', 'export default createMd4cModule'],
    ['ios/utils/ENRMTailFadeInAnimator.m', 'ENRMActiveFadeRange'],
    ['android/src/main/java/com/swmansion/enriched/markdown/utils/text/TailFadeInAnimator.kt', 'activeRanges'],
    ['ios/attachments/ENRMReferenceAttachment.m', 'drawChipWithWidth'],
    ['ios/attachments/ENRMReferenceAttachment.m', 'ENRMReferenceText'],
    ['android/src/main/java/com/swmansion/enriched/markdown/spans/ReferenceChipSpan.kt', 'class ReferenceChipSpan'],
    ['ios/renderer/LinkRenderer.m', 'referenceChips'],
    ['android/src/main/java/com/swmansion/enriched/markdown/renderer/LinkRenderer.kt', 'ReferenceChipSpan'],
]);

export const REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_FORBIDDEN_MARKERS = Object.freeze([
    ...UNUSED_FACTORY_RENDERERS.map((file) => [file, '_rendererFactory']),
    ['lib/module/web/parseMarkdown.js', "import('./wasm/md4c"],
    ['lib/module/web/parseMarkdown.js', 'parseCache.clear()'],
    ['src/web/parseMarkdown.ts', "import('./wasm/md4c"],
    ['src/web/EnrichedMarkdownText.tsx', '<pre'],
    ['src/web/wasm/md4c.js', 'import.meta'],
    ['lib/module/web/wasm/md4c.js', 'import.meta'],
]);

export function findReactNativeEnrichedMarkdownPackageDirs({ repoRootDir, expoAppDir }) {
    return [
        path.resolve(repoRootDir, 'node_modules', 'react-native-enriched-markdown'),
        path.resolve(expoAppDir, 'node_modules', 'react-native-enriched-markdown'),
    ].filter((packageDir) => fs.existsSync(packageDir));
}

function readFile(packageDir, relativePath) {
    try {
        return fs.readFileSync(path.resolve(packageDir, relativePath), 'utf8');
    } catch {
        return null;
    }
}

/**
 * Certifies the installed artifacts rather than re-parsing the patch. The UI runtime resolves the
 * app-local package directly, so a syntactically valid patch file cannot prove that the dependency
 * copy Metro/Vitest consumes actually has the patch-owned module and its matching source/types.
 */
export function verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir }) {
    if (!fs.existsSync(packageDir)) {
        return {
            status: 'missing',
            missingFiles: ['(package directory)'],
            missingMarkers: [],
            forbiddenMarkers: [],
            binaryFiles: [],
        };
    }

    const missingFiles = REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES.filter((relativePath) => !fs.existsSync(path.resolve(packageDir, relativePath)));
    const contentsByFile = new Map();
    for (const relativePath of REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES) {
        const contents = readFile(packageDir, relativePath);
        if (contents !== null) contentsByFile.set(relativePath, contents);
    }

    const missingMarkers = REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS.filter(([relativePath, marker, minOccurrences = 1]) => {
        const contents = contentsByFile.get(relativePath);
        return contents === undefined || contents.split(marker).length - 1 < minOccurrences;
    });
    const forbiddenMarkers = REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_FORBIDDEN_MARKERS.filter(([relativePath, marker]) => {
        const contents = contentsByFile.get(relativePath);
        return contents !== undefined && contents.includes(marker);
    });
    const binaryFiles = [
        'src/web/wasm/md4c.js',
        'lib/module/web/wasm/md4c.js',
    ].filter((relativePath) => {
        try {
            return fs.readFileSync(path.resolve(packageDir, relativePath)).includes(0);
        } catch {
            return false;
        }
    });

    return {
        status: missingFiles.length || missingMarkers.length || forbiddenMarkers.length || binaryFiles.length ? 'failed' : 'ok',
        missingFiles,
        missingMarkers,
        forbiddenMarkers,
        binaryFiles,
    };
}

export function formatReactNativeEnrichedMarkdownWebStreamingPatchFailure(result) {
    const lines = ['react-native-enriched-markdown patch is not installed correctly:'];
    for (const relativePath of result.missingFiles) lines.push(`  - missing ${relativePath}`);
    for (const [relativePath, marker, minOccurrences = 1] of result.missingMarkers) {
        const occurrenceRequirement = minOccurrences > 1 ? ` at least ${minOccurrences} times` : '';
        lines.push(`  - ${relativePath} is missing ${JSON.stringify(marker)}${occurrenceRequirement}`);
    }
    for (const [relativePath, marker] of result.forbiddenMarkers) lines.push(`  - ${relativePath} still contains forbidden ${JSON.stringify(marker)}`);
    for (const relativePath of result.binaryFiles) lines.push(`  - ${relativePath} contains a NUL byte instead of the vendored JavaScript module`);
    lines.push('Run the canonical UI dependency preparation: yarn --cwd apps/ui postinstall:real');
    return lines.join('\n');
}
