import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A consumer-side load of the protocol root.
 *
 * A package-root specifier resolves differently from a relative path inside the package
 * and therefore exercises a different module-initialization order. That order
 * has broken before: the barrel re-exports the Action id registry while the
 * feature/capability graph imports it back, and when the two interleave the
 * package fails to load with an `undefined` TypeError far from the real cause.
 *
 * Production CLI consumers use leaves to keep cold admission small. This smoke
 * test deliberately exercises the public root and verifies both sides of that
 * cycle risk, independently of the production import boundary below.
 */
describe('protocol root import from a consumer package', () => {
  it.each([
    '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1',
    '@happier-dev/protocol/actions/actionIds',
    '@happier-dev/protocol/actions/actionExecutor',
    '@happier-dev/protocol/approvals/approvalRequestV1',
    '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1',
  ])('initializes %s in a fresh native source module graph', (entry) => {
    // Vitest's transformed graph can conceal native ESM initialization cycles.
    // This process boundary loads the same source condition as the CLI host.
    expect(() => execFileSync(process.execPath, [
      '--conditions=happier-source', '--import', 'tsx', '--input-type=module',
      '--eval', `await import(${JSON.stringify(entry)})`,
    ], { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'pipe' })).not.toThrow();
  }, 60_000);

  it('keeps CLI runtime imports on Protocol leaves', () => {
    const sourceRoot = new URL('../', import.meta.url);
    const violations: string[] = [];
    const files = ts.sys.readDirectory(fileURLToPath(sourceRoot), ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
      ['**/node_modules/**', '**/dist/**', '**/package-dist/**']);
    for (const file of files) {
      const path = relative(fileURLToPath(sourceRoot), file);
      // Test-only fixtures may deliberately load the root, as the smoke test
      // below does. Production imports, including deferred demands, may not.
      if (!/\.[cm]?[jt]sx?$/u.test(path)
        || /(?:\.d\.[cm]?ts|\.(?:test|spec|testkit|fixture)\.[cm]?tsx?|Fixture\.[cm]?tsx?)$/u.test(path)
        || /(?:^|[\\/])(?:testkit|__tests__)[\\/]/u.test(path)) continue;
      const text = readFileSync(file, 'utf8');
      if (!text.includes('@happier-dev/protocol')) continue;
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const isRoot = (node: ts.Node | undefined) => node !== undefined && ts.isStringLiteralLike(node)
        && node.text === '@happier-dev/protocol';
      const visit = (node: ts.Node): void => {
        let runtimeRoot = false;
        if (ts.isImportDeclaration(node) && isRoot(node.moduleSpecifier)) {
          const clause = node.importClause;
          runtimeRoot = !clause || (!clause.isTypeOnly && (Boolean(clause.name)
            || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)
            || clause.namedBindings.elements.length === 0
            || clause.namedBindings.elements.some(element => !element.isTypeOnly)));
        } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && isRoot(node.moduleSpecifier)) {
          runtimeRoot = !node.exportClause || !ts.isNamedExports(node.exportClause)
            || node.exportClause.elements.length === 0
            || node.exportClause.elements.some(element => !element.isTypeOnly);
        } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
          && ts.isExternalModuleReference(node.moduleReference)) {
          runtimeRoot = isRoot(node.moduleReference.expression);
        } else if (ts.isCallExpression(node) && isRoot(node.arguments[0])) {
          runtimeRoot = node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
        }
        if (runtimeRoot) violations.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations, `Runtime imports under ${fileURLToPath(sourceRoot)} must use Protocol leaf owners`).toEqual([]);
  });

  it('initializes the Action registry and the capability graph that imports it back', async () => {
    const protocol = await import('@happier-dev/protocol');

    expect(protocol.ActionIdSchema.safeParse('home.governance.get').success).toBe(true);
    expect(protocol.RuntimeActionIdV1Schema.safeParse('browser.navigate').success).toBe(true);
    expect(protocol.getActionSpec('teams.archive').serverTransport)
      .toEqual({ method: 'POST', path: '/v1/teams/archive' });
  }, 60_000);
});
