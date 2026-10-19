import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('Machine access transaction module loading', () => {
    it('resolves modules before transaction functions can hold Account publication fences', () => {
        // The module loader is a system boundary. Inspect its invocation sites
        // rather than mocking admission, grant effects or the Account fence.
        // All functions in this owner are reachable from an existing transaction;
        // a static import (or module-scope preload) completes before they run.
        const path = new URL('./machineAccess.ts', import.meta.url);
        const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
        const transactionModuleLoads: Array<{ functionName: string; line: number; module: string }> = [];
        const visit = (node: ts.Node, enclosingFunction: string | null) => {
            const functionName = ts.isFunctionLike(node)
                ? node.name?.getText(source) ?? enclosingFunction ?? '<anonymous>'
                : enclosingFunction;
            if (functionName && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                transactionModuleLoads.push({
                    functionName,
                    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                    module: node.arguments[0]?.getText(source) ?? '<computed>',
                });
            }
            ts.forEachChild(node, child => visit(child, functionName));
        };
        visit(source, null);
        expect(transactionModuleLoads, 'Module resolution must finish before entering an Account-fenced transaction').toEqual([]);
    });
});
