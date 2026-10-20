import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

import { findServerConfigEntry, type ServerConfigRegistry } from '@happier-dev/protocol';

/**
 * Server configuration coverage (plan §3.14, invariant I8): every environment key server source
 * reads must be declared in the server configuration registry.
 *
 * The scan is syntax-aware and deliberately over-inclusive within executable code:
 * - raw accesses on any identifier ending in `env`/`Env` (`process.env.X`, `env['X']`,
 *   `safeEnv.X`, `env[FEATURE_ENV_KEYS.x]`, `env[SOME_KEY_CONSTANT]`);
 * - helper calls that pass an env and a key literal (`readTrimmed(env, 'X')`);
 * - every complete `HAPPIER_*`, `HAPPY_*` or `HANDY_*` string literal, which catches keys held in
 *   constants and key tables.
 * Keys built at runtime (rate-limit and retention families) are declared by their owners and are
 * covered through the registry rather than the scan.
 */
export type ServerConfigRead = Readonly<{
    name: string;
    file: string;
    line: number;
}>;

export type UnresolvedServerConfigRead = Readonly<{ expression: string; file: string; line: number }>;

export type ServerConfigCoverageReport = Readonly<{
    undeclared: readonly ServerConfigRead[];
    unresolved: readonly UnresolvedServerConfigRead[];
}>;

export type ServerConfigSourceFile = Readonly<{ file: string; source: string }>;

/** Names read through an indirection the scan cannot see by itself (`FEATURE_ENV_KEYS.x`, imported key constants). */
export type ServerConfigIndirection = Readonly<{
    featureEnvKeys: Readonly<Record<string, string>>;
    constants: Readonly<Record<string, unknown>>;
}>;

const ENV_ID = String.raw`\b(?:[A-Za-z_$][\w$]*?)?(?:env|Env)\b`;
const NAME = String.raw`[A-Z][A-Z0-9_]*[A-Z0-9]`;
const RAW_DOT = new RegExp(String.raw`${ENV_ID}\s*(?:\?\.|\.)\s*(${NAME})\b`, 'g');
const RAW_INDEX_LITERAL = new RegExp(String.raw`${ENV_ID}\s*(?:\?\.)?\[\s*['"\`](${NAME})['"\`]\s*\]`, 'g');
const RAW_INDEX_FEATURE = new RegExp(String.raw`${ENV_ID}\s*(?:\?\.)?\[\s*FEATURE_ENV_KEYS\.(\w+)\s*\]`, 'g');
const RAW_INDEX_CONSTANT = new RegExp(String.raw`${ENV_ID}\s*(?:\?\.)?\[\s*(${NAME})\s*\]`, 'g');
const HELPER_LITERAL = new RegExp(String.raw`${ENV_ID}\s*,\s*['"\`](${NAME})['"\`]`, 'g');
const PREFIXED_LITERAL = /['"`]((?:HAPPIER|HAPPY|HANDY)_[A-Z0-9_]*[A-Z0-9])['"`]/g;

function lineOf(source: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
    return line;
}

function readLocalConstant(source: string, identifier: string, identifiers: ReadonlySet<number>): string | null {
    const pattern = new RegExp(String.raw`\b${identifier}\s*(?::[^=]+)?=\s*['"\`](${NAME})['"\`]`, 'g');
    const match = [...source.matchAll(pattern)].find((candidate) => identifiers.has(candidate.index!));
    return match?.[1] ?? null;
}

export function scanServerConfigReads(
    input: ServerConfigSourceFile,
    indirection: ServerConfigIndirection,
): Readonly<{ reads: ServerConfigRead[]; unresolved: UnresolvedServerConfigRead[] }> {
    let source = input.source;
    const parsed = ts.createSourceFile(input.file, source, ts.ScriptTarget.Latest);
    const identifiers = new Set<number>();
    const literals = new Set<number>();
    const trivia: ts.TextRange[] = [];
    const visit = (node: ts.Node): void => {
        if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
        const start = node.getStart(parsed);
        if (ts.isIdentifier(node)) identifiers.add(start);
        if (ts.isStringLiteralLike(node)) literals.add(start);
        if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken && start > node.pos) {
            trivia.push({ pos: node.pos, end: start });
        }
        for (const child of node.getChildren(parsed)) visit(child);
    };
    visit(parsed);
    // Mask parsed trivia only: comment-like text inside bundle strings remains data, and
    // real reads separated by comments still match without changing source offsets or lines.
    const parts: string[] = [];
    let end = 0;
    for (const range of trivia) {
        parts.push(source.slice(end, range.pos), source.slice(range.pos, range.end).replace(/[^\r\n]/g, ' '));
        end = range.end;
    }
    parts.push(source.slice(end));
    source = parts.join('');
    const reads: ServerConfigRead[] = [];
    const unresolved: UnresolvedServerConfigRead[] = [];
    const push = (name: string, index: number) => reads.push({ name, file: input.file, line: lineOf(source, index) });

    for (const pattern of [RAW_DOT, RAW_INDEX_LITERAL, HELPER_LITERAL]) {
        for (const match of source.matchAll(pattern)) {
            if (identifiers.has(match.index!)) push(match[1]!, match.index!);
        }
    }
    for (const match of source.matchAll(RAW_INDEX_FEATURE)) {
        if (!identifiers.has(match.index!)) continue;
        const name = indirection.featureEnvKeys[match[1]!];
        if (name) push(name, match.index!);
        else unresolved.push({ expression: match[0], file: input.file, line: lineOf(source, match.index!) });
    }
    for (const match of source.matchAll(RAW_INDEX_CONSTANT)) {
        if (!identifiers.has(match.index!)) continue;
        const identifier = match[1]!;
        const imported = indirection.constants[identifier];
        const name = readLocalConstant(source, identifier, identifiers) ?? (typeof imported === 'string' ? imported : null);
        if (name) push(name, match.index!);
        else unresolved.push({ expression: match[0], file: input.file, line: lineOf(source, match.index!) });
    }
    for (const match of source.matchAll(PREFIXED_LITERAL)) {
        if (literals.has(match.index!)) push(match[1]!, match.index!);
    }
    return { reads, unresolved };
}

export function checkServerConfigCoverage(params: Readonly<{
    files: readonly ServerConfigSourceFile[];
    registry: ServerConfigRegistry;
    indirection: ServerConfigIndirection;
}>): ServerConfigCoverageReport {
    const undeclared: ServerConfigRead[] = [];
    const unresolved: UnresolvedServerConfigRead[] = [];
    for (const file of params.files) {
        const scanned = scanServerConfigReads(file, params.indirection);
        unresolved.push(...scanned.unresolved);
        for (const read of scanned.reads) {
            if (!findServerConfigEntry(params.registry, read.name)) undeclared.push(read);
        }
    }
    return { undeclared, unresolved };
}

const TEST_FILE = /\.(spec|test)\.ts$|\.d\.ts$|\.test-support\.ts$|testkit/i;

/** Production TypeScript under a source root; tests, declarations and testkits are not server reads. */
export function listServerSourceFiles(root: string): ServerConfigSourceFile[] {
    const out: ServerConfigSourceFile[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) {
                if (name === 'node_modules' || name === '__tests__' || name === '__fixtures__') continue;
                walk(path);
            } else if (name.endsWith('.ts') && !TEST_FILE.test(path)) {
                out.push({ file: relative(root, path), source: readFileSync(path, 'utf8') });
            }
        }
    };
    walk(root);
    return out;
}

export function formatServerConfigCoverageReport(report: ServerConfigCoverageReport): string {
    const lines: string[] = [];
    const unique = (reads: readonly ServerConfigRead[]) => {
        const byName = new Map<string, ServerConfigRead>();
        for (const read of reads) if (!byName.has(read.name)) byName.set(read.name, read);
        return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    };
    for (const read of unique(report.undeclared)) {
        lines.push(`undeclared ${read.name} (${read.file}:${read.line}): declare it in the server configuration registry`);
    }
    for (const item of report.unresolved) {
        lines.push(`unresolved ${item.expression} (${item.file}:${item.line}): the key behind this env access cannot be resolved`);
    }
    return lines.join('\n');
}
