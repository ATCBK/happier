import { readFile } from 'node:fs/promises';

import ts from 'typescript';
import { expect, it } from 'vitest';

it('gives every production managed catalog constructor shared gateway authority', async () => {
  // This guards the composition boundary: a second unbound port overrides the
  // machine's admitted port and silently refuses before the wrapper can spawn.
  const paths = [
    new URL('./runtimeServices.ts', import.meta.url),
    new URL('../../daemon/startup/startDaemonSessionControlRuntime.ts', import.meta.url),
  ];
  const unbound: string[] = [];
  for (const path of paths) {
    const source = ts.createSourceFile(path.pathname, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'createProviderManagedCatalogRuntimePort') {
        const argument = node.arguments[0];
        if (!argument || !ts.isObjectLiteralExpression(argument)
          || !argument.getText(source).includes('resolveSharedGateway')) {
          unbound.push(`${path.pathname}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(unbound, 'Catalog startup must retain the canonical machine gateway resolver').toEqual([]);
});
