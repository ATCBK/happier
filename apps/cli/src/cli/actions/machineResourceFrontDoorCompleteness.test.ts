import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { listActionSpecs } from '@happier-dev/protocol';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const ui = join(root, 'apps/ui/sources');
const machineViews = [
  join(ui, 'app/(app)/machine'),
  join(ui, 'components/machines'),
  // Plan 10's fleet route joins this audit when its directory is present.
  ...(existsSync(join(ui, 'app/(app)/machines')) ? [join(ui, 'app/(app)/machines')] : []),
];

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.[jt]sx?$/.test(entry.name) && !/\.(?:test|spec)\.[jt]sx?$/.test(entry.name) ? [child] : [];
  });
}

// This detects imports of the lower-level write ports from a machine view. The
// read-only machine operations (list/get/detect/watch) remain available there.
const mutationVerb = /^machine(?:\w*?)(?:Stop|Update|Revoke|Replace|Clear|Close|Invoke|Start|Cancel|Ensure|Open|Delete|Remove|Set)(?:\w*)$/;
const settingsWriter = new Set(['useApplySettings', 'useSettingMutable']);

function directMutationImports(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings: string[] = [];
  const directRpcBindings = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (binding.isTypeOnly) continue;
      const imported = binding.propertyName?.text ?? binding.name.text;
      const directOperation = module.startsWith('@/sync/ops') && mutationVerb.test(imported);
      const directSetting = (module === '@/sync/store/settingsWriters' || module === '@/sync/domains/state/storage')
        && settingsWriter.has(imported);
      const directCapabilityMutation = module === '@/hooks/machine/useMachineCapabilityInvokeWithAlerts'
        && imported === 'useMachineCapabilityInvokeWithAlerts';
      if (imported === 'machineRpcWithServerScope' && module.includes('serverScopedMachineRpc')) {
        directRpcBindings.add(binding.name.text);
      }
      if (directOperation || directSetting || directCapabilityMutation) {
        const line = source.getLineAndCharacterOfPosition(binding.getStart(source)).line + 1;
        findings.push(`${relative(root, path)}:${line} imports ${imported} from ${module}`);
      }
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && directRpcBindings.has(node.expression.text)) {
      const input = node.arguments[0];
      const method = input && ts.isObjectLiteralExpression(input)
        ? input.properties.find((property) => ts.isPropertyAssignment(property)
          && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'method')
        : undefined;
      const expression = method && ts.isPropertyAssignment(method) ? method.initializer : undefined;
      const name = expression && ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
        && expression.expression.text === 'RPC_METHODS' ? expression.name.text
        : expression && ts.isStringLiteral(expression) ? expression.text : null;
      // Unknown method names cannot establish that a direct transport call is read-only.
      if (!name || !/(?:^|[._])(?:GET|LIST|READ|WATCH|STATUS|CHECK|DETECT|DESCRIBE|HISTORY)(?:$|[._])/i.test(name)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        findings.push(`${relative(root, path)}:${line} calls machine RPC ${name ?? '(dynamic method)'}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

function isArraySchema(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const schema = value as Record<string, unknown>;
  return schema.type === 'array'
    || ['anyOf', 'oneOf'].some((key) => Array.isArray(schema[key]) && schema[key].some(isArraySchema));
}

describe('machine resource front-door completeness', () => {
  it('keeps machine view mutations behind Action execution', () => {
    const findings = machineViews.flatMap(sourceFiles).flatMap(directMutationImports);
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('declares narrowing for resource Actions with item sets', () => {
    const missing = listActionSpecs().flatMap((spec) => {
      if (!/^machines\.(?:processes|storage|guard)\./.test(spec.id)) return [];
      const schema = zodSchemaToJsonSchemaObject(spec.inputSchema);
      const properties = schema.properties;
      if (!properties || typeof properties !== 'object') return [];
      const hasItemSet = Object.entries(properties).some(([name, value]) =>
        /^(?:items|targets|refs|entryIds)$/.test(name) && isArraySchema(value));
      return hasItemSet && !Reflect.get(spec, 'approvalNarrowing') ? [spec.id] : [];
    });
    expect(missing, `Resource set Actions missing approval narrowing: ${missing.join(', ')}`).toEqual([]);
  });
});
