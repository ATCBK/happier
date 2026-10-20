import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    createSourceFile, forEachChild, isCallExpression, isIdentifier, isImportDeclaration, isNewExpression,
    isRegularExpressionLiteral, isStringLiteral, isStringLiteralLike, ScriptTarget, type Node,
} from 'typescript';
import type { FileChangeEvidence } from '@happier-dev/protocol/sessions/changes/types';
import { formatHunk, parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import { attributeUncommittedLines, type FileLineAttributionTurn } from './attributeFileLines';

function turn(turnId: string, order: number, unifiedDiff: string | null, extra?: Partial<FileChangeEvidence>): FileLineAttributionTurn {
    return {
        turnId, order, label: `Turn ${order + 1}`,
        evidence: unifiedDiff === null ? null : {
            filePath: 'src/a.ts', changeKind: 'modified', source: 'provider_native',
            confidence: 'exact', provider: 'agent', unifiedDiff, ...extra,
        },
    };
}

describe('attributeUncommittedLines', () => {
    it('delegates diff parsing to the protocol hunk owner without a local regex parser', () => {
        const source = createSourceFile('attributeFileLines.ts',
            readFileSync(new URL('./attributeFileLines.ts', import.meta.url), 'utf8'), ScriptTarget.Latest, true);
        const imports: string[] = [];
        const localHunkPatterns: Node[] = [];
        const visit = (node: Node) => {
            if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
            if (isRegularExpressionLiteral(node) && node.text.includes('@@')) localHunkPatterns.push(node);
            if ((isNewExpression(node) || isCallExpression(node)) && isIdentifier(node.expression) && node.expression.text === 'RegExp') {
                const pattern = node.arguments?.[0];
                if (pattern && isStringLiteralLike(pattern) && pattern.text.includes('@@')) localHunkPatterns.push(node);
            }
            forEachChild(node, visit);
        };
        visit(source);
        expect(imports).toContain('@happier-dev/protocol/diff/hunks');
        expect(localHunkPatterns).toHaveLength(0);
    });

    it('attributes disjoint writes in canonical turn order rather than evidence arrival order', () => {
        const turns = [
            turn('second', 1, '@@ -4 +4 @@\n-d\n+second\n'),
            turn('first', 0, '@@ -1 +1 @@\n-a\n+first\n'),
        ];
        expect([...attributeUncommittedLines({ uncommittedLines: [1, 2, 4], currentLines: ['first', 'b', 'c', 'second'], turns })])
            .toEqual([[1, { turnId: 'first' }], [2, null], [4, { turnId: 'second' }]]);
    });

    it('maps earlier writes through later insertions and preserves hunk context lines', () => {
        const insertion = parseUnifiedDiffHunks('@@ -1,3 +1,4 @@\n a\n+inserted\n first\n c\n');
        const turns = [
            turn('first', 0, '@@ -1,3 +1,3 @@\n a\n-b\n+first\n c\n'),
            turn('second', 1, insertion.map(formatHunk).join('\n')),
        ];
        expect([...attributeUncommittedLines({ uncommittedLines: [2, 3], currentLines: ['a', 'inserted', 'first', 'c'], turns })])
            .toEqual([[2, { turnId: 'second' }], [3, { turnId: 'first' }]]);
    });

    it('gives rewritten lines to the latest turn and drops deleted ownership', () => {
        const turns = [
            turn('first', 0, '@@ -1,2 +1,2 @@\n-a\n-b\n+first\n+removed\n'),
            turn('second', 1, '@@ -1,2 +1 @@\n-first\n-removed\n+second\n'),
        ];
        expect([...attributeUncommittedLines({ uncommittedLines: [1, 2], currentLines: ['second', 'other'], turns })])
            .toEqual([[1, { turnId: 'second' }], [2, null]]);
    });

    it('does not search for matching text after a human edit shifts the lines', () => {
        const turns = [turn('first', 0, '@@ -2 +2 @@\n-b\n+first\n')];
        expect([...attributeUncommittedLines({ uncommittedLines: [1, 2, 3], currentLines: ['human', 'a', 'first'], turns })])
            .toEqual([[1, null], [2, null], [3, null]]);
    });

    it('skips absent, truncated, binary, and missing diff evidence', () => {
        const turns = [
            turn('absent', 0, null),
            turn('truncated', 1, '@@ -1 +1 @@\n-a\n+b\n', { truncated: true }),
            turn('binary', 2, '@@ -2 +2 @@\n-a\n+b\n', { binary: true }),
            turn('no-diff', 3, ''),
        ];
        expect([...attributeUncommittedLines({ uncommittedLines: [1, 2], currentLines: ['b', 'b'], turns })])
            .toEqual([[1, null], [2, null]]);
    });

    it('attributes a newly created CRLF file without confusing the empty old range', () => {
        const turns = [turn('create', 0, '@@ -0,0 +1,2 @@\r\n+one\r\n+two\r\n', { changeKind: 'added' })];
        expect([...attributeUncommittedLines({ uncommittedLines: [1, 2], currentLines: ['one\r', 'two\r'], turns })])
            .toEqual([[1, { turnId: 'create' }], [2, { turnId: 'create' }]]);
    });

    it('shifts ownership at zero-width insertions and through preceding deletions', () => {
        const turns = [
            turn('first', 0, '@@ -2 +2 @@\n-old\n+kept\n'),
            turn('insert', 1, '@@ -1,0 +2 @@\n+insert\n'),
            turn('delete', 2, '@@ -1 +0,0 @@\n-head\n'),
        ];
        expect([...attributeUncommittedLines({ uncommittedLines: [1, 2], currentLines: ['insert', 'kept'], turns })])
            .toEqual([[1, { turnId: 'insert' }], [2, { turnId: 'first' }]]);
    });
});
