import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { transformSource } from './index.mjs';
import { z as classic } from 'zod';
import { z as mini } from 'zod/mini';

const convert = source => transformSource(source, 'fixture.ts');
const evaluate = (code, z, returnExpression) => {
  const body = code.replace(/^import[^\n]+\n/gm, '');
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function('z', `${js}\nreturn ${returnExpression};`)(z);
};
const outcome = (schema, value) => {
  const result = schema.safeParse(value);
  return result.success ? { success: true, data: result.data } : {
    success: false,
    issues: result.error.issues.map(({ code, path, message }) => ({ code, path, message })),
  };
};

test('converts nested string checks and wrappers, preserving Mini behavior', () => {
  const source = `import { z } from 'zod';\nconst S = z.string().trim().min(2).max(4).optional();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /from 'zod\/mini'/);
  assert.match(result.output, /z\.optional\(z\.string\(\)\.check\(z\.trim\(\), z\.minLength\(2\), z\.maxLength\(4\)\)\)/);
  assert.equal(convert(result.output).output, result.output);
});

test('transforms derived object and refinement chains without changing parse calls', () => {
  const source = `import * as v from "zod/v4";\nconst Base = v.object({ a: v.string() }).strict();\nconst Next = Base.extend({ b: v.coerce.number().min(0) }).pick({ b: true }).refine(x => x.b > 1);\nNext.safeParse({ b: 2 });\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /v\.strictObject\(\{ a: v\.string\(\) \}\)/);
  assert.match(result.output, /v\.pick\(v\.extend\(Base, \{ b: v\.coerce\.number\(\)\.check\(v\.minimum\(0\)\) \}\), \{ b: true \}\)\.check\(v\.refine\(/);
  assert.match(result.output, /Next\.safeParse\(\{ b: 2 \}\)/);
});

test('converts core type and error references but leaves unrelated methods alone', () => {
  const source = `import { z as v } from 'zod';\nconst S: v.ZodType<string> = v.string();\nconst parsed = S.parse('x');\nconst values = ['x'].map(x => x.trim());\nif (parsed instanceof v.ZodError) throw parsed;\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /v\.ZodMiniType<string>/);
  assert.match(result.output, /instanceof v\.core\.\$ZodError/);
  assert.match(result.output, /x\.trim\(\)/);
  assert.match(result.output, /S\.parse\('x'\)/);
});

test('maps named Zod schema type imports while preserving their local type names', () => {
  const source = `import { z, ZodType, ZodObject as ObjectSchema } from 'zod';\nconst S: ZodType<string> = z.string();\nconst O: ObjectSchema = z.object({ x: S });\nconst N = O.partial();\nfunction optionalParameter(s: ZodType<string>) { return s.optional(); }\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /ZodMiniType as ZodType/);
  assert.match(result.output, /ZodMiniObject as ObjectSchema/);
  assert.match(result.output, /z\.partial\(O\)/);
  assert.match(result.output, /return z\.optional\(s\)/);
});

test('named Classic core imports use Mini core for runtime errors and result types', () => {
  const source = `import { ZodError, type ZodRawShape, type ZodSafeParseResult } from 'zod';\nconst IsZod = (error: unknown): error is ZodError => error instanceof ZodError;\ntype Shape = ZodRawShape;\ntype Result = ZodSafeParseResult<string>;\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /import \{ z as zodMiniCore\d+.*\} from 'zod\/mini'/);
  assert.match(result.output, /instanceof zodMiniCore\d+\.core\.\$ZodError/);
  assert.match(result.output, /zodMiniCore\d+\.core\.\$ZodShape/);
  assert.match(result.output, /zodMiniCore\d+\.core\.util\.SafeParseResult<string>/);
  assert.equal(convert(result.output).output, result.output);
});

test('reports unsupported schema calls and preserves the whole file', () => {
  const source = `import { z } from 'zod';\nconst S = z.object({ a: z.string().min(2) });\nconst Broken = S.strip();\nconst Unsupported = z.string().unwrap();\n`;
  const result = convert(source);
  assert.equal(result.output, source);
  assert.equal(result.changed, false);
  assert.deepEqual(result.unresolved.map(item => item.method), ['unwrap']);
  assert.deepEqual(result.unresolved.map(item => item.line), [4]);
});

test('retains JSON Schema and error helper semantics through a Mini namespace', () => {
  const source = `import * as z from 'zod';\nconst S = z.string().email().describe('address');\nconst json = S.toJSONSchema({ io: 'input' });\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.string\(\)\.check\(z\.email\(\), z\.describe\('address'\)\)/);
  assert.match(result.output, /z\.toJSONSchema\(S, \{ io: 'input' \}\)/);
});

test('converted schemas preserve normalized values and issue codes/paths', () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\nconst S = z.object({ title: z.string().trim().min(2), count: z.number().min(0).optional() }).strict();\n`;
  const output = convert(source);
  assert.deepEqual(output.unresolved, []);
  const before = evaluate(source, classic, 'S'), after = evaluate(output.output, mini, 'S');
  for (const value of [{ title: ' ok ', count: 2 }, { title: 'x' }, { title: ' ok ', extra: true }]) {
    assert.deepEqual(outcome(after, value), outcome(before, value));
  }
});

test('explicit transform output matching its input captures the concrete Mini pipe input type', () => {
  const source = `import { z } from 'zod/mini';\nconst S = z.pipe(z.looseObject({ v: z.literal(1), links: z._default(z.array(z.object({ id: z.string(), mode: z.optional(z.string()) })), []) }), z.transform((value): typeof value => ({ ...value, links: value.links.map(link => ({ ...link, mode: link.mode ?? 'manual' })) })));\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /\.apply\(\(schema\) => z\.pipe\(schema, z\.transform<z\.output<typeof schema>, z\.output<typeof schema>>/);
  const before = evaluate(source, mini, 'S'), after = evaluate(result.output, mini, 'S');
  for (const value of [{ v: 1 }, { v: 1, links: [{ id: 'a' }], extra: 'kept' }, { v: 2 }, { v: 1, links: [{ id: 1 }] }]) {
    assert.deepEqual(outcome(after, value), outcome(before, value));
  }
  assert.equal(convert(result.output).output, result.output);
});

test('strict, strip, passthrough, default factories and refinement order retain behavior', () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\nconst Strict = z.object({ v: z.string() }).strict();\nconst Strip = z.object({ v: z.string() }).strip();\nconst Loose = z.object({ v: z.string() }).passthrough();\nconst Default = z.array(z.number()).default(() => []);\nconst Refined = z.string().refine(x => x.length > 2, 'too short').transform(x => x.toUpperCase());\n`;
  const converted = convert(source);
  assert.deepEqual(converted.unresolved, []);
  const before = evaluate(source, classic, '({ Strict, Strip, Loose, Default, Refined })');
  const after = evaluate(converted.output, mini, '({ Strict, Strip, Loose, Default, Refined })');
  for (const name of ['Strict', 'Strip', 'Loose']) {
    for (const value of [{ v: 'x' }, { v: 'x', extra: 1 }, { v: 2 }]) {
      assert.deepEqual(outcome(after[name], value), outcome(before[name], value), name);
    }
  }
  for (const value of ['ab', 'abc']) assert.deepEqual(outcome(after.Refined, value), outcome(before.Refined, value));
  const first = after.Default.parse(undefined), second = after.Default.parse(undefined);
  assert.deepEqual(first, before.Default.parse(undefined));
  assert.notEqual(first, second);
});

test('literal enum extract and exclude preserve members, order, and parse failures', () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\nconst lazyZodSchema = f => f();\nconst Base = lazyZodSchema(() => z.enum(['a', 'b', 'c']));\nconst Kept = lazyZodSchema(() => Base.extract(['c', 'a']));\nconst Removed = lazyZodSchema(() => Base.exclude(['b']));\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.enum\(\(\['c', 'a'\] as const\)\.map/);
  assert.match(result.output, /values\.filter/);
  const before = evaluate(source, classic, '({ Kept, Removed })');
  const after = evaluate(result.output, mini, '({ Kept, Removed })');
  for (const key of ['Kept', 'Removed']) {
    assert.deepEqual(after[key].options, before[key].options);
    for (const value of ['a', 'b', 'c', 'x']) assert.deepEqual(outcome(after[key], value), outcome(before[key], value));
  }
});

test('named enum exclusions preserve literal output and reject an absent member', () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\nconst EXCLUDED = ['b'] as const;\nconst Base = z.enum(['a', 'b', 'c']);\nconst Removed = Base.exclude(EXCLUDED);\nconst Invalid = () => Base.exclude(['missing']);\n`;
  const converted = convert(source);
  assert.deepEqual(converted.unresolved, []);
  assert.match(converted.output, /<const Values extends readonly string\[], const Excluded extends readonly Values\[number\]\[]>/);
  const before = evaluate(source, classic, '({ Removed, Invalid })');
  const after = evaluate(converted.output, mini, '({ Removed, Invalid })');
  assert.deepEqual(after.Removed.options, before.Removed.options);
  for (const value of ['a', 'b', 'c', 'x']) assert.deepEqual(outcome(after.Removed, value), outcome(before.Removed, value));
  assert.throws(before.Invalid, /Key missing not found in enum/);
  assert.throws(after.Invalid, /Key missing not found in enum/);
});

test('keyof options stay public enum options while an imported union shape uses core options', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-shape-options-'));
  try {
    writeFileSync(join(fixture, 'producer.ts'), `import { z } from 'zod/mini';\nexport const Root = z.strictObject({ source: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('a') }), z.strictObject({ kind: z.literal('b') })]) });\n`);
    const consumer = join(fixture, 'consumer.ts');
    writeFileSync(consumer, `import { z } from 'zod';\nimport { Root } from './producer.js';\nconst input = z.object(Root.shape);\nconst options = input.shape.source.options;\nconst keys = input.keyof().options;\n`);
    const report = JSON.parse(execFileSync(process.execPath,
      [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)],
      { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    const output = readFileSync(consumer, 'utf8');
    assert.match(output, /input\.shape\.source\._zod\.def\.options/);
    assert.match(output, /z\.keyof\(input\)\.options/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('imported discriminated-union options migrate in runtime and indexed type positions', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-union-options-'));
  try {
    writeFileSync(join(fixture, 'producer.ts'), `import { z } from 'zod/mini';\nexport const Union = z.discriminatedUnion('kind', [z.strictObject({kind:z.literal('a')}),z.strictObject({kind:z.literal('b')})]);\n`);
    const consumer = join(fixture, 'consumer.ts');
    writeFileSync(consumer, `import { z } from 'zod';\nimport { Union } from './producer.js';\ntype Option = (typeof Union)['options'][number];\nconst options = Union.options;\nconst selected = Union.options.find(option => option.shape.kind.value === 'a');\n`);
    const report = JSON.parse(execFileSync(process.execPath,
      [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)],
      { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    const output = readFileSync(consumer, 'utf8');
    assert.match(output, /type Option = \(typeof Union\)\['_zod'\]\['def'\]\['options'\]\[number\]/);
    assert.match(output, /const options = Union\._zod\.def\.options/);
    assert.match(output, /option\.shape\.kind\._zod\.def\.values\[0\]/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('proven schema output indexed types use the Mini output utility', () => {
  const source = `import { z } from 'zod';\nconst S = z.object({ id: z.string() });\ntype Value = (typeof S)['_output'];\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /type Value = z\.output<\(typeof S\)>/);
});

test('a proven singleton literal exposes its Mini value without rewriting ordinary values', () => {
  const source = `import { z } from 'zod';\nconst L = z.literal('one');\nconst value = L.value;\nconst ordinary = { value: 2 };\nconst count = ordinary.value;\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /L\._zod\.def\.values\[0\]/);
  assert.match(result.output, /ordinary\.value/);
});

test('already emitted core union options preserve wrapper and array field lineage', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-core-option-field-'));
  try {
    writeFileSync(join(fixture, 'producer.ts'), `import { z } from 'zod/mini';\nexport const Union = z.union([z.strictObject({items:z.optional(z.array(z.string()))}),z.strictObject({reason:z.string()})]);\n`);
    const consumer = join(fixture, 'consumer.ts');
    writeFileSync(consumer, `import { z } from 'zod/mini';\nimport { Union } from './producer.js';\nconst item = Union._zod.def.options[0].shape.items.unwrap().element;\n`);
    const report = JSON.parse(execFileSync(process.execPath,
      [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)],
      { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    assert.match(readFileSync(consumer, 'utf8'), /Union\._zod\.def\.options\[0\]\.shape\.items\._zod\.def\.innerType\._zod\.def\.element/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('union option callbacks inherit member-object and singleton literal lineage', () => {
  const source = `import { z } from 'zod';\nconst U = z.discriminatedUnion('kind', [z.object({kind:z.literal('a'),id:z.string()}),z.object({kind:z.literal('b'),id:z.string()})]);\nconst selected = U.options.find(option => option.shape.kind.value === 'a');\nconst strict = U.options.map(option => option.strict());\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /option\.shape\.kind\._zod\.def\.values\[0\]/);
  assert.match(result.output, /z\.core\.clone\(schema, \{ \.\.\.schema\._zod\.def, catchall: z\.never\(\) \}\)/);
});

test('a const array of proven Mini object variants retains singleton literal callback fields', () => {
  const source = `import { z } from 'zod/mini';\nfunction lazyZodSchema<T>(factory: () => T): T { return factory(); }\nconst Common = z.strictObject({ id: z.string() });\nconst Variants = [\n  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(Common, { capability: z.literal('one') }))),\n  z.strictObject({ capability: z.literal('two') }),\n] as const;\nconst capabilities = Variants.map(schema => schema.shape.capability.value);\nconst ordinary = [{ shape: { capability: { value: 'ordinary' } } }].map(item => item.shape.capability.value);\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /schema\.shape\.capability\._zod\.def\.values\[0\]/);
  assert.match(result.output, /item\.shape\.capability\.value/);
  const after = evaluate(result.output, mini, '({ capabilities, ordinary })');
  assert.deepEqual(after, { capabilities: ['one', 'two'], ordinary: ['ordinary'] });
  assert.equal(convert(result.output).output, result.output);
});

test('a proven type-guard refinement retains narrowed Mini output without changing parsing', () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\ntype Digest = \`sha256:\${string}\`;\nfunction isDigest(value: string): value is Digest { return /^sha256:[a-f0-9]+$/.test(value); }\nconst S = z.string().trim().refine(isDigest);\n`;
  const converted = convert(source);
  assert.deepEqual(converted.unresolved, []);
  assert.match(converted.output, /\.apply\(\(base\) => base\.check\(z\.refine<z\.output<typeof base>>\(isDigest\)\) as typeof base & z\.ZodMiniType<Digest, z\.input<typeof base>>\)/);
  const before = evaluate(source, classic, 'S');
  const after = evaluate(converted.output, mini, 'S');
  for (const value of [' sha256:abc ', 'sha256:XYZ', 'bad', 12]) assert.deepEqual(outcome(after, value), outcome(before, value));
  const alreadyMini = source.replace("from 'zod'", "from 'zod/mini'").replace('z.string().trim().refine(isDigest)', 'z.string().check(z.trim(), z.refine(isDigest))');
  const repaired = convert(alreadyMini);
  assert.deepEqual(repaired.unresolved, []);
  assert.match(repaired.output, /\.apply\(\(base\) => base\.check\(z\.trim\(\), z\.refine<z\.output<typeof base>>\(isDigest\)\)/);
  assert.equal(convert(repaired.output).output, repaired.output);
});

test('proven Mini string maximum reflection reads the core bag without touching ordinary data', () => {
  const source = `import { z } from 'zod';\nconst S = z.string().max(256);\nconst limit = S.maxLength ?? 0;\nconst ordinary = { maxLength: 4 };\nconst number = ordinary.maxLength;\n`;
  const converted = convert(source);
  assert.deepEqual(converted.unresolved, []);
  assert.match(converted.output, /S\._zod\.bag\.maximum \?\? 0/);
  assert.match(converted.output, /ordinary\.maxLength/);
  const schema = evaluate(converted.output, mini, 'S');
  assert.equal(schema._zod.bag.maximum, 256);
});

test('bound safeExtend uses the native Mini function and retains object refinements', () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\nconst Base = z.object({ id: z.string() }).refine(v => v.id !== 'bad', { message: 'blocked' });\nconst extend = Base.safeExtend.bind(Base);\nconst Next = extend({ more: z.number() });\n`;
  const converted = convert(source);
  assert.deepEqual(converted.unresolved, []);
  assert.match(converted.output, /z\.safeExtend\.bind\(null, Base\)/);
  const before = evaluate(source, classic, 'Next');
  const after = evaluate(converted.output, mini, 'Next');
  for (const value of [{ id: 'ok', more: 1 }, { id: 'bad', more: 1 }, { id: 'ok', more: 'bad' }]) {
    assert.deepEqual(outcome(after, value), outcome(before, value));
  }
});

test('an explicitly Zod-typed local factory proves schema lineage across multiple returns', () => {
  const source = `import { z } from 'zod';\nfunction make(depth: number): z.ZodType<string> { if (depth === 0) return z.string(); return z.string().min(1); }\nconst S = make(2);\nconst Optional = S.optional();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.optional\(S\)/);
});

test('a terminating Mini lazy guard permits exact inner schema reflection', () => {
  const source = `import { z } from 'zod';\ndeclare function get(): unknown;\nfunction inspect() { const schema = get(); if (!(schema instanceof z.ZodLazy)) throw new Error('not lazy'); return schema.unwrap(); }\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /instanceof z\.ZodMiniLazy/);
  assert.match(result.output, /schema\._zod\.innerType/);
});

test('array/record/number checks and input JSON Schema projection retain behavior', () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\nconst S = z.record(z.string(), z.array(z.number().min(0)).min(1));\nconst JSON = S.toJSONSchema({ io: 'input', target: 'draft-2020-12', unrepresentable: 'throw' });\n`;
  const converted = convert(source);
  assert.deepEqual(converted.unresolved, []);
  const before = evaluate(source, classic, '({ S, JSON })');
  const after = evaluate(converted.output, mini, '({ S, JSON })');
  for (const value of [{ ok: [1] }, { ok: [] }, { ok: [-1] }, { ok: ['bad'] }]) {
    assert.deepEqual(outcome(after.S, value), outcome(before.S, value));
  }
  assert.deepEqual(after.JSON, before.JSON);
});

test('proven schema imports can be converted without a local Zod import', () => {
  const source = `import { BaseSchema } from './schema';\nexport const Next = BaseSchema.optional();\n`;
  const result = transformSource(source, 'consumer.ts', { importedSchemas: new Set(['BaseSchema']) });
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /^import \* as z from 'zod\/mini';/);
  assert.match(result.output, /z\.optional\(BaseSchema\)/);
  assert.equal(transformSource(result.output, 'consumer.ts', { importedSchemas: new Set(['BaseSchema']) }).output, result.output);
});

test('imported functions with a proven schema return convert direct and assigned chains', () => {
  const source = `import { asProtocolZod } from './adapter';\nconst Direct = asProtocolZod(input).nullable();\nconst Base = asProtocolZod(input);\nconst Optional = Base.optional();\n`;
  const result = transformSource(source, 'consumer.ts', { importedSchemaFactories: new Set(['asProtocolZod']) });
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.nullable\(asProtocolZod\(input\)\)/);
  assert.match(result.output, /z\.optional\(Base\)/);
  assert.equal(transformSource(result.output, 'consumer.ts', { importedSchemaFactories: new Set(['asProtocolZod']) }).output, result.output);
});

test('bridge mode changes only proven factory chains and leaves unrelated Classic builders in place', () => {
  const source = `import { z } from 'zod';\nimport { asProtocolZod } from './adapter';\nconst Unrelated = z.object({ x: z.string() }).strict();\nconst Direct = asProtocolZod(input).nullable();\nconst Base = asProtocolZod(input);\nconst Optional = Base.optional();\n`;
  const options = { factoryOnly: true, importedSchemaFactories: new Set(['asProtocolZod']) };
  const result = transformSource(source, 'consumer.ts', options);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /import \* as zMini from 'zod\/mini';/);
  assert.match(result.output, /from 'zod';/);
  assert.match(result.output, /z\.object\(\{ x: z\.string\(\) \}\)\.strict\(\)/);
  assert.match(result.output, /zMini\.nullable\(asProtocolZod\(input\)\)/);
  assert.match(result.output, /zMini\.optional\(Base\)/);
  assert.equal(transformSource(result.output, 'consumer.ts', options).output, result.output);
});

test('bridge mode follows an imported schema exported from a proven Mini factory', () => {
  const source = `import { z } from 'zod';\nimport { ExportedSchema } from './producer';\nconst Optional = ExportedSchema.optional();\n`;
  const result = transformSource(source, 'consumer.ts', {
    factoryOnly: true,
    importedSchemas: new Map([['ExportedSchema', { kind: 'unknown', bridge: true }]]),
  });
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /zMini\.optional\(ExportedSchema\)/);
});

test('ambiguous schema symbols and unsupported namespace APIs are reported without writing', () => {
  const source = `import { z } from 'zod';\nconst x = ImportedSchema.optional();\nz.setErrorMap(() => ({ message: 'x' }));\n`;
  const result = convert(source);
  assert.equal(result.output, source);
  assert.deepEqual(result.unresolved.map(item => item.method), ['optional', 'setErrorMap']);
});

test('parse results, callback values and ordinary strings are not classified as schemas', () => {
  const source = `import { z } from 'zod';\nconst S = z.string().superRefine((value, ctx) => { if (!value.trim()) ctx.addIssue({ code: 'custom', message: 'empty' }); });\nconst N = z.number().superRefine((value, ctx) => { if (value < 0) ctx.addIssue({ code: 'custom', message: 'negative' }); });\nconst A = S.safeParse(' a ');\nconst B = S.safeParse('b');\nif (A.success) A.data.trim();\nif (B.success) B.data.toString();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /A\.success/);
  assert.match(result.output, /A\.data\.trim\(\)/);
  assert.match(result.output, /ctx\.addIssue/);
  assert.match(result.output, /B\.data\.toString\(\)/);
});

test('object shape members and union options retain schema lineage', () => {
  const source = `import { z } from 'zod';\nconst Base = z.object({ field: z.string() });\nconst Child = Base.shape.field.optional();\nconst Union = z.union([Base, z.object({ other: z.number() })]);\nconst Extended = Union.options[0].extend({ extra: z.boolean() });\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.optional\(Base\.shape\.field\)/);
  assert.match(result.output, /z\.extend\(Union\._zod\.def\.options\[0\], \{ extra: z\.boolean\(\) \}\)/);
});

test('a local alias of proven union options retains each member schema', () => {
  const source = `import { z } from 'zod';\nconst Union = z.discriminatedUnion('kind', [z.object({ kind: z.literal('one') }), z.object({ kind: z.literal('two'), value: z.string() })]);\nconst options = Union.options;\nconst Extended = options[1].extend({ extra: z.boolean() });\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /const options = Union\._zod\.def\.options/);
  assert.match(result.output, /const Extended = z\.extend\(options\[1\], \{ extra: z\.boolean\(\) \}\)/);
  const before = evaluate(source, classic, 'Extended');
  const after = evaluate(result.output, mini, 'Extended');
  for (const value of [{ kind: 'two', value: 'ok', extra: true }, { kind: 'one', extra: true }, { kind: 'two', value: 'ok', extra: 'bad' }]) {
    assert.deepEqual(outcome(after, value), outcome(before, value));
  }
  assert.equal(convert(result.output).output, result.output);
});

test('an explicitly typed Mini schema field projects JSON Schema without rewriting ordinary fields', () => {
  const source = `import { z } from 'zod/mini';\nfunction project(input: Readonly<{ schema: z.ZodMiniType; ordinary: { toJSONSchema: () => string } }>) { return [input.schema.toJSONSchema({ io: 'input' }), input.ordinary.toJSONSchema()]; }\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.toJSONSchema\(input\.schema, \{ io: 'input' \}\)/);
  assert.match(result.output, /input\.ordinary\.toJSONSchema\(\)/);
  assert.equal(convert(result.output).output, result.output);
});

test('lazy factory bodies and retained wrappers convert, reflective outer calls remain unsafe', () => {
  const source = `import { z } from 'zod';\nconst S = lazyZodSchema(() => z.string().min(1));\nconst Maybe = S.optional();\nMaybe.parse('x');\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /lazyZodSchema\(\(\) => z\.string\(\)\.check\(z\.minLength\(1\)\)\)/);
  assert.match(result.output, /z\.optional\(S\)/);
  assert.match(result.output, /Maybe\.parse\('x'\)/);
  const derived = source.replace('S.optional()', 'S.extend({ a: z.string() })');
  assert.equal(convert(derived).output, derived);
  assert.ok(convert(derived).unresolved.some(item => item.method === 'extend'));
});

test('reflective derivation inside a lazy factory remains cold', () => {
  const source = `import { z } from 'zod';\nconst Base = lazyZodSchema(() => z.object({ a: z.string() }));\nconst Derived = lazyZodSchema(() => Base.extend({ b: z.number() }).pick({ b: true }));\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /lazyZodSchema\(\(\) => z\.pick\(z\.extend\(Base, \{ b: z\.number\(\) \}\), \{ b: true \}\)\)/);
});

test('reflective derivation outside a lazy factory is deferred through its existing helper', () => {
  const source = `import { z } from 'zod';\nimport { lazyZodSchema } from './lazyZodSchema';\nconst Base = lazyZodSchema(() => z.object({ a: z.string() }));\nconst Derived = Base.extend({ b: z.number() }).pick({ b: true });\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /const Derived = lazyZodSchema\(\(\) => z\.pick\(z\.extend\(Base, \{ b: z\.number\(\) \}\), \{ b: true \}\)\)/);
});

test('a known owner helper import is added for cold derivation when absent', () => {
  const source = `import { z } from 'zod';\nimport { BaseSchema } from './base';\nconst Derived = BaseSchema.extend({ b: z.number() });\n`;
  const options = { importedSchemas: new Map([['BaseSchema', { kind: 'object', cold: true }]]), lazyHelperImport: './lazyZodSchema.js' };
  const result = transformSource(source, 'consumer.ts', options);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /^import \{ lazyZodSchema \} from '\.\/lazyZodSchema\.js';/);
  assert.match(result.output, /const Derived = lazyZodSchema\(\(\) => z\.extend\(BaseSchema, \{ b: z\.number\(\) \}\)\)/);
  assert.equal(transformSource(result.output, 'consumer.ts', options).output, result.output);
});

test('local Zod-returning factory calls and aliases retain schema lineage', () => {
  const source = `import { z } from 'zod';\nfunction makeText() { return z.string().min(2); }\nconst Alias = makeText();\nconst Maybe = Alias.optional();\nconst Direct = makeText().nullable();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /const Maybe = z\.optional\(Alias\)/);
  assert.match(result.output, /const Direct = z\.nullable\(makeText\(\)\)/);
  assert.equal(convert(result.output).output, result.output);
});

test('protocol-composable fluent methods are not mistaken for Zod schemas', () => {
  const source = `import { z } from 'zod';\nconst ActionInvokeInputProtocolSchema = defineProtocolObject({ input: true });\nconst Optional = ActionInvokeInputProtocolSchema.optional();\nconst Actual = z.string().optional();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /ActionInvokeInputProtocolSchema\.optional\(\)/);
  assert.match(result.output, /z\.optional\(z\.string\(\)\)/);
});

test('wrapper unwrapping retains the original child schema and lazy resolution', () => {
  const source = `import { z } from 'zod';\nconst Inner = z.string();\nconst Optional = Inner.optional();\nconst Defaulted = Inner.default('x');\nconst Caught = Inner.catch('x');\nconst Lazy = z.lazy(() => Inner);\nconst Children = [Optional.unwrap(), Defaulted.removeDefault(), Caught.removeCatch(), Lazy.unwrap()];\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /Optional\._zod\.def\.innerType/);
  assert.match(result.output, /Defaulted\._zod\.def\.innerType/);
  assert.match(result.output, /Caught\._zod\.def\.innerType/);
  assert.match(result.output, /Lazy\._zod\.innerType/);
  const before = evaluate(source, classic, '({ Inner, Children })');
  const after = evaluate(result.output, mini, '({ Inner, Children })');
  for (const child of after.Children) assert.equal(child, after.Inner);
  for (const child of before.Children) assert.equal(child, before.Inner);
});

test('a Zod-constrained generic schema parameter has proven fluent lineage', () => {
  const source = `import { z } from 'zod';\nfunction optionalText<TText extends z.ZodTypeAny>(textSchema: TText) { return textSchema.optional(); }\nconst Result = optionalText(z.string());\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /TText extends z\.ZodMiniType/);
  assert.match(result.output, /return z\.optional\(textSchema\)/);
});

test('Mini instanceof schema construction stays a Zod factory', () => {
  const source = `import { z } from 'zod';\nconst Bytes = z.instanceof(Uint8Array).optional();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.optional\(z\.instanceof\(Uint8Array\)\)/);
});

test('relative export proof distinguishes schema aliases, neutral DSL, and descriptor return values', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-lineage-'));
  try {
    writeFileSync(join(fixture, 'producer.ts'), `import { z } from 'zod';\nexport const ActualSchema = z.string();\nexport { ActualSchema as ReExportedSchema };\nexport const EnvelopeSchema = z.object({ child: z.object({ a: z.string() }).strict(), name: z.string().default('x'), list: z.array(z.string()) });\nfunction makeRecord() { const hintsSchema = z.object({ title: z.string() }); return Object.freeze({ hintsSchema }); }\nexport function exportedFactory() { return makeRecord(); }\nexport const NeutralSchema = defineProtocolObject({});\nexport function unwrapActionInputSchema(schema: z.ZodTypeAny): Readonly<{ schema: z.ZodTypeAny; optional: boolean }> { return { schema, optional: true }; }\n`);
    const consumer = join(fixture, 'consumer.ts');
    writeFileSync(consumer, `import { z } from 'zod';\nimport { ReExportedSchema, EnvelopeSchema, exportedFactory, NeutralSchema, unwrapActionInputSchema } from './producer.js';\nconst Descriptor = unwrapActionInputSchema(ReExportedSchema);\nconst Flag = Descriptor.optional;\nconst Neutral = NeutralSchema.optional();\nconst Actual = ReExportedSchema.optional();\nconst Child = EnvelopeSchema.shape.child.strip();\nconst Name = EnvelopeSchema.shape.name.removeDefault();\nconst Element = EnvelopeSchema.shape.list.element;\nconst Records = exportedFactory();\nconst Hint = Records.hintsSchema.optional();\nconst Own = z.string().optional();\n`);
    const output = execFileSync(process.execPath, [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)], { cwd: repo, encoding: 'utf8' });
    const report = JSON.parse(output);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    const converted = readFileSync(consumer, 'utf8');
    assert.match(converted, /Descriptor\.optional/);
    assert.match(converted, /NeutralSchema\.optional\(\)/);
    assert.match(converted, /z\.optional\(ReExportedSchema\)/);
    assert.match(converted, /z\.core\.clone\(schema, \{ \.\.\.schema\._zod\.def, catchall: undefined \}\)/);
    assert.match(converted, /EnvelopeSchema\.shape\.name\._zod\.def\.innerType/);
    assert.match(converted, /EnvelopeSchema\.shape\.list\._zod\.def\.element/);
    assert.match(converted, /const Hint = z\.optional\(Records\.hintsSchema\)/);
    assert.match(converted, /z\.optional\(z\.string\(\)\)/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('CLI applies to an explicit scratch root using scratch package exports and refuses an outside path', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const scratch = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-scratch-'));
  const cli = join(repo, 'scripts/codemods/zod-mini/cli.mjs');
  try {
    const packageRoot = join(scratch, 'packages', 'protocol');
    const sourceRoot = join(packageRoot, 'src');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/protocol',
      exports: { './base': { 'happier-source': './src/base.ts' } },
    }));
    writeFileSync(join(sourceRoot, 'base.ts'), `import { z } from 'zod';\nexport const BaseSchema = z.string();\n`);
    const consumer = join(sourceRoot, 'consumer.ts');
    writeFileSync(consumer, `import { z } from 'zod';\nimport { BaseSchema } from '@happier-dev/protocol/base';\nconst Maybe = BaseSchema.optional();\n`);
    const report = JSON.parse(execFileSync(process.execPath,
      [cli, '--root', scratch, 'apply', '--write', 'packages/protocol/src/consumer.ts'],
      { cwd: repo, encoding: 'utf8' }));
    assert.equal(report.root, scratch);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    assert.match(readFileSync(consumer, 'utf8'), /z\.optional\(BaseSchema\)/);
    assert.throws(() => execFileSync(process.execPath,
      [cli, '--root', scratch, 'apply', '--write', join(repo, 'packages/protocol/src/lazyZodSchema.ts')],
      { cwd: repo, encoding: 'utf8', stdio: 'pipe' }), /Paths must be existing, bounded locations within this root/);
  } finally {
    rmSync(scratch, { recursive: true });
  }
});

test('imported Mini schema from a lazy functional object factory retains object kind', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-lazy-functional-'));
  try {
    const producer = join(fixture, 'producer.ts');
    writeFileSync(producer, `import { z } from 'zod/mini';\nconst Base = z.strictObject({ id: z.string() });\nexport const PromptDocArtifactRefV1Schema = lazyZodSchema(() => z.extend(Base, { kind: z.literal('doc') }));\n`);
    const consumer = join(fixture, 'consumer.ts');
    writeFileSync(join(fixture, 'lazy.ts'), `export const lazyZodSchema = <T>(factory: () => T): T => factory();\n`);
    writeFileSync(consumer, `import { z } from 'zod';\nimport { lazyZodSchema } from './lazy.js';\nimport { PromptDocArtifactRefV1Schema } from './producer.js';\nconst Strict = PromptDocArtifactRefV1Schema.strict();\n`);
    const report = JSON.parse(execFileSync(process.execPath,
      [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)],
      { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    assert.match(readFileSync(consumer, 'utf8'), /z\.core\.clone\(schema, \{ \.\.\.schema\._zod\.def, catchall: z\.never\(\) \}\)/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('imported frozen schema records prove named and string-keyed member lineage', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-frozen-record-'));
  try {
    writeFileSync(join(fixture, 'producer.ts'), `import { z } from 'zod/mini';\nconst Id = z.string();\nconst Grant = z.strictObject({ id: z.string(), granted: z.boolean() });\nexport const Fields = Object.freeze({ id: Id });\nexport const Table = Object.freeze({ 'grant': Grant });\n`);
    const consumer = join(fixture, 'consumer.ts');
    writeFileSync(consumer, `import { z } from 'zod';\nimport { Fields, Table } from './producer.js';\nconst Maybe = Fields.id.optional();\nconst Derived = Table['grant'].omit({ id: true }).strict();\n`);
    const report = JSON.parse(execFileSync(process.execPath,
      [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)],
      { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    const output = readFileSync(consumer, 'utf8');
    assert.match(output, /z\.optional\(Fields\.id\)/);
    assert.match(output, /z\.omit\(Table\['grant'\], \{ id: true \}\)/);
    assert.match(output, /z\.core\.clone\(schema, \{ \.\.\.schema\._zod\.def, catchall: z\.never\(\) \}\)/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('an exported const-asserted schema record proves only its Zod member fields', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-const-record-'));
  try {
    writeFileSync(join(fixture, 'producer.ts'), `import { z } from 'zod/mini';\nexport const Records = { 'action.run': z.strictObject({ a: z.string() }), meta: { optional: () => 'ordinary' } } as const;\n`);
    const consumer = join(fixture, 'consumer.ts');
    writeFileSync(consumer, `import { z } from 'zod/mini';\nimport { Records } from './producer.js';\nconst Derived = Records['action.run'].extend({ b: z.number() });\nconst Ordinary = Records.meta.optional();\n`);
    const report = JSON.parse(execFileSync(process.execPath,
      [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)],
      { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    const output = readFileSync(consumer, 'utf8');
    assert.match(output, /z\.extend\(Records\['action\.run'\], \{ b: z\.number\(\) \}\)/);
    assert.match(output, /Records\.meta\.optional\(\)/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('a forward schema binding is proven only inside a deferred lazy factory', () => {
  const source = `import { z } from 'zod';\nconst Derived = lazyZodSchema(() => Later.pick({ id: true }).strict());\nconst Later = lazyZodSchema(() => z.object({ id: z.string(), name: z.string() }).strict());\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.pick\(Later, \{ id: true \}\)/);
  const eager = convert(source.replace('lazyZodSchema(() => Later.pick({ id: true }).strict())', 'Later.pick({ id: true }).strict()'));
  assert.ok(eager.unresolved.length > 0);
  assert.equal(eager.output, source.replace('lazyZodSchema(() => Later.pick({ id: true }).strict())', 'Later.pick({ id: true }).strict()'));
});

test('typed core clone IIFE retains proven Mini object lineage through lazy export and alias', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-clone-iife-'));
  try {
    writeFileSync(join(fixture, 'producer.ts'), `import { z } from 'zod/mini';\nconst Base = z.object({ id: z.string() });\nexport const Derived = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(Base, { tag: z.literal('x') })));\n`);
    const consumer = join(fixture, 'consumer.ts');
    writeFileSync(join(fixture, 'lazy.ts'), `export const lazyZodSchema = <T>(factory: () => T): T => factory();\n`);
    writeFileSync(consumer, `import { z } from 'zod';\nimport { lazyZodSchema } from './lazy.js';\nimport { Derived } from './producer.js';\nconst Stripped = Derived.strip();\n`);
    const report = JSON.parse(execFileSync(process.execPath,
      [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)],
      { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    assert.match(readFileSync(consumer, 'utf8'), /z\.core\.clone\(schema, \{ \.\.\.schema\._zod\.def, catchall: undefined \}\)/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('authored public and build source folders are included in explicit inventory', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-authored-folders-'));
  try {
    for (const folder of ['public', 'build']) {
      mkdirSync(join(fixture, folder));
      writeFileSync(join(fixture, folder, 'schema.ts'), `import { z } from 'zod';\nexport const S = z.string().optional();\n`);
    }
    const report = JSON.parse(execFileSync(process.execPath,
      [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'scan', ...['public', 'build'].map(folder => relative(repo, join(fixture, folder, 'schema.ts')))],
      { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.failures, []);
    assert.equal(report.scanned, 2);
    assert.equal(report.files.length, 2);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('typed namespace parameter remains runtime receiver but not a type namespace in policy clones', () => {
  const source = `import { z } from 'zod';\nexport function make(zod: typeof z) {\n  const Base = zod.object({ id: zod.string() });\n  return Base.strict();\n}\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /zod\.core\.clone\(schema,/);
  assert.match(result.output, /<T extends z\.ZodMiniObject>/);
  assert.doesNotMatch(result.output, /zod\.ZodMiniObject|zod\.core\.\$strict/);
});

test('already emitted policy-clone types on an injected namespace are repaired idempotently', () => {
  const source = `import { z } from 'zod/mini';\nexport function make(zod: typeof z) {\n  return (<T extends zod.ZodMiniObject>(schema: T) => zod.core.clone(schema, { ...schema._zod.def, catchall: zod.never() }) as zod.ZodMiniObject<T['shape'], zod.core.$strict>)(zod.object({ id: zod.string() }));\n}\n`;
  const converted = convert(source);
  assert.deepEqual(converted.unresolved, []);
  assert.match(converted.output, /<T extends z\.ZodMiniObject>/);
  assert.match(converted.output, /as z\.ZodMiniObject<T\['shape'\], z\.core\.\$strict>/);
  assert.match(converted.output, /zod\.core\.clone\(schema/);
  assert.equal(convert(converted.output).output, converted.output);
});

test('relative factory proof follows a typed Zod namespace parameter through a generic identity helper', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-generic-factory-'));
  try {
    writeFileSync(join(fixture, 'projection.ts'), `import { z } from 'zod';\nexport function project<T extends z.ZodTypeAny>(schema: T): T { return schema; }\n`);
    const producer = join(fixture, 'producer.ts');
    writeFileSync(producer, `import { z } from 'zod';\nimport { project } from './projection.js';\nexport function makeSchema(zod: typeof z) { const schema = zod.object({ id: zod.string().min(1) }); return project(schema); }\nexport const RuntimeSchema = makeSchema(z);\n`);
    const consumer = join(fixture, 'consumer.ts');
    writeFileSync(consumer, `import { z } from 'zod';\nimport { RuntimeSchema } from './producer.js';\nconst Optional = RuntimeSchema.optional();\n`);
    const report = JSON.parse(execFileSync(process.execPath, [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)], { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    assert.match(readFileSync(consumer, 'utf8'), /z\.optional\(RuntimeSchema\)/);
    const producerReport = JSON.parse(execFileSync(process.execPath, [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, producer)], { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(producerReport.files[0].unresolved, []);
    assert.match(readFileSync(producer, 'utf8'), /zod\.string\(\)\.check\(zod\.minLength\(1\)\)/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('a generic Zod subtype-returning projection preserves its schema argument lineage', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-read-projection-'));
  try {
    writeFileSync(join(fixture, 'projection.ts'), `import { z } from 'zod/mini';\nexport function createStoredReadSchema<T extends z.core.$ZodType>(schema: T): T { const read = z.core.clone(schema, schema._zod.def); return read as T; }\n`);
    writeFileSync(join(fixture, 'producer.ts'), `import { z } from 'zod';\nexport const BaseSchema = z.object({ a: z.string() }).strict();\n`);
    const consumer = join(fixture, 'consumer.ts');
    writeFileSync(consumer, `import { z } from 'zod';\nimport { createStoredReadSchema } from './projection.js';\nimport { BaseSchema } from './producer.js';\nconst StoredSchema = createStoredReadSchema(BaseSchema);\nconst Maybe = StoredSchema.nullable();\nconst Stripped = StoredSchema.strip();\n`);
    const report = JSON.parse(execFileSync(process.execPath, [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)], { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    const output = readFileSync(consumer, 'utf8');
    assert.match(output, /z\.nullable\(StoredSchema\)/);
    assert.match(output, /z\.core\.clone\(schema, \{ \.\.\.schema\._zod\.def, catchall: undefined \}\)/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('workspace package exports and local tsconfig aliases resolve to authored schema sources', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-aliases-'));
  try {
    mkdirSync(join(fixture, 'sources'));
    writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./sources/*'] } } }));
    writeFileSync(join(fixture, 'sources', 'local.ts'), `import { z } from 'zod';\nexport const LocalSchema = z.string();\n`);
    const consumer = join(fixture, 'sources', 'consumer.ts');
    writeFileSync(consumer, `import { z } from 'zod';\nimport { LocalSchema } from '@/local';\nimport { SessionMessageRoleSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';\nconst One = LocalSchema.optional();\nconst Two = SessionMessageRoleSchema.optional();\n`);
    const report = JSON.parse(execFileSync(process.execPath, [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)], { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.files[0].unresolved, []);
    const output = readFileSync(consumer, 'utf8');
    assert.match(output, /z\.optional\(LocalSchema\)/);
    assert.match(output, /z\.optional\(SessionMessageRoleSchema\)/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('nested Zod namespace factories cannot leave Classic fluent chains after an import switch', () => {
  const source = `import { z } from 'zod';\nconst Json = z.json().optional();\nconst Instant = z.iso.datetime().nullable();\nconst Base64 = z.string().base64();\nconst Required = z.string().optional().nonoptional();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.optional\(z\.json\(\)\)/);
  assert.match(result.output, /z\.nullable\(z\.iso\.datetime\(\)\)/);
  assert.match(result.output, /z\.string\(\)\.check\(z\.base64\(\)\)/);
  assert.match(result.output, /z\.nonoptional\(z\.optional\(z\.string\(\)\)\)/);
  const before = evaluate(source, classic, '({ Json, Instant, Base64, Required })');
  const after = evaluate(result.output, mini, '({ Json, Instant, Base64, Required })');
  for (const [name, values] of Object.entries({ Json: [null, { a: 1 }, () => 1], Instant: [null, '2026-10-14T00:00:00Z', 'bad'], Base64: ['YQ==', '!!!'], Required: [undefined, 'ok'] })) {
    for (const value of values) assert.deepEqual(outcome(after[name], value), outcome(before[name], value));
  }
});

test('zero-argument Classic meta getter is refused until an explicit registry projection is chosen', () => {
  const source = `import { z } from 'zod';\nconst Schema = z.string().meta({ title: 'x' });\nconst Annotation = Schema.meta();\n`;
  const result = convert(source);
  assert.equal(result.changed, false);
  assert.equal(result.output, source);
  assert.ok(result.unresolved.some(item => item.method === 'meta'));
});

test('unknown Zod namespace fluent factory refuses the whole file', () => {
  const source = `import { z } from 'zod';\nconst Schema = z.futureFactory().optional();\n`;
  const result = convert(source);
  assert.equal(result.changed, false);
  assert.equal(result.output, source);
  assert.ok(result.unresolved.some(item => item.method === 'optional'));
});

test('nonempty preserves custom error params and ignored-argument fluent calls refuse', () => {
  const source = `import { z } from 'zod';\nconst S = z.string().nonempty({ error: 'required' });\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.minLength\(1, \{ error: 'required' \}\)/);
  assert.deepEqual(outcome(evaluate(result.output, mini, 'S'), ''), outcome(evaluate(source, classic, 'S'), ''));
  for (const invalid of [
    `import { z } from 'zod';\nconst S = z.object({ a: z.string() }).strict({ error: 'unknown' });\n`,
    `import { z } from 'zod';\nconst S = z.string().or(z.number(), { error: 'ambiguous' });\n`,
  ]) {
    const refused = convert(invalid);
    assert.equal(refused.output, invalid);
    assert.equal(refused.changed, false);
    assert.ok(refused.unresolved.length > 0);
  }
});

test('a schema-bearing factory record does not make its ordinary methods or parsed data into schemas', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  mkdirSync(join(repo, '.project', 'tmp'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.project', 'tmp', 'zod-mini-record-data-'));
  try {
    writeFileSync(join(fixture, 'producer.ts'), `import { z } from 'zod';\nexport function createOwner() { const Schema = z.string(); const voiceSettingsParse = () => ({ providers: {} }); return Object.freeze({ Schema, voiceSettingsParse }); }\n`);
    const consumer = join(fixture, 'consumer.ts');
    writeFileSync(consumer, `import { z } from 'zod';\nimport { createOwner } from './producer.js';\nconst owner = createOwner();\nconst Parsed = owner.voiceSettingsParse().providers;\nconst Optional = owner.Schema.optional();\nconst Own = z.string().optional();\n`);
    const report = JSON.parse(execFileSync(process.execPath, [join(repo, 'scripts/codemods/zod-mini/cli.mjs'), 'apply', '--write', relative(repo, consumer)], { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(report.files[0].unresolved, []);
    const output = readFileSync(consumer, 'utf8');
    assert.match(output, /owner\.voiceSettingsParse\(\)\.providers/);
    assert.match(output, /z\.optional\(owner\.Schema\)/);
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test('object merge uses native core semantics for right-hand policy and discarded left refinements', () => {
  const source = `import { z } from 'zod';\nconst Left = z.object({ a: z.string() }).strict().refine(v => v.a !== 'bad', { message: 'left check' });\nconst Right = z.object({ b: z.number() }).passthrough();\nconst Merged = Left.merge(Right);\nconst Strict = Left.merge(z.object({ b: z.number() }).strict());\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.core\.util\.merge\(a, b\)/);
  const before = evaluate(source, classic, '({ Merged, Strict })');
  const after = evaluate(result.output, mini, '({ Merged, Strict })');
  for (const name of ['Merged', 'Strict']) for (const value of [
    { a: 'ok', b: 1 }, { a: 'bad', b: 1 }, { a: 'ok', b: 1, extra: true }, { a: 'ok', b: 'bad' },
  ]) assert.deepEqual(outcome(after[name], value), outcome(before[name], value));
});

test('derived strict retains checks and Mini strict object output typing via native clone', () => {
  const source = `import { z } from 'zod';\nconst Base = z.object({ a: z.string() }).passthrough().superRefine((v, ctx) => { if (v.a === 'bad') ctx.addIssue({ code: 'custom', path: ['a'], message: 'blocked' }); });\nconst Strict = Base.strict();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.core\.clone\(schema, \{ \.\.\.schema\._zod\.def, catchall: z\.never\(\) \}\) as z\.ZodMiniObject<T\['shape'\], z\.core\.\$strict>/);
  const before = evaluate(source, classic, 'Strict');
  const after = evaluate(result.output, mini, 'Strict');
  for (const value of [{ a: 'ok' }, { a: 'ok', extra: true }, { a: 'bad' }]) assert.deepEqual(outcome(after, value), outcome(before, value));
  const emitted = `import { z } from 'zod/mini';\nconst Base = z.object({ a: z.string() });\nconst Strict = z.catchall(Base, z.never());\n`;
  const repaired = convert(emitted);
  assert.deepEqual(repaired.unresolved, []);
  assert.match(repaired.output, /z\.core\.clone\(schema, \{ \.\.\.schema\._zod\.def, catchall: z\.never\(\) \}\)/);
  assert.equal(convert(repaired.output).output, repaired.output);
});

test('multi-statement local Zod factories prove their sole return and ambiguous branches refuse', () => {
  const source = `import { z } from 'zod';\nfunction make() { const text = z.string(); return z.union([text, z.number()]); }\nconst Value = make().superRefine(() => {});\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /make\(\)\.check\(z\.superRefine\(/);
  const ambiguous = `import { z } from 'zod';\nfunction maybe(flag: boolean) { if (flag) return z.string(); return { optional: () => null }; }\nconst Value = maybe(true).optional();\n`;
  const refused = convert(ambiguous);
  assert.equal(refused.output, ambiguous);
  assert.ok(refused.unresolved.some(item => item.method === 'optional'));
});

test('transform callback issues use Mini raw payload with Classic code, path and message parity', async () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\nconst Inner = z.string().min(2);\nconst Direct = z.string().transform((value, ctx) => { if (value === 'bad') { ctx.addIssue({ code: 'custom', path: ['value'], message: 'blocked' }); return z.NEVER; } return value; });\nconst Forwarded = z.unknown().transform((value, ctx) => { const parsed = Inner.safeParse(value); if (!parsed.success) { for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['inner', ...issue.path] }); return z.NEVER; } return parsed.data; });\nconst Downstream = Direct.pipe(z.string().min(3));\nconst Async = z.string().transform(async (value, ctx) => { if (value === 'bad') { ctx.addIssue({ code: 'custom', message: 'async blocked' }); return z.NEVER; } return value; });\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /ctx\.issues\.push\(\{ code: 'custom', path: \['value'\], message: 'blocked', input: ctx\.value \}\)/);
  assert.match(result.output, /input: \('input' in issue \? issue\.input \?\? ctx\.value : ctx\.value\)/);
  assert.match(result.output, /as z\.core\.\$ZodRawIssue\)/);
  const before = evaluate(source, classic, '({ Direct, Forwarded, Downstream, Async })');
  const after = evaluate(result.output, mini, '({ Direct, Forwarded, Downstream, Async })');
  for (const [name, values] of Object.entries({ Direct: ['ok', 'bad'], Forwarded: ['okay', 'x', 12], Downstream: ['okay', 'bad', 'no'] })) {
    for (const value of values) assert.deepEqual(outcome(after[name], value), outcome(before[name], value));
  }
  for (const reportInput of [false, true]) {
    const input = { nested: 'invalid' };
    const issues = schema => schema.safeParse(input, { reportInput }).error.issues.map(issue => ({
      code: issue.code, path: issue.path, message: issue.message,
      hasInput: Object.hasOwn(issue, 'input'), input: issue.input,
    }));
    assert.deepEqual(issues(after.Forwarded), issues(before.Forwarded));
  }
  const asyncOutcome = async (schema, value) => {
    const parsed = await schema.safeParseAsync(value);
    return parsed.success ? { success: true, data: parsed.data } : {
      success: false, issues: parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })),
    };
  };
  for (const value of ['okay', 'bad']) assert.deepEqual(await asyncOutcome(after.Async, value), await asyncOutcome(before.Async, value));
  const emitted = `import { z } from 'zod/mini';\nconst S = z.pipe(z.string(), z.transform((value, ctx) => { ctx.addIssue({ code: 'custom', message: 'blocked' }); return z.NEVER; }));\n`;
  const repaired = convert(emitted);
  assert.deepEqual(repaired.unresolved, []);
  assert.match(repaired.output, /ctx\.issues\.push\(\{ code: 'custom', message: 'blocked', input: ctx\.value \}\)/);
});

test('native Mini preprocess pipe preserves parsing and typed input/output identities', () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\nconst S = z.preprocess((value) => typeof value === 'string' ? Number(value) : value, z.number().min(2).default(3));\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /new z\.ZodMiniPipe\(\{ type: 'pipe', in: input, out: output \}\) as z\.ZodMiniPipe<I, O>/);
  const before = evaluate(source, classic, 'S');
  const after = evaluate(result.output, mini, 'S');
  for (const value of [undefined, '2', '1', 'not a number', 4]) assert.deepEqual(outcome(after, value), outcome(before, value));
  const alreadyMini = `import { z } from 'zod/mini';\nconst S = z.pipe(z.transform((value) => typeof value === 'string' ? Number(value) : value), z._default(z.number().check(z.minimum(2)), 3));\n`;
  const repaired = convert(alreadyMini);
  assert.deepEqual(repaired.unresolved, []);
  assert.match(repaired.output, /new z\.ZodMiniPipe\(/);
  assert.equal(convert(repaired.output).output, repaired.output);
});

test('already-emitted Mini transform issue forwarding receives a precise raw-issue boundary type', () => {
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod/mini';\nconst Inner = z.string().check(z.minLength(2));\nconst S = z.pipe(z.unknown(), z.transform((value, context) => {\n  const parsed = Inner.safeParse(value);\n  if (!parsed.success) { for (const issue of parsed.error.issues) context.issues.push({ ...issue, path: ['inner', ...issue.path], input: ('input' in issue ? issue.input ?? context.value : context.value) }); return z.NEVER; }\n  return parsed.data;\n}));\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /context\.issues\.push\(\{ \.\.\.issue, path: \['inner', \.\.\.issue\.path\], input: .* \} as z\.core\.\$ZodRawIssue\)/);
  const schema = evaluate(result.output, mini, 'S');
  assert.equal(schema.safeParse('okay').success, true);
  const issue = schema.safeParse({ outer: true }, { reportInput: true }).error.issues[0];
  assert.deepEqual({ code: issue.code, path: issue.path, input: issue.input },
    { code: 'invalid_type', path: ['inner'], input: { outer: true } });
  assert.equal(convert(result.output).output, result.output);
});

test('transform issue forwarding in a concise forEach callback preserves void return and issue paths', () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\nconst Inner = z.string().min(2);\nconst S = z.unknown().transform((value, context) => { const parsed = Inner.safeParse(value); if (!parsed.success) { parsed.error.issues.forEach((issue) => context.addIssue({ ...issue, path: ['inner', ...issue.path] })); return z.NEVER; } return parsed.data; });\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /forEach\(\(issue\) => void context\.issues\.push\(\{ \.\.\.issue, path: \['inner', \.\.\.issue\.path\], input: \('input' in issue/);
  const before = evaluate(source, classic, 'S');
  const after = evaluate(result.output, mini, 'S');
  for (const value of ['okay', 'x', 12]) assert.deepEqual(outcome(after, value), outcome(before, value));
});

test('tuple rest uses Mini tuple constructor and preserves fixed/rest admission', () => {
  const source = `import { z } from 'zod';\nconst Colors = z.tuple([z.string(), z.number()]).rest(z.boolean());\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.tuple\(\[z\.string\(\), z\.number\(\)\], z\.boolean\(\)\)/);
  const before = evaluate(source, classic, 'Colors');
  const after = evaluate(result.output, mini, 'Colors');
  for (const value of [['red', 1], ['red', 1, true, false], ['red'], ['red', 1, 'bad']]) {
    assert.deepEqual(outcome(after, value), outcome(before, value));
  }
});

test('lexical bindings distinguish generic parameters and parsed-data destructuring from outer schemas', () => {
  const source = `import { z } from 'zod';\nconst filters = z.object({ agentIds: z.array(z.string()).optional() }).shape;\nfunction pick<T extends z.ZodTypeAny>(textSchema: T) { return textSchema.optional(); }\nfunction read() { const { filters } = z.object({ filters: z.object({ agentIds: z.array(z.string()) }) }).parse({ filters: { agentIds: [] } }); return filters.agentIds; }\nconst Derived = filters.agentIds;\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /return z\.optional\(textSchema\)/);
  assert.match(result.output, /return filters\.agentIds/);
  assert.match(result.output, /const Derived = filters\.agentIds/);
});

test('derived strip keeps existing checks while dropping the unknown-key policy', () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\nconst Base = z.object({ a: z.string() }).strict().superRefine((value, ctx) => { if (value.a === 'bad') ctx.addIssue({ code: 'custom', path: ['a'], message: 'blocked' }); });\nconst Stripped = Base.strip();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.core\.clone\(schema, \{ \.\.\.schema\._zod\.def, catchall: undefined \}\)/);
  const before = evaluate(source, classic, 'Stripped');
  const after = evaluate(result.output, mini, 'Stripped');
  for (const value of [{ a: 'ok', extra: true }, { a: 'bad', extra: true }, { a: 1, extra: true }]) {
    assert.deepEqual(outcome(after, value), outcome(before, value));
  }
});

test('loose object policy retains checks and unknown fields on direct and derived objects', () => {
  classic.config(classic.locales.en());
  mini.config(mini.locales.en());
  const source = `import { z } from 'zod';\nconst Direct = z.object({ a: z.string() }).loose();\nconst Base = z.object({ a: z.string() }).strict().superRefine((value, ctx) => { if (value.a === 'bad') ctx.addIssue({ code: 'custom', path: ['a'], message: 'blocked' }); });\nconst Derived = Base.loose();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.looseObject\(\{ a: z\.string\(\) \}\)/);
  assert.match(result.output, /z\.core\.clone\(schema, \{ \.\.\.schema\._zod\.def, catchall: z\.unknown\(\) \}\)/);
  const before = evaluate(source, classic, '({ Direct, Derived })');
  const after = evaluate(result.output, mini, '({ Direct, Derived })');
  for (const name of ['Direct', 'Derived']) {
    for (const value of [{ a: 'ok', extra: true }, { a: 'bad', extra: true }, { a: 1, extra: true }]) {
      assert.deepEqual(outcome(after[name], value), outcome(before[name], value));
    }
  }
});

test('array element reflection reads Mini core definition without changing identity', () => {
  const source = `import { z } from 'zod';\nconst Items = z.array(z.string());\nconst Item = Items.element;\nconst OptionalItem = Items.element.optional();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /const Item = Items\._zod\.def\.element/);
  assert.match(result.output, /z\.optional\(Items\._zod\.def\.element\)/);
  const before = evaluate(source, classic, '({ Items, Item })');
  const after = evaluate(result.output, mini, '({ Items, Item })');
  assert.equal(before.Item, before.Items.element);
  assert.equal(after.Item, after.Items._zod.def.element);
});

test('enum member reflection reads Mini entries without rewriting ordinary data properties', () => {
  const source = `import { z } from 'zod';\nconst E = z.enum(['agent', 'model']);\nconst Agent = E.enum.agent;\nconst data = { enum: { agent: 'ordinary' } };\nconst Other = data.enum.agent;\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /const Agent = E\._zod\.def\.entries\.agent/);
  assert.match(result.output, /const Other = data\.enum\.agent/);
  const before = evaluate(source, classic, '({ Agent, Other })');
  const after = evaluate(result.output, mini, '({ Agent, Other })');
  assert.deepEqual(after, before);
});

test('mixed schema records, JSON Schema results and Zod errors retain ordinary data properties', () => {
  const source = `import { z } from 'zod';\nimport { artifacts } from './artifacts.js';\nconst Value = artifacts.valueSchema.optional();\nconst Definitions = artifacts.definitions;\nconst Default = artifacts.default;\nconst Json = Value.toJSONSchema();\nconst Defs = Json.$defs ?? Json.definitions;\nfunction issues(error: z.ZodError) { return error.issues; }\n`;
  const result = transformSource(source, 'fixture.ts', { importedSchemas: new Map([['artifacts', {
    kind: 'record', fields: { valueSchema: { kind: 'string' } },
  }]]) });
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /const Value = z\.optional\(artifacts\.valueSchema\)/);
  assert.match(result.output, /const Definitions = artifacts\.definitions/);
  assert.match(result.output, /const Default = artifacts\.default/);
  assert.match(result.output, /const Json = z\.toJSONSchema\(Value\)/);
  assert.match(result.output, /const Defs = Json\.\$defs \?\? Json\.definitions/);
  assert.match(result.output, /return error\.issues/);
});

test('partial-record factories remain schema roots for fluent wrappers', () => {
  const source = `import { z } from 'zod';\nconst S = z.partialRecord(z.enum(['a', 'b']), z.string()).optional();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.optional\(z\.partialRecord\(z\.enum\(\['a', 'b'\]\), z\.string\(\)\)\)/);
  const before = evaluate(source, classic, 'S');
  const after = evaluate(result.output, mini, 'S');
  for (const value of [undefined, {}, { a: 'ok' }, { a: 1 }, { c: 'unexpected' }]) {
    assert.deepEqual(outcome(after, value), outcome(before, value));
  }
});

test('plain shape-record members and typeof-schema parameters retain proven Zod lineage', () => {
  const source = `import { z } from 'zod';\nconst layoutShape = { v: z.literal(1), order: z.array(z.string()), data: { default: () => 'ordinary' } };\nconst Stored = z.object({ ...layoutShape, v: layoutShape.v.default(1), order: layoutShape.order.default([]) });\nconst Ordinary = layoutShape.data.default();\nconst envelopeFields = { resultEnvelope: z.string() };\nconst Maybe = envelopeFields.resultEnvelope.nullable();\nconst BaseSchema = z.object({ a: z.string() });\nfunction project(schema: typeof BaseSchema) { return schema.transform(value => value.a); }\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /v: z\._default\(layoutShape\.v, 1\)/);
  assert.match(result.output, /order: z\._default\(layoutShape\.order, \[\]\)/);
  assert.match(result.output, /const Ordinary = layoutShape\.data\.default\(\)/);
  assert.match(result.output, /z\.nullable\(envelopeFields\.resultEnvelope\)/);
  assert.match(result.output, /return z\.pipe\(schema, z\.transform\(value => value\.a\)\)/);
});

test('destructured union options retain each member schema kind', () => {
  const source = `import { z } from 'zod';\nconst Choices = z.union([z.object({ kind: z.literal('one') }).strict(), z.object({ kind: z.literal('two') }).strict()]);\nconst [One, Two] = Choices.options;\nconst Extended = One.extend({ value: z.string() }).strict();\nconst Omitted = Two.omit({ kind: true });\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /const \[One, Two\] = Choices\._zod\.def\.options/);
  assert.match(result.output, /z\.extend\(One, \{ value: z\.string\(\) \}\)/);
  assert.match(result.output, /z\.omit\(Two, \{ kind: true \}\)/);
  const before = evaluate(source, classic, '({ Extended, Omitted })');
  const after = evaluate(result.output, mini, '({ Extended, Omitted })');
  for (const value of [{ kind: 'one', value: 'ok' }, { kind: 'one', value: 'ok', extra: true }, { kind: 'two' }]) {
    assert.deepEqual(outcome(after.Extended, value), outcome(before.Extended, value));
  }
});

test('destructured already-Mini core union options retain member object lineage', () => {
  const source = `import { z } from 'zod/mini';\nconst Choices = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('one') }), z.strictObject({ kind: z.literal('two') })]);\nconst [One, Two] = Choices._zod.def.options;\nconst Extended = One.extend({ value: z.string() });\nconst Omitted = Two.omit({ kind: true });\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.extend\(One, \{ value: z\.string\(\) \}\)/);
  assert.match(result.output, /z\.omit\(Two, \{ kind: true \}\)/);
  const Extended = evaluate(result.output, mini, 'Extended');
  assert.deepEqual(outcome(Extended, { kind: 'one', value: 'ok' }), { success: true, data: { kind: 'one', value: 'ok' } });
  assert.equal(convert(result.output).output, result.output);
});

test('Mini core-typed reflection under instanceof guards uses core definitions, not Classic accessors', () => {
  const source = `import { z } from 'zod/mini';\nfunction inspect(schema: z.core.$ZodType) {\n  let current = schema;\n  if (current instanceof z.ZodMiniOptional) current = current.unwrap() as z.ZodMiniType;\n  if (current instanceof z.ZodMiniDefault) current = current.unwrap() as z.ZodMiniType;\n  if (current instanceof z.ZodMiniNullable) current = current.unwrap() as z.ZodMiniType;\n  if (current instanceof z.ZodMiniPipe) current = current.in as z.ZodMiniType;\n  if (current instanceof z.ZodMiniUnion) return current.options[0];\n  if (current instanceof z.ZodMiniArray) return current.element;\n  return current;\n}\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.doesNotMatch(result.output, /\.unwrap\(\)|current\.(?:in|options|element)\b/);
  assert.match(result.output, /current\._zod\.def\.innerType/);
  assert.match(result.output, /current\._zod\.def\.in/);
  assert.match(result.output, /current\._zod\.def\.options/);
  assert.match(result.output, /current\._zod\.def\.element/);
  const inspect = evaluate(result.output, mini, 'inspect');
  const field = mini.string();
  assert.equal(inspect(mini.optional(field)), field);
  assert.equal(inspect(mini._default(field, 'x')), field);
  assert.equal(inspect(mini.nullable(field)), field);
  assert.equal(inspect(mini.pipe(field, mini.transform(value => value))), field);
  assert.equal(inspect(mini.union([field, mini.number()])), field);
  assert.equal(inspect(mini.array(field)), field);
  assert.equal(convert(result.output).output, result.output);
});

test('instanceof schema guard does not rewrite a shadowed ordinary method', () => {
  const source = `import { z } from 'zod/mini';\nfunction read(schema: z.core.$ZodType) {\n  if (schema instanceof z.ZodMiniOptional) {\n    const ordinary = () => { const schema = { unwrap: () => 'ordinary' }; return schema.unwrap(); };\n    return [schema.unwrap(), ordinary()];\n  }\n}\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /schema\._zod\.def\.innerType, ordinary\(\)/);
  assert.match(result.output, /return schema\.unwrap\(\)/);
  const value = mini.string();
  assert.deepEqual(evaluate(result.output, mini, 'read')(mini.optional(value)), [value, 'ordinary']);
});

test('an immediate terminating negative instanceof guard narrows the following Mini reflector', () => {
  const source = `import { z } from 'zod/mini';\nfunction element(schema: z.core.$ZodType) {\n  const inner = schema;\n  if (!(inner instanceof z.ZodMiniArray)) return null;\n  return inner.element;\n}\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /return inner\._zod\.def\.element/);
  const child = mini.string();
  const element = evaluate(result.output, mini, 'element');
  assert.equal(element(mini.array(child)), child);
  assert.equal(element(mini.number()), null);
});

test('namespace-only Classic helper types map to exported Mini core types', () => {
  const source = `import { z } from 'zod';\ntype Shape = z.ZodRawShape;\ntype Parsed = z.ZodSafeParseResult<string>;\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /type Shape = z\.core\.\$ZodShape/);
  assert.match(result.output, /type Parsed = z\.core\.util\.SafeParseResult<string>/);
});

test('promotes a type-only Mini namespace when converted and existing builders need its value', () => {
  const source = `import type { z } from 'zod/mini';\nimport { BaseSchema } from './base.js';\nconst Derived = BaseSchema.optional();\nconst Narrow = z.omit(BaseSchema, { a: true });\n`;
  const result = transformSource(source, 'fixture.ts', { importedSchemas: new Set(['BaseSchema']) });
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /^import \{ z \} from 'zod\/mini';/);
  assert.match(result.output, /const Derived = z\.optional\(BaseSchema\)/);
  assert.equal(transformSource(result.output, 'fixture.ts', { importedSchemas: new Set(['BaseSchema']) }).output, result.output);
});

test('adds a Mini value namespace when a named type-only import is the only Zod import', () => {
  const source = `import type { core } from 'zod/mini';\nimport { BaseSchema } from './base.js';\ntype Json = core.JSONSchema.JSONSchema;\nconst Projected = BaseSchema.toJSONSchema({ io: 'input' });\n`;
  const result = transformSource(source, 'fixture.ts', { importedSchemas: new Set(['BaseSchema']) });
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /^import \* as z from 'zod\/mini';/);
  assert.match(result.output, /const Projected = z\.toJSONSchema\(BaseSchema, \{ io: 'input' \}\)/);
  assert.equal(transformSource(result.output, 'fixture.ts', { importedSchemas: new Set(['BaseSchema']) }).output, result.output);
});

test('a generated Mini namespace cannot collide with an unrelated imported name', () => {
  const source = `import { z } from './ordinary.js';\nimport type { core } from 'zod/mini';\nimport { BaseSchema } from './base.js';\nconst value = z.value;\nconst Projected = BaseSchema.toJSONSchema();\n`;
  const result = transformSource(source, 'fixture.ts', { importedSchemas: new Set(['BaseSchema']) });
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /^import \* as zMini from 'zod\/mini';/);
  assert.match(result.output, /const Projected = zMini\.toJSONSchema\(BaseSchema\)/);
  assert.match(result.output, /const value = z\.value/);
});

test('local object-shape field provenance carries object and wrapper kinds', () => {
  const source = `import { z } from 'zod';\nimport { lazyZodSchema } from './lazyZodSchema';\nconst Outer = lazyZodSchema(() => z.object({ child: z.object({ a: z.string() }).strict(), name: z.string().default('x') }).strict());\nconst Child = Outer.shape.child.strip();\nconst Name = Outer.shape.name.removeDefault();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /z\.core\.clone\(schema, \{ \.\.\.schema\._zod\.def, catchall: undefined \}\)/);
  assert.match(result.output, /Outer\.shape\.name\._zod\.def\.innerType/);
});

test('a cold schema facade unwrap resolves to its concrete non-wrapper schema', () => {
  const source = `import { z } from 'zod';\nimport { lazyZodSchema } from './lazyZodSchema';\nconst ObjectSchema = lazyZodSchema(() => z.object({ a: z.string() }));\nconst Inner = ObjectSchema.unwrap();\n`;
  const result = convert(source);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.output, /const Inner = ObjectSchema;/);
});
