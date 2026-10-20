import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { runApiSurfaceSourceHarnessForTests } from './apiSurfaceCli.mjs';

function publicProjectionSource(protocol) {
  // Exercise the real private compiler owner, not a second test-only mapper.
  const path = resolve(protocol, 'actions/pluginActionDtoCorrespondence.ts');
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true);
  const helpers = new Set(['Equal', 'PublicScalar', 'PublicValue', 'Concrete', 'Failures']);
  const declarations = file.statements.filter(node => ts.isTypeAliasDeclaration(node) && helpers.has(node.name.text));
  assert.equal(declarations.length, helpers.size);
  const printer = ts.createPrinter();
  return `import type { z } from 'zod/mini';\nimport type { JsonValue } from '${protocol}/json/strictJsonValue.js';\nimport type { PluginJsonValueV2 } from '${protocol}/plugins/contributions/jsonSchema.js';\n`
    + declarations.map(node => (['PublicValue', 'Failures'].includes(node.name.text) ? 'export ' : '')
      + printer.printNode(ts.EmitHint.Unspecified, node, file)).join('\n');
}

test('Session exchange author input matches both public runtime carriers and refuses host revisions', t => {
  const repoRoot = process.cwd();
  const protocol = resolve(repoRoot, 'packages/protocol/src');
  const cache = resolve(repoRoot, 'packages/protocol/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'happier-exchange-correspondence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(resolve(root, 'publicProjection.ts'), publicProjectionSource(protocol));
  const fixture = resolve(root, 'exchange.ts');
  writeFileSync(fixture, `
    import type { z } from 'zod/mini';
    import type { PublicValue } from './publicProjection.js';
    import type { PLUGIN_ACTION_INPUT_SCHEMAS, PUBLIC_ACTION_INPUT_SCHEMAS, PluginActionInputById, PublicActionInputById } from '${protocol}/actions/actionSpecs.js';
    import type { PluginActionInputById as DtoInputs } from '${repoRoot}/packages/plugin-sdk/src/actions/actionTypeMap.generated.js';
    type Input = PluginActionInputById['session.exchange.control'];
    type PluginInput = z.input<(typeof PLUGIN_ACTION_INPUT_SCHEMAS)['session.exchange.control']>;
    type PublicInput = z.input<(typeof PUBLIC_ACTION_INPUT_SCHEMAS)['session.exchange.control']>;
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Assert<T extends true> = T;
    type PluginCarrierExact = Assert<Equal<PluginInput, Input>>;
    type PublicCarrierExact = Assert<Equal<PublicInput, PublicActionInputById['session.exchange.control']>>;
    declare const canonical: PublicValue<Input, true>;
    declare const dto: DtoInputs['session.exchange.control'];
    const forward: typeof dto = canonical;
    const reverse: typeof canonical = dto;
    const pluginCarrier: PluginInput = dto;
    const publicCarrier: PublicInput = dto;
    const authored: typeof dto = { sessionId: 'session-1', originInputLocalId: 'input-1', decision: 'continue_more', additionalTurns: 10 };
    // @ts-expect-error Host observations are refused by the strict public transport.
    const hostObservation: typeof dto = { ...authored, observedRevision: 'session-message-row-revision:v1:3' };
    // @ts-expect-error The public runtime carrier must not advertise host-only authority either.
    const publicObservation: PublicInput = { ...authored, observedRevision: 'session-message-row-revision:v1:3' };
  `);
  const invocation = resolveTypeScriptCliInvocation({ repoRoot, workspaceDir: repoRoot });
  const result = spawnSync(invocation.command, [...invocation.argsPrefix,
    '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node', '--noEmit',
    resolve(protocol, 'auth/tr46.d.ts'), fixture,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, JSON.stringify({ signal: result.signal, error: result.error?.message })
    + '\n' + result.stdout + result.stderr);
});

test('public manifest input references admit qualified machine fields and match Protocol host references', (t) => {
  const repoRoot = process.cwd();
  const cache = resolve(repoRoot, 'packages/protocol/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'happier-host-input-correspondence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Compile the actual portable declaration without pulling unrelated, prepared SDK host imports into this type-only witness.
  const manifestPath = resolve(repoRoot, 'packages/plugin-sdk/src/manifest.ts');
  const manifest = ts.createSourceFile(manifestPath, readFileSync(manifestPath, 'utf8'), ts.ScriptTarget.ES2022, true);
  const declaration = manifest.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'PluginInputTypeReferenceV1');
  assert.ok(declaration, 'Expected the canonical public manifest input-reference declaration');
  writeFileSync(resolve(root, 'publicReference.ts'), ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, manifest));
  const fixture = resolve(root, 'hostInputs.ts');
  writeFileSync(fixture, `
    import type { InputTypeReferenceV1 as Canonical } from '${repoRoot}/packages/protocol/src/inputs/inputTypes.js';
    import type { PluginInputTypeReferenceV1 as Public } from './publicReference.js';
    declare const canonical: Canonical;
    declare const authored: Public;
    const forward: Public = canonical;
    const reverse: Canonical = authored;
    const machine: Public = { hostType: 'machine' };
  `);
  const invocation = resolveTypeScriptCliInvocation({ repoRoot, workspaceDir: repoRoot });
  const result = spawnSync(invocation.command, [...invocation.argsPrefix,
    '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'Bundler', '--customConditions', 'happier-source',
    '--types', 'node', '--noEmit', resolve(repoRoot, 'packages/protocol/src/auth/tr46.d.ts'), fixture,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, JSON.stringify({ signal: result.signal, error: result.error?.message })
    + '\n' + result.stdout + result.stderr);
});

test('public Action correspondence preserves empty objects, primitives, brands and recursive JSON leaves', (t) => {
  const repoRoot = process.cwd();
  const cache = resolve(repoRoot, 'packages/protocol/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'happier-action-dto-leaves-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const protocol = resolve(repoRoot, 'packages/protocol/src');
  writeFileSync(resolve(root, 'publicProjection.ts'), publicProjectionSource(protocol));
  const fixture = resolve(root, 'leaves.ts');
  writeFileSync(fixture, `
    import type { z } from 'zod/mini';
    import type { Failures, PublicValue } from './publicProjection.js';
    import type { JsonValue } from '${protocol}/json/strictJsonValue.js';
    import type { PluginJsonValueV2 } from '${protocol}/plugins/contributions/jsonSchema.js';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Assert<T extends true> = T;
    type Empty = Assert<Equal<PublicValue<Record<string, never>, true>, Record<string, never>>>;
    type Never = Assert<Equal<PublicValue<never, true>, never>>;
    type Unknown = Assert<Equal<PublicValue<unknown, true>, unknown>>;
    type Scalars = Assert<Equal<PublicValue<'literal' | number | boolean | null | undefined, true>, 'literal' | number | boolean | null | undefined>>;
    type Brand = Assert<Equal<PublicValue<string & z.core.$brand<'id'>, false>, string>>;
    type OptionalBrand = Assert<Equal<PublicValue<(string & z.core.$brand<'id'>) | undefined, false>, string | undefined>>;
    type NullableBrand = Assert<Equal<PublicValue<(string & z.core.$brand<'id'>) | null, false>, string | null>>;
    type Tuple = Assert<Equal<PublicValue<readonly ['literal', number?], true>, readonly ['literal', number?]>>;
    type ReadonlyJson = Assert<Equal<PublicValue<JsonValue, true>, JsonValue>>;
    type InputJson = Assert<Equal<PublicValue<PluginJsonValueV2, true>, JsonValue>>;
    type ResultJson = Assert<Equal<PublicValue<PluginJsonValueV2, false>, PluginJsonValueV2>>;
    type OpaqueSchema = Assert<Equal<PublicValue<z.ZodMiniType, true>, unknown>>;
    // Deliberately invalid boundary declarations: the prior producer rejected whole-map any/unknown.
    type RejectDtoAny = Assert<Equal<Failures<{ action: { count: number } }, { action: any }, false>, 'action'>>;
    type RejectSchemaAny = Assert<Equal<Failures<{ action: any }, { action: { count: number } }, false>, 'action'>>;
    type RejectDtoUnknown = Assert<Equal<Failures<{ action: { count: number } }, { action: unknown }, false>, 'action'>>;
    type RejectDtoNever = Assert<Equal<Failures<{ action: never }, { action: never }, false>, 'action'>>;
    type RejectChangedInput = Assert<Equal<Failures<{ action: { count: number } }, { action: { count: string } }, true>, 'action'>>;
    type RejectMissingResult = Assert<Equal<Failures<{ action: { count: number } }, { action: {} }, false>, 'action'>>;
    type RejectMissingSchemaKey = Assert<Equal<Failures<{}, { action: { count: number } }, false>, 'action'>>;
  `);
  const invocation = resolveTypeScriptCliInvocation({ repoRoot, workspaceDir: repoRoot });
  const result = spawnSync(invocation.command, [...invocation.argsPrefix,
    '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node', '--noEmit', fixture,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, JSON.stringify({ signal: result.signal, error: result.error?.message })
    + '\n' + result.stdout + result.stderr);
});

test('named declarative Action DTO matches the canonical Protocol document grammar', (t) => {
  const repoRoot = process.cwd();
  const protocol = resolve(repoRoot, 'packages/protocol/src');
  const cache = resolve(repoRoot, 'packages/protocol/node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(resolve(cache, 'happier-action-declarative-correspondence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(resolve(root, 'publicProjection.ts'), publicProjectionSource(protocol));
  const fixture = resolve(root, 'declarative.ts');
  writeFileSync(fixture, `
    import type { PublicValue } from './publicProjection.js';
    import type { PluginDeclarativeNodeV2 as Canonical } from '${protocol}/plugins/contributions/ui/v2.js';
    import type { PluginDeclarativeNodeV2 as Dto, PluginDeclarativeComposerApplyEffectV1 as DtoEffect } from '${repoRoot}/packages/plugin-sdk/src/actions/dtos/actionDeclarativeNodeDto.generated.js';
    declare const canonical: PublicValue<Canonical, false>;
    declare const dto: Dto;
    const forward: Dto = canonical;
    const reverse: PublicValue<Canonical, false> = dto;
    const authoredStack: Dto = { kind: 'stack', children: [{ kind: 'text', text: 'hello' }] };
    declare const effect: PublicValue<NonNullable<Extract<Canonical, { kind: 'action' }>['effect']>, false>;
    const projectedEffect: DtoEffect = effect;
  `);
  const invocation = resolveTypeScriptCliInvocation({ repoRoot, workspaceDir: repoRoot });
  const result = spawnSync(invocation.command, [...invocation.argsPrefix,
    '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node', '--noEmit',
    resolve(protocol, 'auth/tr46.d.ts'), fixture,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, JSON.stringify({ signal: result.signal, error: result.error?.message })
    + '\n' + result.stdout + result.stderr);
});

test('filesystem recursive Action DTO support closes through the author inventory', async () => {
  const report = await runApiSurfaceSourceHarnessForTests({
    packageRoot: resolve(process.cwd(), 'packages/plugin-sdk'),
  });
  assert.ok(report.inventory.symbols.some(symbol => symbol.specifier === './actions'
    && symbol.exportName === 'FilesystemTreeNode' && symbol.kind === 'type'),
  'the recursive directory-tree result must publish its named author dependency');
});

// Deliberately separate from dependency builds: drift fails this explicit gate only.
test('canonical per-family Action DTO witnesses compile with exact catalog coverage', (t) => {
  const repoRoot = process.cwd();
  const protocol = resolve(repoRoot, 'packages/protocol/src');
  const invocation = resolveTypeScriptCliInvocation({ repoRoot, workspaceDir: repoRoot });
  const result = spawnSync(invocation.command, [...invocation.argsPrefix,
    '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022', '--extendedDiagnostics',
    '--module', 'ESNext', '--moduleResolution', 'Bundler', '--types', 'node', '--noEmit',
    resolve(protocol, 'auth/tr46.d.ts'), resolve(protocol, 'actions/pluginActionDtoCorrespondence.ts'),
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, JSON.stringify({ signal: result.signal, error: result.error?.message })
    + '\n' + result.stdout + result.stderr);
  t.diagnostic(result.stdout);
});
