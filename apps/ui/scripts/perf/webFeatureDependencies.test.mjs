import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

test('hosted HTML keeps the guest bootstrap outside its static entry graph', async () => {
    const entry = 'apps/ui/sources/components/plugins/hostedWeb/buildHostedHtmlDocument.ts';
    const { metafile } = await build({
        absWorkingDir: repoRoot, entryPoints: [entry], bundle: true, splitting: true,
        format: 'esm', platform: 'browser', conditions: ['happier-source'],
        outdir: '.hosted-html-dependency-probe', write: false, metafile: true, logLevel: 'silent',
    });
    const outputs = metafile.outputs;
    const required = new Set();
    const visit = file => {
        if (required.has(file)) return;
        required.add(file);
        for (const edge of outputs[file].imports) if (!edge.external && edge.kind !== 'dynamic-import') visit(edge.path);
    };
    visit(Object.keys(outputs).find(file => outputs[file].entryPoint === entry));
    const isBootstrap = file => file.endsWith('/hostedHtmlGuestBootstrap.generated.ts');
    assert.ok(Object.keys(metafile.inputs).some(isBootstrap), 'hosted demand must retain the real SDK guest bootstrap');
    assert.deepEqual([...required].flatMap(file => Object.keys(outputs[file].inputs)).filter(isBootstrap), [],
        'importing the document builder must not download the guest runtime');
});

test('Account and usage presentation contracts do not download the bundled model-price snapshot', async () => {
    const { metafile } = await build({
        absWorkingDir: repoRoot,
        entryPoints: [
            'packages/protocol/src/account/settings/accountSettings.ts',
            'packages/protocol/src/usage/usageAnalyticsContracts.ts',
            'packages/protocol/src/usage/usageAggregation.ts',
        ],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        conditions: ['happier-source'],
        outdir: '.price-contract-probe',
        write: false,
        metafile: true,
        logLevel: 'silent',
    });
    const snapshots = Object.keys(metafile.inputs).filter(file => file.endsWith('/usageModelPriceSnapshot.ts'));
    assert.deepEqual(snapshots, [], 'settings validation and witnessed cost presentation must not load optional pricing data');
});

for (const [feature, entry, dependency] of [
    ['billing', 'apps/ui/sources/sync/domains/purchases/revenueCat.web.ts', /\/node_modules\/@revenuecat\/purchases-js\//],
    ['voice', 'packages/plugins/elevenlabs/src/ui/voice/runtime/conversationHandle.ts', /\/node_modules\/(?:@elevenlabs\/client|livekit-client)\//],
]) {
    test(`${feature} adapter keeps its browser SDK outside the static entry graph`, async () => {
        const { metafile } = await build({
            absWorkingDir: repoRoot,
            entryPoints: [entry],
            bundle: true,
            splitting: true,
            format: 'esm',
            platform: 'browser',
            outdir: '.feature-dependency-probe',
            write: false,
            metafile: true,
            // Native platform code is a system boundary, not part of this
            // browser-SDK demand contract; its Flow syntax is not esbuild TS.
            external: ['@happier-dev/plugin-sdk/*', 'react-native'],
            logLevel: 'silent',
        });
        const outputs = metafile.outputs;
        const entryOutput = Object.keys(outputs).find((file) => outputs[file].entryPoint === entry);
        assert.ok(entryOutput, 'the real adapter must produce an entry output');
        const required = new Set();
        const visit = (file) => {
            if (required.has(file)) return;
            required.add(file);
            for (const edge of outputs[file].imports) {
                if (!edge.external && edge.kind !== 'dynamic-import') visit(edge.path);
            }
        };
        visit(entryOutput);
        const matchesSdk = (file) => dependency.test('/' + file.replaceAll('\\', '/'));
        assert.ok(Object.keys(metafile.inputs).some(matchesSdk), 'the async graph must retain the real browser SDK');
        const eager = [...required].flatMap((file) => Object.keys(outputs[file].inputs)).filter(matchesSdk);
        console.log(JSON.stringify({ feature, eagerSdkModules: eager.length }));
        assert.deepEqual(eager, [], 'importing the adapter must not require downloading its browser SDK');
    });
}

test('session presentation consumers share one demand boundary instead of eagerly importing the transcript', async () => {
    const entries = [
        'components/onboarding/tour/stage/StageSessionDetail.tsx',
        'components/workspaceCockpit/session/SessionCockpitSurfaceScreen.tsx',
        'components/sessions/panes/SessionInPane.tsx',
        'components/sessions/shell/SessionDestinationBody.tsx',
        'components/sessions/shell/embedded/EmbeddedSessionProvider.tsx',
    ].map(file => `apps/ui/sources/${file}`);
    // Inspect emitted value imports, not TS type references. The final Metro export
    // remains the download-size oracle; this focused graph check needs no native SDK.
    const sourceRoot = join(repoRoot, 'apps/ui/sources');
    const graph = new Map();
    const visitSource = file => {
        if (graph.has(file)) return;
        const edges = [];
        graph.set(file, edges);
        const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
            fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX },
        });
        const source = ts.createSourceFile(file + '.js', outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const inspect = node => {
            let specifier;
            let dynamic = false;
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
            else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
                specifier = node.arguments[0];
                dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            }
            if (specifier && ts.isStringLiteral(specifier)) {
                const path = specifier.text;
                const base = path.startsWith('@/') ? join(sourceRoot, path.slice(2))
                    : path.startsWith('.') ? resolve(dirname(file), path) : null;
                if (base?.startsWith(sourceRoot)) {
                    const candidates = [base + '.web.tsx', base + '.web.ts', base + '.web.js', base + '.tsx', base + '.ts', base + '.js',
                        join(base, 'index.web.tsx'), join(base, 'index.web.ts'), join(base, 'index.tsx'), join(base, 'index.ts'), base];
                    const dependency = candidates.find(file => existsSync(file) && /\.[cm]?[jt]sx?$/.test(file));
                    if (dependency) { edges.push({ file: dependency, dynamic }); visitSource(dependency); }
                }
            }
            ts.forEachChild(node, inspect);
        };
        inspect(source);
    };
    entries.forEach(file => visitSource(join(repoRoot, file)));
    const required = new Set();
    const visit = file => {
        if (required.has(file)) return;
        required.add(file);
        for (const edge of graph.get(file)) if (!edge.dynamic) visit(edge.file);
    };
    entries.forEach(file => visit(join(repoRoot, file)));
    const isTranscript = file => file.endsWith('/components/sessions/shell/SessionView.tsx');
    assert.ok([...graph.keys()].some(isTranscript), 'demand must retain the real session implementation');
    const eager = [...required].filter(isTranscript);
    assert.deepEqual(eager, [], 'unopened session presentation must not download the transcript implementation');
    const demandEdges = [...graph.values()].flat().filter(edge => isTranscript(edge.file));
    assert.equal(demandEdges.length, 1, 'all consumers must share one implementation demand edge');
    console.log(JSON.stringify({ feature: 'session', eagerTranscriptModules: eager.length }));
});
