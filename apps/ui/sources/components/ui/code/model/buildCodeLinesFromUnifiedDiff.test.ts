import { describe, expect, it } from 'vitest';

import { buildCodeLinesFromUnifiedDiff } from './buildCodeLinesFromUnifiedDiff';

describe('buildCodeLinesFromUnifiedDiff', () => {
    it('keeps header-shaped context inside its original hunk', () => {
        const diff = '@@ -1,2 +1,2 @@\n @@ -9 +9 @@\n-old\n+new\n@@ -20 +20 @@\n-last\n+next\n';
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff });
        expect(lines.filter(line => line.kind === 'header').map(line => [line.id, line.hunkIndex])).toEqual([['h:0', 0], ['h:4', 1]]);
        expect(lines.find(line => line.id === 'c:1')).toMatchObject({ renderCodeText: '@@ -9 +9 @@', hunkIndex: 0, oldLine: 1, newLine: 1 });
    });
    it('keeps canonical hunk ordinals and source ids across newline markers and multiple hunks', () => {
        const diff = '--- a/a\n+++ b/a\n@@ -1 +1 @@\n-\ufeffold\r\n+\ufeffnew\r\n\\ No newline at end of file\n@@ -9 +9 @@\n-last\n+next\n';
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff });
        expect(lines.map(line => [line.id, line.hunkIndex])).toEqual([
            ['h:2', 0], ['r:3', 0], ['a:4', 0],
            ['h:6', 1], ['r:7', 1], ['a:8', 1],
        ]);
        expect(lines.find(line => line.id === 'a:4')?.renderCodeText).toBe('\ufeffnew');
        expect(lines.find(line => line.id === 'a:4')).toMatchObject({ noEol: true, newLine: 1 });
    });
    it('keeps newline markers as previous-line metadata without consuming source coordinates or splitting a replacement', () => {
        const lines = buildCodeLinesFromUnifiedDiff({
            unifiedDiff: '@@ -1 +1 @@\n-old value\n\\ No newline at end of file\n+new value\n\\ No newline at end of file\n',
            intraLineDiff: { enabled: true, maxLines: 20, maxLineLength: 100 },
        });
        expect(lines.map(line => [line.id, line.kind, line.oldLine, line.newLine])).toEqual([
            ['h:0', 'header', null, null], ['r:1', 'remove', 1, null], ['a:3', 'add', null, 1],
        ]);
        expect(lines.slice(1)).toEqual([
            expect.objectContaining({ noEol: true, renderCodeText: 'old value', renderIntraLineDiffSegments: expect.any(Array) }),
            expect.objectContaining({ noEol: true, renderCodeText: 'new value', renderIntraLineDiffSegments: expect.any(Array) }),
        ]);
    });
    it('retains literal marker text when it is an actual changed source line', () => {
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: '@@ -0,0 +1 @@\n+\\ No newline at end of file\n' });
        expect(lines[1]).toMatchObject({ kind: 'add', newLine: 1, renderCodeText: '\\ No newline at end of file' });
        expect(lines[1]).not.toHaveProperty('noEol');
    });
    it('hides the file prelude by default when hunks exist', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            'index 1111111..2222222 100644',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,1 +1,1 @@',
            '-const a = 1;',
            '+const a = 2;',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff });
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('diff --git'))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('index '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('--- '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('+++ '))).toBe(false);

        const hunk = lines.find((l) => (l.renderCodeText ?? '').startsWith('@@'))!;
        expect(hunk.sourceIndex).toBe(4);
    });

    it('hides the file prelude when hunk headers are indented', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            'index 1111111..2222222 100644',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '  @@ -1,1 +1,1 @@',
            '-const a = 1;',
            '+const a = 2;',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff });
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('diff --git'))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('index '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('--- '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('+++ '))).toBe(false);

        const hunk = lines.find((l) => (l.renderCodeText ?? '').includes('@@ -1,1 +1,1 @@'))!;
        expect(hunk.sourceIndex).toBe(4);
    });

    it('assigns old/new line numbers for add/remove/context lines', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,2 +1,2 @@',
            '-const a = 1;',
            '+const a = 2;',
            ' const b = 3;',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff });
        const body = lines.filter((l) => !l.renderIsHeaderLine);

        expect(body[0]).toMatchObject({
            kind: 'remove',
            oldLine: 1,
            newLine: null,
            renderPrefixText: '-',
            renderCodeText: 'const a = 1;',
        });

        expect(body[1]).toMatchObject({
            kind: 'add',
            oldLine: null,
            newLine: 1,
            renderPrefixText: '+',
            renderCodeText: 'const a = 2;',
        });

        expect(body[2]).toMatchObject({
            kind: 'context',
            oldLine: 2,
            newLine: 2,
            renderPrefixText: ' ',
            renderCodeText: 'const b = 3;',
        });
    });

    it('computes intra-line diff segments for paired remove/add lines when enabled', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,1 +1,1 @@',
            '-export function add(a:number,b:number){return a+b}',
            '+export function add(a: number, b: number) {',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({
            unifiedDiff: diff,
            intraLineDiff: {
                enabled: true,
                maxLines: 10_000,
                maxLineLength: 10_000,
            },
        });

        const body = lines.filter((l) => !l.renderIsHeaderLine);
        const removal = body.find((l) => l.kind === 'remove') as any;
        const addition = body.find((l) => l.kind === 'add') as any;

        expect(removal?.renderIntraLineDiffSegments?.some((s: any) => s.kind === 'removed')).toBe(true);
        expect(addition?.renderIntraLineDiffSegments?.some((s: any) => s.kind === 'added')).toBe(true);
    });

    it('limits intra-line diff work to maxPairs when provided', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,2 +1,2 @@',
            '-const a = 1;',
            '+const a = 2;',
            '-const b = 3;',
            '+const b = 4;',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({
            unifiedDiff: diff,
            intraLineDiff: {
                enabled: true,
                maxLines: 10_000,
                maxLineLength: 10_000,
                maxPairs: 1,
            },
        });

        const body = lines.filter((l) => !l.renderIsHeaderLine);
        const removes = body.filter((l) => l.kind === 'remove') as any[];
        const adds = body.filter((l) => l.kind === 'add') as any[];

        expect(removes[0]?.renderIntraLineDiffSegments?.some((s: any) => s.kind === 'removed')).toBe(true);
        expect(adds[0]?.renderIntraLineDiffSegments?.some((s: any) => s.kind === 'added')).toBe(true);

        // Second pair should not have computed intra-line segments due to budget.
        expect(removes[1]?.renderIntraLineDiffSegments).toBe(null);
        expect(adds[1]?.renderIntraLineDiffSegments).toBe(null);
    });

    it('hides the file prelude while preserving sourceIndex when requested and hunks exist', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            'index 1111111..2222222 100644',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,1 +1,1 @@',
            '-const a = 1;',
            '+const a = 2;',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff, hideFilePrelude: true });

        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('diff --git'))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('index '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('--- '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('+++ '))).toBe(false);

        const hunk = lines.find((l) => (l.renderCodeText ?? '').startsWith('@@'))!;
        expect(hunk.sourceIndex).toBe(4);

        const removal = lines.find((l) => l.kind === 'remove')!;
        const addition = lines.find((l) => l.kind === 'add')!;
        expect(removal.sourceIndex).toBe(5);
        expect(addition.sourceIndex).toBe(6);
    });

    it('does not hide the file prelude when there are no hunks', () => {
        const diff = [
            'diff --git a/assets/logo.png b/assets/logo.png',
            'new file mode 100644',
            'index 0000000..1111111',
            'Binary files /dev/null and b/assets/logo.png differ',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff, hideFilePrelude: true });
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('diff --git'))).toBe(true);
    });
    it('draws no row for the newline that ends the diff text', () => {
        const diff = '@@ -0,0 +1,2 @@\n+export const a = 1;\n+\n';
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff });
        // The header, the code line and the added blank line; the terminating newline is not a line.
        expect(lines.map((l) => l.kind)).toEqual(['header', 'add', 'add']);
    });
});
