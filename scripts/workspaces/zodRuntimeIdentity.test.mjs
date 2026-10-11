import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { syncBundledWorkspacePackages } from './syncBundledWorkspacePackages.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { runCaptureResult } from '../../apps/stack/scripts/utils/proc/proc.mjs';

test('the daemon host and its workspace schema owners share one installed Zod runtime', () => {
  const manifests = [
    '../../apps/cli/package.json', '../../packages/protocol/package.json',
    '../../packages/session-core/package.json', '../../packages/agents/package.json',
  ];
  const schemas = manifests.map(manifest => createRequire(new URL(manifest, import.meta.url))('zod'));
  for (const schemaOwner of schemas.slice(1)) {
    assert.equal(schemaOwner.ZodType, schemas[0].ZodType);
    const schema = schemaOwner.object({ id: schemaOwner.string().min(1) }).strict();
    assert.equal(schema instanceof schemas[0].ZodType, true);
    assert.deepEqual(schemas[0].parse(schema, { id: 'a' }), { id: 'a' });
    assert.equal(schemas[0].safeParse(schema, { id: 'a', unknown: true }).success, false);
  }
});

test('the CLI declaration project names schemas from published workspace copies through its direct Zod dependency', async (t) => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const cliDir = join(repoRoot, 'apps/cli');
  const consumerDir = await mkdtemp(join(tmpdir(), 'happier-cli-published-schema-declarations-'));
  t.after(() => rm(consumerDir, { recursive: true, force: true }));
  const require = createRequire(new URL('../../apps/cli/package.json', import.meta.url));
  const zodPackagePath = require.resolve('zod/package.json');
  const zodPackage = JSON.parse(await readFile(zodPackagePath, 'utf8'));
  await mkdir(join(consumerDir, 'node_modules'), { recursive: true });
  await symlink(dirname(zodPackagePath), join(consumerDir, 'node_modules/zod'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
    name: '@fixture/cli-declarations', type: 'module',
    dependencies: { '@happier-dev/agents': '0.0.0', '@happier-dev/protocol': '0.0.0', zod: zodPackage.version },
  }));
  // Preserve the real publisher and its vendored runtime closure, not handwritten declarations.
  syncBundledWorkspacePackages({ repoRoot, hostPackageDirs: [consumerDir], packages: ['agents', 'protocol'], pruneStale: true });
  for (const name of ['agents', 'protocol']) {
    const publishedManifest = join(consumerDir, 'node_modules/@happier-dev', name, 'package.json');
    const publishedZod = createRequire(publishedManifest).resolve('zod/package.json');
    assert.notEqual(realpathSync(publishedZod), realpathSync(zodPackagePath));
    assert.equal(JSON.parse(await readFile(publishedZod, 'utf8')).version, zodPackage.version);
  }
  const cliConfig = ts.readConfigFile(join(cliDir, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(cliConfig.error, undefined);
  const paths = Object.fromEntries(Object.entries(cliConfig.config.compilerOptions.paths)
    .map(([name, targets]) => [name, targets.map(target => resolve(cliDir, target))]));
  await writeFile(join(consumerDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
      declaration: true, emitDeclarationOnly: true, skipLibCheck: true, types: [],
      outDir: './dist', paths,
    },
    files: ['index.ts'],
  }));
  await writeFile(join(consumerDir, 'index.ts'), [
    "import { z } from 'zod';",
    "import type { $brand } from 'zod/v4/core';",
    "import { StoredMachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';",
    "import { DaemonProviderModelLoadRequestV1Schema } from '@happier-dev/protocol/rpc/providers';",
    "import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';",
    "import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/selection/v1';",
    'export const MachineMetadataSchema = StoredMachinePublishedMetadataV1Schema;',
    'export const ProviderModelLoadRpcRequestSchema = DaemonProviderModelLoadRequestV1Schema;',
    'export const ProviderConnectionIdentitySchema = ProviderConnectionIdSchema;',
    'export function parseConnectionIdentity(input: unknown) { return ProviderConnectionIdSchema.safeParse(input); }',
    'export function shareConnectionIdentity(value: z.output<typeof ProviderConnectionIdSchema>): string & $brand<"ProviderConnectionId"> { return value; }',
    '// @ts-expect-error A plain string must not acquire the canonical connection identity brand.',
    'shareConnectionIdentity("unvalidated");',
    'export function identifyRequest(selection: ProviderBoundModelRef) { return { selection }; }',
    'export const DirectSchema = z.object({ value: z.string() }).strict();',
  ].join('\n'));
  const invocation = resolveTypeScriptCliInvocation({ args: ['-p', 'tsconfig.json'] });
  const result = await runCaptureResult(invocation.command, [...invocation.argsPrefix, '-p', 'tsconfig.json', '--singleThreaded'], {
    cwd: consumerDir, ownedProcessGroup: true,
  });
  assert.equal(result.exitCode, 0, result.out);
  const declarations = await readFile(join(consumerDir, 'dist/index.d.ts'), 'utf8');
  assert.doesNotMatch(declarations, /node_modules\/zod/);
});
