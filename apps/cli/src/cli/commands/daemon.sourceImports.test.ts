import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('daemon worker startup import cost', () => {
    it('keeps the normal daemon, doctor and service runtimes out of hidden-worker dispatch', async () => {
        const source = await readFile(new URL('./daemon.ts', import.meta.url), 'utf8');
        const file = ts.createSourceFile('daemon.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const eagerNormalRuntimes = file.statements.flatMap(statement => (
            ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly
                && ts.isStringLiteral(statement.moduleSpecifier)
                ? [statement.moduleSpecifier.text] : []
        ));
        // Hidden child commands must load zero normal-daemon runtime roots.
        // This architectural cost contract catches even otherwise-unused eager imports.
        expect(eagerNormalRuntimes).toEqual([]);

        const workerSource = await readFile(new URL('../../plugins/runtime/lifecycle/contributions/backgroundServiceProcessWorkerEntry.ts', import.meta.url), 'utf8');
        const worker = ts.createSourceFile('worker.ts', workerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const eagerExecutionRoots = worker.statements.flatMap(statement => (
            ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly
                && ts.isStringLiteral(statement.moduleSpecifier)
                && statement.moduleSpecifier.text !== './backgroundServiceProcessProtocol'
                ? [statement.moduleSpecifier.text] : []
        ));
        expect(eagerExecutionRoots).toEqual([]);
    });

});
