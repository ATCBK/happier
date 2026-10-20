import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CLI_SOURCE_ROOT = join(import.meta.dirname, '..', '..');

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
    if (!('name' in property) || !property.name) return null;
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
    return null;
}

function isNoninteractiveContext(context: ts.ObjectLiteralExpression): boolean {
    const properties = new Map(context.properties.map((property) => [propertyName(property), property]));
    for (const marker of ['actionCaller', 'reviewCommentPrincipal', 'executionRunTargetMachineId']) {
        if (properties.has(marker)) return true;
    }
    const surface = properties.get('surface');
    return Boolean(
        surface
        && ts.isPropertyAssignment(surface)
        && ts.isStringLiteral(surface.initializer)
        && ['agent', 'mcp', 'plugin'].includes(surface.initializer.text),
    );
}

/** A typed executor adapter forwards the caller's authority rather than minting another one. */
function forwardsExecutorContext(context: ts.ObjectLiteralExpression): boolean {
    if (context.properties.some(property => propertyName(property) === 'surface')) return false;
    const forwardedNames = context.properties.filter(ts.isSpreadAssignment)
        .flatMap(property => ts.isIdentifier(property.expression) ? [property.expression.text] : []);
    if (forwardedNames.length === 0) return false;
    let ancestor: ts.Node | undefined = context.parent;
    while (ancestor) {
        if (ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor)
            || ts.isFunctionDeclaration(ancestor) || ts.isMethodDeclaration(ancestor)) {
            return ancestor.parameters.some(parameter => ts.isIdentifier(parameter.name)
                && forwardedNames.includes(parameter.name.text)
                && parameter.type && ts.isTypeReferenceNode(parameter.type)
                && ts.isIdentifier(parameter.type.typeName)
                && parameter.type.typeName.text === 'ActionExecutorContext');
        }
        ancestor = ancestor.parent;
    }
    return false;
}

describe('Action execution authority architecture', () => {
    it('requires direct noninteractive production execute callsites to stamp authority explicitly', () => {
        const files = ts.sys.readDirectory(CLI_SOURCE_ROOT, ['.ts', '.tsx'], undefined, undefined)
            .filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
        const missing: string[] = [];

        for (const file of files) {
            let sourceText: string;
            try {
                sourceText = readFileSync(file, 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
            }
            if (!sourceText.includes('.execute(')) continue;
            const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
            const visit = (node: ts.Node): void => {
                if (
                    ts.isCallExpression(node)
                    && ts.isPropertyAccessExpression(node.expression)
                    && node.expression.name.text === 'execute'
                    && node.arguments.length >= 3
                    && ts.isObjectLiteralExpression(node.arguments[2])
                ) {
                    const context = node.arguments[2];
                    if (isNoninteractiveContext(context)
                        && !forwardsExecutorContext(context)
                        && !context.properties.some((property) => propertyName(property) === 'authority')) {
                        const position = source.getLineAndCharacterOfPosition(context.getStart(source));
                        missing.push(`${relative(CLI_SOURCE_ROOT, file)}:${position.line + 1}`);
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
        }

        expect(missing).toEqual([]);
    }, 120_000);
});
