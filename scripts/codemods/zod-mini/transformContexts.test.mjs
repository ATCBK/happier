import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import en from 'zod/v4/locales/en.js';
import { z as classic } from 'zod';
import { z as mini } from 'zod/mini';
import { analyzeTransformContexts } from './transformContexts.mjs';

classic.config(en());
mini.config(en());

function project(source, isPureNamedTransform) {
  const ast = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const isZ = node => ts.isIdentifier(node) && node.text === 'z';
  const result = analyzeTransformContexts({
    ast, source, ts, isZ, miniAlias: () => 'z', isPureNamedTransform,
    isTransformCall: node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && isZ(node.expression.expression) && node.expression.name.text === 'transform',
  });
  const render = node => {
    const override = result.overrides.get(node);
    if (override) return override(render);
    let output = '';
    let cursor = node.getStart(ast);
    ts.forEachChild(node, child => {
      output += source.slice(cursor, child.getStart(ast)) + render(child);
      cursor = child.end;
    });
    return output + source.slice(cursor, node.end);
  };
  return { ...result, output: render(ast) };
}

function evaluate(source, z, expression) {
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('z', `${code}\nreturn ${expression};`)(z);
}

function outcome(schema, input, options) {
  const parsed = schema.safeParse(input, options);
  return parsed.success ? { success: true, data: parsed.data } : {
    success: false,
    issues: parsed.error.issues.map(({ code, path, message, input: issueInput }) => ({ code, path, message, input: issueInput })),
  };
}

test('direct named transform forwards nested issues with input fallback and aborts downstream', () => {
  const source = `function admit(value: unknown, ctx: z.core.$RefinementCtx) {
  const parsed = z.object({ name: z.string().check(z.minLength(3)) }).safeParse(value, { reportInput: true });
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['nested', ...issue.path] });
  return z.NEVER;
}
let downstream = 0;
const S = z.pipe(z.transform(admit), z.transform(value => { downstream++; return value; }));`;
  const converted = project(source);
  assert.deepEqual(converted.unresolved, []);
  assert.match(converted.output, /ctx: z\.core\.ParsePayload/);
  assert.match(converted.output, /ctx\.issues\.push\(\{ \.\.\.issue, path: \['nested', \.\.\.issue\.path\], input: 'input' in issue \? issue\.input \?\? ctx\.value : ctx\.value \} as z\.core\.\$ZodRawIssue\)/);
  assert.equal(project(converted.output).output, converted.output);
  const before = evaluate(source, classic, '({ S, downstream: () => downstream })');
  const after = evaluate(converted.output, mini, '({ S, downstream: () => downstream })');
  assert.deepEqual(outcome(after.S, { name: 'ab' }, { reportInput: true }), outcome(before.S, { name: 'ab' }, { reportInput: true }));
  assert.equal(before.downstream(), 0);
  assert.equal(after.downstream(), 0);
});

test('indirect helper reached only from Mini transform becomes ParsePayload', () => {
  const source = `function normalize(value: string, context: z.core.$RefinementCtx): string | typeof z.NEVER {
  if (value === 'bad') { context.addIssue({ code: 'custom', path: ['value'], message: 'bad value' }); return z.NEVER; }
  return value.trim();
}
const S = z.pipe(z.string(), z.transform((value, context) => normalize(value, context)));`;
  const converted = project(source);
  assert.deepEqual(converted.unresolved, []);
  assert.match(converted.output, /context: z\.core\.ParsePayload/);
  assert.match(converted.output, /context\.issues\.push\(\{ code: 'custom', path: \['value'\], message: 'bad value', input: context\.value \}\)/);
  const before = evaluate(source, classic, 'S');
  const after = evaluate(converted.output, mini, 'S');
  for (const value of ['bad', ' ok ']) assert.deepEqual(outcome(after, value), outcome(before, value));
});

test('mixed helper retains native SuperRefine continuation and handles transform payload', () => {
  const source = `function addIssue(context: z.core.$RefinementCtx, message: string): void {
  context.addIssue({ code: 'custom', message, path: ['field'] });
}
const T = z.transform((value, ctx) => { addIssue(ctx, 'transform'); return z.NEVER; });
const R = z.string().check(z.superRefine((value, ctx) => { addIssue(ctx, 'refinement'); }), z.refine(() => false, 'later'));`;
  const converted = project(source);
  assert.deepEqual(converted.unresolved, []);
  assert.match(converted.output, /context: z\.core\.ParsePayload \| z\.core\.\$RefinementCtx/);
  assert.match(converted.output, /'addIssue' in context \? context\.addIssue\(\{ code: 'custom', message, path: \['field'\] \}\) : context\.issues\.push\(\{ code: 'custom', message, path: \['field'\], input: context\.value \}\)/);
  assert.equal(project(converted.output).output, converted.output);
  const before = evaluate(source, classic, '({ T, R })');
  const after = evaluate(converted.output, mini, '({ T, R })');
  assert.deepEqual(outcome(after.T, 'x'), outcome(before.T, 'x'));
  const refined = outcome(after.R, 'x');
  assert.deepEqual(refined, outcome(before.R, 'x'));
  assert.equal(refined.issues.length, 2);
});

test('unrelated imported SuperRefine callback does not refuse a proven named transform', () => {
  const source = `import { importedRefine, createRefine } from './refinements';
function transform(value: unknown, ctx: z.core.$RefinementCtx) {
  ctx.addIssue({ code: 'custom', message: 'invalid' });
  return z.NEVER;
}
const R = z.string().check(z.superRefine(importedRefine));
const Q = z.string().check(z.superRefine(createRefine()));
const T = z.transform(transform);`;
  const converted = project(source);
  assert.deepEqual(converted.unresolved, []);
  assert.match(converted.output, /const R = z\.string\(\)\.check\(z\.superRefine\(importedRefine\)\)/);
  assert.match(converted.output, /const Q = z\.string\(\)\.check\(z\.superRefine\(createRefine\(\)\)\)/);
  assert.match(converted.output, /ctx: z\.core\.ParsePayload/);
  assert.match(converted.output, /ctx\.issues\.push\(/);
  const unprovenTransform = project(`import { importedTransform } from './transforms';
const T = z.transform(importedTransform);`);
  assert.equal(unprovenTransform.overrides.size, 0);
  assert.ok(unprovenTransform.unresolved.some(item => item.reason.includes('not a unique local function')));
});

test('source-proven pure imported transform callback is accepted without hiding unknown callbacks', () => {
  const imported = `import { normalize } from './normalize';
const S = z.transform(normalize);`;
  assert.ok(project(imported).unresolved.some(item => item.method === 'context'));
  const proven = project(imported, node => node.text === 'normalize');
  assert.deepEqual(proven.unresolved, []);
  assert.equal(proven.overrides.size, 0);
  assert.equal(proven.output, imported);

  const unknown = project(`import { opaque } from './normalize';
const S = z.transform(opaque);`, node => node.text === 'normalize');
  assert.ok(unknown.unresolved.some(item => item.reason.includes('not a unique local function')));
  const expression = project(`import { create } from './normalize';
const S = z.transform(create());`, () => true);
  assert.ok(expression.unresolved.some(item => item.reason.includes('unproven binding')));

  const local = project(`function normalize(value: unknown, ctx: z.core.$RefinementCtx) {
  ctx.addIssue({ code: 'custom', message: 'invalid' });
  return z.NEVER;
}
const S = z.transform(normalize);`, () => true);
  assert.deepEqual(local.unresolved, []);
  assert.match(local.output, /ctx: z\.core\.ParsePayload/);
});

test('accepts a unique nested one-argument transform callback without changing its bytes', () => {
  const source = `function owner(parse: (value: unknown) => string) {
  function parseStored(value: unknown): string { return parse(value); }
  const S = z.pipe(z.unknown(), z.transform(parseStored));
  return S;
}`;
  const converted = project(source);
  assert.deepEqual(converted.unresolved, []);
  assert.equal(converted.output, source);

  const shadowed = project(`function owner() {
  function parseStored(value: unknown): unknown { return value; }
  {
    const parseStored = (...args: unknown[]) => args[1];
    return z.transform(parseStored);
  }
}`);
  assert.ok(shadowed.unresolved.some(item => item.reason.includes('shadowed')));
});

test('refuses ambiguous helper context flow and unsupported issue shapes', () => {
  const untyped = project(`function helper(ctx) { ctx.addIssue({ code: 'custom', message: 'x' }); }
const S = z.transform((value, ctx) => { helper(ctx); return z.NEVER; });`);
  assert.equal(untyped.overrides.size, 0);
  assert.ok(untyped.unresolved.some(item => item.reason.includes('lacks a proven RefinementCtx type')));
  const ambiguous = project(`function helper(ctx: z.core.$RefinementCtx) { ctx.addIssue({ code: 'custom', message: 'x' }); }
function unknown(ctx: z.core.$RefinementCtx) { return ctx; }
const S = z.transform((value, ctx) => { unknown(ctx); helper(ctx); return z.NEVER; });`);
  assert.equal(ambiguous.overrides.size, 0);
  assert.ok(ambiguous.unresolved.some(item => item.method === 'context'));
  const unsupported = project(`function helper(ctx: z.core.$RefinementCtx) { ctx.addIssue({ code: 'custom', message: 'x', fatal: true }); }
const S = z.transform((value, ctx) => { helper(ctx); return z.NEVER; });`);
  assert.equal(unsupported.overrides.size, 0);
  assert.ok(unsupported.unresolved.some(item => item.method === 'addIssue'));
  const shadowed = project(`function helper(ctx: z.core.$RefinementCtx) { ctx.addIssue({ code: 'custom', message: 'x' }); }
const S = z.transform((value, ctx) => { const helper = (other: unknown) => other; helper(ctx); return z.NEVER; });`);
  assert.equal(shadowed.overrides.size, 0);
  assert.ok(shadowed.unresolved.some(item => item.reason.includes('shadowed')));
  const callbackShadowed = project(`function helper(value: unknown, ctx: z.core.$RefinementCtx) { ctx.addIssue({ code: 'custom', message: 'x' }); return z.NEVER; }
function make() { const helper = (value: unknown) => value; return z.transform(helper); }`);
  assert.equal(callbackShadowed.overrides.size, 0);
  assert.ok(callbackShadowed.unresolved.some(item => item.reason.includes('shadowed')));
  for (const issue of [`'bad'`, `{ code: 'custom', message: 'x', continue: true }`]) {
    const refused = project(`function helper(ctx: z.core.$RefinementCtx) { ctx.addIssue(${issue}); }
const S = z.transform((value, ctx) => { helper(ctx); return z.NEVER; });`);
    assert.equal(refused.overrides.size, 0);
    assert.ok(refused.unresolved.some(item => item.method === 'addIssue'));
  }
  const doubled = project(`function helper(ctx: z.core.$RefinementCtx) { ctx.issues.push({ code: 'custom', message: 'first', input: ctx.value }); ctx.addIssue({ code: 'custom', message: 'second' }); }
const S = z.transform((value, ctx) => { helper(ctx); return z.NEVER; });`);
  assert.equal(doubled.overrides.size, 0);
  assert.ok(doubled.unresolved.some(item => item.reason.includes('mixes raw')));
});

test('recognizes the six current owner files without claiming unrelated refinement contexts', () => {
  const files = [
    'plugins/data/accountKvValueV1.ts',
    'plugins/settings/accountSettingsV1.ts',
    'plugins/openableContent.ts',
    'plugins/contributions/agentExternalSessions.ts',
    'providers/connections/catalogSchemasV1.ts',
    'automations/automationRunExecutionRecipeV1.ts',
  ];
  for (const file of files) {
    const source = readFileSync(resolve(import.meta.dirname, '../../../packages/protocol/src', file), 'utf8');
    const result = project(source);
    assert.deepEqual(result.unresolved.map(({ method, reason }) => ({ method, reason })), [], file);
    assert.match(result.output, /z\.core\.ParsePayload/, file);
    assert.match(result.output, /\.issues\.push\(/, file);
    if (file.includes('accountKvValueV1') || file.includes('accountSettingsV1')) {
      assert.match(result.output, /core\.ParsePayload \| z\.core\.\$RefinementCtx/, file);
      assert.match(result.output, /'addIssue' in context/, file);
    }
    if (file.includes('catalogSchemasV1') || file.includes('automationRunExecutionRecipeV1')) {
      assert.match(result.output, /'input' in issue \? issue\.input \?\? context\.value : context\.value/, file);
      assert.match(result.output, /as z\.core\.\$ZodRawIssue/, file);
    }
  }
});
