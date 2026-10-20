import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

import { describe, expect, it } from 'vitest';

const SOURCES_DIR = resolve(__dirname, '..', '..', '..');
const OWNER_DIR = resolve(__dirname);

function collectSourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'trash') continue;
            collectSourceFiles(full, found);
        } else if (/\.tsx?$/u.test(entry.name)) {
            found.push(full);
        }
    }
    return found;
}

/** Every form an import of the browser Iroh owner can take in app sources. */
const OWNER_IMPORT_MARKERS = [
    'sync/runtime/browserIroh',
    './browserIroh',
    '../browserIroh',
    'runtime/browserIroh/',
];

/**
 * The modules a production caller may reach, and nothing else.
 *
 * `hostEligibility` and the `browserHomeCarrier` seam are cheap by construction:
 * between them they read the host decision, judge the Home descriptor, and hold
 * the `import()` that pulls the runtime. Everything heavier — the endpoint
 * client, the packaged asset URLs, the SharedWorker bootstrap, the wasm binder,
 * the tunnel codecs — sits behind that dynamic import and behind
 * `browserHomeCarrierRuntime`, which no static import may name.
 */
const APPROVED_LAZY_CONSUMER_ENTRY_POINTS = [
    'sync/runtime/browserIroh/hostEligibility',
    'sync/runtime/browserIroh/homeCarrier/browserHomeCarrier',
];

/**
 * The exact production consumers approved to reach the owner (A7.3/A7.4). Anything
 * else importing it is a second transport decision-maker, or an eager cost on a
 * browser that never adopts an Iroh Home.
 */
const APPROVED_CONSUMERS = [
    // Focused, scoped, and enrollment Home lifecycles all consume this one
    // narrow carrier policy. It alone reaches the cheap browser carrier seam;
    // callers retain only their distinct publication/proof/release duties.
    'sync/runtime/homeCarrierPolicy.ts',
    'sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease.ts',
    // A12 lets presentation read the pure host capability while deciding
    // whether finite Machine transfer is available. These consumers must not
    // acquire the endpoint or import the heavy browser carrier runtime.
    'components/projects/files/WorkspaceRepositoryTreeBrowserView.tsx',
    'components/sessions/files/useSessionFileTransferAvailability.ts',
];

function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//gu, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

function importSpecifiersOf(code: string): string[] {
    const specifiers: string[] = [];
    const source = ts.createSourceFile('boundary.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const clause = node.importClause;
            const named = clause?.namedBindings;
            const onlyNamedTypes = !clause?.name && named && ts.isNamedImports(named)
                && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly);
            if (!clause?.isTypeOnly && !onlyNamedTypes) specifiers.push(node.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            const named = node.exportClause;
            const onlyNamedTypes = named && ts.isNamedExports(named)
                && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly);
            if (!node.isTypeOnly && !onlyNamedTypes) specifiers.push(node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
            specifiers.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    return specifiers;
}

function appSourceFilesOutsideOwner(): string[] {
    return collectSourceFiles(SOURCES_DIR)
        .filter((file) => !file.startsWith(OWNER_DIR))
        .filter((file) => !/\.test\.tsx?$/u.test(file));
}

describe('sync/runtime/browserIroh activation boundary', () => {
    it('is reached only by the approved production consumers', () => {
        const importers = appSourceFilesOutsideOwner()
            .filter((file) => {
                const code = stripComments(readFileSync(file, 'utf8'));
                return OWNER_IMPORT_MARKERS.some((marker) => code.includes(marker))
                    && importSpecifiersOf(code).some(specifier => OWNER_IMPORT_MARKERS.some(marker => specifier.includes(marker)));
            })
            .map((file) => relative(SOURCES_DIR, file))
            .sort();

        expect(importers).toEqual([...APPROVED_CONSUMERS].sort());
    });

    it('is reached only through the cheap seam, never the runtime or the barrel', () => {
        // A static import of the barrel (or of any heavy module) would pull the
        // asset loader, the worker bootstrap, and the wasm binder into the
        // startup bundle for every browser, including HTTPS-only public use.
        const forbidden = appSourceFilesOutsideOwner()
            .flatMap((file) => {
                const code = stripComments(readFileSync(file, 'utf8'));
                if (!OWNER_IMPORT_MARKERS.some(marker => code.includes(marker))) return [];
                const relativeFile = relative(SOURCES_DIR, file);
                return importSpecifiersOf(code)
                    .filter((specifier) => OWNER_IMPORT_MARKERS.some((marker) => specifier.includes(marker)))
                    .filter((specifier) => !APPROVED_LAZY_CONSUMER_ENTRY_POINTS.some(
                        (approved) => specifier.endsWith(approved),
                    ))
                    .filter((specifier) => !(
                        relativeFile === 'sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease.ts'
                        && specifier === '@/sync/runtime/browserIroh'
                        && code.includes("import('@/sync/runtime/browserIroh')")
                        && !code.includes("from '@/sync/runtime/browserIroh'")
                    ))
                    .map((specifier) => `${relativeFile} → ${specifier}`);
            });

        expect(forbidden).toEqual([]);
    });

    it('loads its runtime only through the seam dynamic import', () => {
        const runtimeImporters = collectSourceFiles(OWNER_DIR)
            .filter((file) => !/\.test\.tsx?$/u.test(file))
            .filter((file) => !file.endsWith('browserHomeCarrierRuntime.ts'))
            .filter((file) => {
                const code = stripComments(readFileSync(file, 'utf8'));
                return /from\s+['"][^'"]*browserHomeCarrierRuntime['"]/u.test(code);
            })
            .map((file) => relative(OWNER_DIR, file));

        // Type-only imports erase, so the seam's `import()` is the sole runtime
        // edge; a value import here would defeat the packaging boundary.
        expect(runtimeImporters).toEqual([]);
    });

    it('has exactly one SharedWorker host: nothing outside the owner constructs one', () => {
        // One endpoint for the lifetime of the live SharedWorker serves every
        // connected tab. A second construction site would be a second endpoint
        // host — the split the amendment forbids.
        const constructors = collectSourceFiles(SOURCES_DIR)
            .filter((file) => !file.startsWith(OWNER_DIR))
            .filter((file) => stripComments(readFileSync(file, 'utf8')).includes('new SharedWorker('))
            .map((file) => relative(SOURCES_DIR, file));

        expect(constructors).toEqual([]);
    });

    it('adds no second HTTP client and no second Socket.IO owner', () => {
        // The owner supplies a request function and a `WebSocket`-like object.
        // It must never import the semantic HTTP owner or the Socket.IO client:
        // `serverFetch` keeps auth, compatibility, invalidation, timeouts, and
        // reachability, and Engine.IO keeps lifecycle, reconnect, and events.
        const payloadReferences = collectSourceFiles(OWNER_DIR)
            .filter((file) => file !== __filename)
            .filter((file) => !/\.test\.tsx?$/u.test(file))
            .filter((file) => {
                const specifiers = importSpecifiersOf(stripComments(readFileSync(file, 'utf8')));
                return specifiers.some((specifier) => (
                    specifier.includes('socket.io')
                    || specifier.endsWith('sync/http/client')
                    || specifier.includes('api/session/apiSocket')
                ));
            })
            .map((file) => relative(OWNER_DIR, file));

        expect(payloadReferences).toEqual([]);
    });
});
