import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { installUiTypecheckFixtureDependencies } from '../testing/lib/typecheckProjectFixture.mjs';
import { readTypecheckProject } from './deriveTypecheckProjects.mjs';

const runner = fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url));

test('finite UI consumers retain contextual types across emitted partition imports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-typecheck-partition-imports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ui = join(root, 'apps/ui');
  const put = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  await put(join(ui, 'package.json'), { name: 'partition-import-fixture' });
  await put(join(ui, 'app.json'), { expo: { name: 'Partition imports', slug: 'partition-imports' } });
  await installUiTypecheckFixtureDependencies(t, ui);
  await put(join(ui, 'tsconfig.json'), { compilerOptions: {
    strict: true, skipLibCheck: false, types: [], lib: ['es2022'], target: 'es2022',
    module: 'esnext', moduleResolution: 'bundler', paths: { '@/*': ['./sources/*'] }, noEmit: true,
  }, include: ['sources/**/*.ts'] });
  const names = ['foundation', 'core', 'source', 'test-components', 'test-other'];
  for (const [index, name] of names.entries()) await put(join(ui, `tsconfig.${name}.json`), {
    extends: './tsconfig.json', compilerOptions: index < 3 ? {
      composite: true, noEmit: false, declaration: true, emitDeclarationOnly: true,
      rootDir: root, outDir: `node_modules/.cache/tsc/ui.${name}.declarations`,
      tsBuildInfoFile: `node_modules/.cache/tsc/${name}.tsbuildinfo`, disableSourceOfProjectReferenceRedirect: true,
    } : { noEmit: true, disableSourceOfProjectReferenceRedirect: true },
    files: index < 3 ? ['sources/model.ts'] : ['sources/consumer.test.ts'], include: [],
    references: (index < 3 ? names.slice(0, index) : ['source']).map(previous => ({ path: `./tsconfig.${previous}.json` })),
  });
  await put(join(ui, 'tsconfig.test.json'), { extends: './tsconfig.test-other.json' });
  await put(join(ui, 'sources/scope.ts'), 'export interface Scope { serverId: string; accountId: string }');
  await put(join(ui, 'sources/model.ts'), 'import { enabled } from "./peer"; import type { Scope } from "@/scope"; export interface Request { enabled: boolean } export interface Profile { name: string; canonicalServerUrl?: string } export interface Link extends Scope { id: string } export function createAdapter(request: (input: Request) => Promise<boolean>) { return () => request({ enabled }); }');
  await put(join(ui, 'sources/peer.ts'), 'import type { Request } from "./model"; export const enabled: Request["enabled"] = true;');
  await put(join(ui, 'sources/entry.ts'), 'import { createAdapter, type Profile, type Link } from "@/model"; export function realActions(request: Parameters<typeof createAdapter>[0]) { return createAdapter(request); } export function readProfile(): Profile { return { name: "home" }; } export function profileName(profile: Pick<Profile, "name" | "canonicalServerUrl">): string { return profile.name; } export function readLink(): Link { return { id: "link", serverId: "server", accountId: "account" }; }');
  const consumer = 'import { realActions, readProfile, profileName, readLink } from "@/entry"; import type { Profile, Link } from "@/model"; const profile: Profile = { name: "home" }; const link: Link = readLink(); export const action = realActions(async request => request.enabled); export const name = profileName(profile); export const otherName = profileName(readProfile()); export const serverId: string = link.serverId; export const accountId: string = link.accountId;';
  await put(join(ui, 'sources/consumer.test.ts'), consumer);
  const run = () => {
    const result = spawnSync(process.execPath, [runner, '--singleThreaded', ...names.flatMap(name => ['--project', `tsconfig.${name}.json`])], {
      cwd: ui, env: process.env, encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stdout + result.stderr);
    return { ...result, output: result.stdout + result.stderr };
  };
  const green = run();
  assert.equal(green.status, 0, green.output);
  const declaration = await readFile(join(ui, 'node_modules/.cache/tsc/ui.source.declarations/apps/ui/sources/entry.d.ts'), 'utf8');
  t.diagnostic(`Native cross-partition declaration: ${declaration.trim()}`);
  assert.doesNotMatch(declaration, /ui\.core\.declarations/, 'producer-source resolution cannot interpret an output-directory-relative import');
  await put(join(ui, 'sources/consumer.test.ts'), consumer.replace('request.enabled', 'request.missing'));
  const rejected = run();
  assert.notEqual(rejected.status, 0, 'contextual request type was lost across declaration partitions');
  assert.match(rejected.output, /consumer\.test\.ts\(\d+,\d+\): error TS2339:/);
  assert.doesNotMatch(rejected.output, /error TS7006:/, 'an import-error any is not a typed rejection');
});

test('public CLI preparation keeps host globals and aliases at their declaration boundaries without losing test roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-typecheck-hosts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'apps/cli');
  const ui = join(root, 'apps/ui');
  const server = join(root, 'apps/server');
  const protocol = join(root, 'packages/protocol');
  const put = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const common = { strict: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022', lib: ['es2022'], types: [], skipLibCheck: false, esModuleInterop: true };
  await put(join(cli, 'package.json'), { name: 'host-boundary-cli' });
  await put(join(ui, 'package.json'), { name: 'host-boundary-ui' });
  await put(join(ui, 'app.json'), { expo: { name: 'Host boundary', slug: 'host-boundary' } });
  await installUiTypecheckFixtureDependencies(t, ui);
  const authoredCliConfig = fileURLToPath(new URL('../../apps/cli/tsconfig.json', import.meta.url));
  const authoredCliPaths = readTypecheckProject(authoredCliConfig).parsed.options.paths ?? {};
  const cliPaths = Object.fromEntries(Object.entries(authoredCliPaths).map(([name, targets]) =>
    [name, targets.map(target => resolve(dirname(authoredCliConfig), target))]));
  await put(join(cli, 'tsconfig.json'), { compilerOptions: { ...common, paths: { ...cliPaths, '@/*': ['./src/*'] }, jsx: 'react', jsxFactory: 'cliJsx', types: ['node'], resolveJsonModule: true, noEmit: true }, include: ['src/**/*.ts', 'src/**/*.tsx'] });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  const require = createRequire(import.meta.url);
  await symlink(dirname(require.resolve('zod/package.json')), join(root, 'node_modules/zod'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await put(join(ui, 'tsconfig.json'), { compilerOptions: { ...common, paths: { '@/*': ['./src/*'] }, lib: ['es2022', 'dom'], jsx: 'react-jsx', jsxImportSource: 'ui-jsx', customConditions: ['browser'], noEmit: true }, include: ['src/**/*'] });
  await put(join(server, 'tsconfig.json'), { compilerOptions: { ...common, paths: { '@/*': ['./src/*'] }, lib: ['es2022'], types: ['node'], noEmit: true }, include: ['src/**/*'] });
  await put(join(protocol, 'tsconfig.json'), { compilerOptions: { ...common, lib: ['es2022', 'dom', 'dom.iterable'], jsx: 'react', customConditions: ['server'], noEmit: true }, include: ['src/**/*'] });
  await put(join(root, 'node_modules/owner-condition/package.json'), { name: 'owner-condition', exports: { '.': {
    browser: { types: './browser.d.ts' }, server: { types: './server.d.ts' }, types: './cli.d.ts',
  } } });
  for (const owner of ['browser', 'server', 'cli']) await put(join(root, `node_modules/owner-condition/${owner}.d.ts`), `export declare const selected: "${owner}";`);
  // A platform JSX runtime is an external compiler boundary, not a substituted
  // domain owner. Its element identity distinguishes automatic from CLI JSX.
  await put(join(root, 'node_modules/ui-jsx/package.json'), { name: 'ui-jsx', exports: { './jsx-runtime': { types: './jsx-runtime.d.ts' } } });
  await put(join(root, 'node_modules/ui-jsx/jsx-runtime.d.ts'), 'export namespace JSX { interface Element { owner: "ui-jsx" } interface IntrinsicElements { surface: {} } }');
  await put(join(protocol, 'src/environment.d.ts'), 'export {}; declare global { namespace NodeJS { interface ProcessEnv { NODE_ENV: string } } }');
  await put(join(protocol, 'src/timers.d.ts'), 'declare function setTimeout(callback: () => void, delay: number): number;');
  const protocolSource = 'import { selected } from "owner-condition"; const libraryCondition: "server" = selected; const environment: NodeJS.ProcessEnv = { NODE_ENV: "production" }; const timer: number = setTimeout(() => {}, 1); export function html(value: string) { const element = document.createElement("div"); element.textContent = value; return { text: element.innerHTML, condition: libraryCondition }; }';
  await put(join(protocol, 'src/document.ts'), protocolSource);
  const manifest = JSON.parse(await readFile(new URL('../../apps/cli/package.json', import.meta.url), 'utf8'));
  const names = [...manifest.scripts['typecheck:source:finite'].matchAll(/--project tsconfig\.([^ ]+)\.json/g)].map(([, name]) => name);
  for (const [directory, sourceNames] of [[cli, names.filter(name => !name.startsWith('test'))], [ui, ['foundation', 'core', 'source']]]) {
    for (const [index, name] of sourceNames.entries()) await put(join(directory, `tsconfig.${name}.json`), {
      extends: './tsconfig.json', compilerOptions: { composite: true, noEmit: false, declaration: true, emitDeclarationOnly: true,
        rootDir: root, outDir: `node_modules/.cache/tsc/${name}.declarations`, tsBuildInfoFile: `node_modules/.cache/tsc/${name}.tsbuildinfo`,
        disableSourceOfProjectReferenceRedirect: true },
      files: ['src/model.ts'], include: [], references: sourceNames.slice(0, index).map(previous => ({ path: `./tsconfig.${previous}.json` })),
    });
  }
  for (const name of new Set([...names.filter(name => name.startsWith('test')), 'test'])) await put(join(cli, `tsconfig.${name}.json`), {
    extends: './tsconfig.json', compilerOptions: { noEmit: true, disableSourceOfProjectReferenceRedirect: true }, files: ['src/env.d.ts'], include: [],
    references: [{ path: './tsconfig.source.json' }, { path: '../ui/tsconfig.source.json' }],
  });
  for (const name of ['test', 'test-components', 'test-other']) await put(join(ui, `tsconfig.${name}.json`), {
    extends: './tsconfig.json', compilerOptions: { noEmit: true, disableSourceOfProjectReferenceRedirect: true }, files: ['src/host.d.ts'], include: [],
    references: [{ path: './tsconfig.source.json' }],
  });
  await put(join(cli, 'src/env.d.ts'), 'declare namespace NodeJS { interface ProcessEnv { [key: string]: string | undefined } }');
  await put(join(ui, 'src/host.d.ts'), 'declare const uiHostBoundary: unique symbol;');
  await put(join(cli, 'src/model.ts'), 'export const host = "cli" as const; export type HostEnvironment = Readonly<Record<string, string | undefined>>;');
  await put(join(server, 'src/model.ts'), 'export interface ServerModel { host: "server" }');
  await put(join(server, 'src/ambient.ts'), 'import type { ServerModel } from "@/model"; declare global { namespace OwnerStorage { type Message = ServerModel; } } export {};');
  await put(join(server, 'node_modules/server-route/package.json'), { name: 'server-route', types: './index.d.ts' });
  await put(join(server, 'node_modules/server-route/index.d.ts'), 'export interface RouteConfig { public?: boolean }');
  await put(join(server, 'src/routeTypes.d.ts'), 'import type { ServerModel } from "@/model"; declare module "server-route" { interface RouteConfig { model?: ServerModel } } export {};');
  await put(join(server, 'node_modules/server-rate-limit/package.json'), { name: 'server-rate-limit', types: './index.d.ts' });
  await put(join(server, 'node_modules/server-rate-limit/index.d.ts'), 'import "server-route"; declare module "server-route" { interface RouteConfig { rateLimit?: boolean } } export declare function register(): void;');
  // Distinct installed Node type versions model a real package boundary: the
  // server's primary type directive must win over a dependency's secondary one.
  await put(join(root, 'node_modules/@types/node/package.json'), { name: '@types/node', version: '25.0.0', types: './index.d.ts' });
  const nodeUrl = 'interface URL { href: string; hostname: string; protocol: string }';
  await put(join(root, 'node_modules/@types/node/index.d.ts'), `${nodeUrl}\ninterface Response { bytes(): Promise<Uint8Array<ArrayBuffer>> } declare namespace NodeJS { interface Timeout { unref(): void } } declare function setTimeout(callback: () => void, delay: number): NodeJS.Timeout;`);
  await put(join(server, 'node_modules/@types/node/package.json'), { name: '@types/node', version: '22.0.0', types: './index.d.ts' });
  await put(join(server, 'node_modules/@types/node/index.d.ts'), `${nodeUrl}\ninterface Response { text(): Promise<string> }`);
  await put(join(root, 'node_modules/transport-types/package.json'), { name: 'transport-types', types: './index.d.ts' });
  await put(join(root, 'node_modules/transport-types/index.d.ts'), '/// <reference types="node" />\nexport interface TransportResponse { text(): Promise<string> }');
  await put(join(server, 'src/bootstrap.ts'), 'import "server-rate-limit"; import "transport-types"; export {};');
  // The server's own test program may reach another host. Its globals must not
  // become ambient inputs of the server declaration consumer.
  await put(join(server, 'src/browser.test.ts'), 'import "../../ui/src/entry"; export {};');
  await put(join(server, 'src/service.ts'), 'import { ServerModel } from "@/model"; import { RouteConfig } from "server-route"; import { register } from "server-rate-limit"; register(); const response: Response = { text: async () => "server" }; export function serverRoute(): RouteConfig { return { rateLimit: true, model: { host: "server" } }; } export function service(): ServerModel & { content: OwnerStorage.Message } { return { host: "server", content: { host: "server" } }; }');
  // An unrelated UI import is needed by its producer, not by the portable
  // declaration consumer. These are genuine external platform declarations.
  await put(join(root, 'node_modules/unrelated-platform/package.json'), { name: 'unrelated-platform', types: './index.d.ts' });
  await put(join(root, 'node_modules/unrelated-platform/index.d.ts'), 'declare global { namespace NodeJS { interface ProcessEnv { NODE_ENV: string } } function setTimeout(callback: () => void, delay: number): number; } export {};');
  await put(join(protocol, 'src/unrelatedUi.ts'), 'import "unrelated-platform"; export const unrelatedUi = true;');
  // The real schema package must retain one brand identity across the CLI's
  // source imports and the server-owned emitted declaration signature.
  await put(join(server, 'src/schema.ts'), 'import * as z from "zod/mini"; const identity = z.string().brand<"HostBoundaryId">(); export function acceptIdentity(value: z.infer<typeof identity>): string { return value; }');
  await put(join(ui, 'node_modules/ui-platform/package.json'), { name: 'ui-platform', types: './index.d.ts' });
  await put(join(ui, 'node_modules/ui-platform/tsconfig.json'), { extends: '../missing-private-build-config.json' });
  await put(join(ui, 'node_modules/ui-platform/index.d.ts'), 'export interface Platform { host: "ui" } declare global { namespace NodeJS { interface ProcessEnv { NODE_ENV: string } } }');
  await put(join(ui, 'src/model.ts'), 'export type { Platform } from "ui-platform";');
  await put(join(ui, 'src/surface.tsx'), 'export const uiSurface = <surface />;');
  await put(join(ui, 'src/entry.ts'), 'import { Platform } from "@/model"; import { selected } from "owner-condition"; const uiCondition: "browser" = selected; export { uiSurface } from "./surface"; export function ui(): Platform & { condition: typeof uiCondition } { return { host: "ui", condition: uiCondition }; } export type RouteExample = "@/model"; declare global { interface UiAmbient { path: "@/model" } }');
  await put(join(ui, 'src/consumer.test.ts'), 'import { ui, RouteExample } from "@/entry"; const result: "ui" = ui().host; const example: RouteExample = "@/model"; const ambient: UiAmbient = { path: example }; export { result, ambient };');
  await put(join(cli, 'src/fixtures/tsconfig.json'), { extends: './missing-fixture-config.json' });
  await put(join(cli, 'src/fixtures/data.json'), { value: 'data' });
  const roots = {
    'ordinary.test.ts': 'import data from "./fixtures/data.json"; import * as z from "zod/mini"; import { acceptIdentity } from "../../server/src/schema"; const identity = acceptIdentity(z.string().brand<"HostBoundaryId">().parse("identity")); const value: string = data.value; const env: NodeJS.ProcessEnv = {}; const response: Response = { bytes: async () => new Uint8Array() }; export { env, value, response, identity };',
    'foreignUi.test.tsx': 'import { ui, uiSurface } from "../../ui/src/entry"; import { selected } from "owner-condition"; import { host, type HostEnvironment } from "@/model"; const owner: "cli" = host; const authoredEnvironment: HostEnvironment = {}; const result: "ui" = ui().host; const uiCondition: "browser" = ui().condition; const cliCondition: "cli" = selected; const automatic: "ui-jsx" = uiSurface.owner; declare function cliJsx(tag: string, props: unknown): cliJsx.JSX.Element; declare namespace cliJsx { namespace JSX { interface Element { owner: "cli-jsx" } interface IntrinsicElements { surface: {} } } } const local = <surface />; const classic: "cli-jsx" = local.owner; let browser: Document | undefined; export { owner, authoredEnvironment, result, browser, uiCondition, cliCondition, automatic, classic };',
    'foreignProtocol.test.ts': 'import { html } from "../../../packages/protocol/src/document"; import { host } from "@/model"; const owner: "cli" = host; const result: string = html("content").text; const condition: "server" = html("content").condition; const env: NodeJS.ProcessEnv = {}; const timer = setTimeout(() => {}, 1); timer.unref(); export { owner, result, condition, env };',
    'serverIntegration.test.ts': 'import { service, serverRoute } from "../../server/src/service"; import { host } from "@/model"; const owner: "cli" = host; const result: "server" = service().content.host; const rateLimit: boolean | undefined = serverRoute().rateLimit; const routeOwner: "server" | undefined = serverRoute().model?.host; export { owner, result, rateLimit, routeOwner };',
  };
  for (const [name, content] of Object.entries(roots)) await put(join(cli, 'src', name), content);
  const run = (projectPaths, extraArgs = []) => {
    const result = spawnSync(process.execPath, [runner, ...(!projectPaths ? ['--verifyProjectCoverage', 'tsconfig.json'] : []), '--singleThreaded', ...extraArgs,
      ...(projectPaths ?? names.map(name => `tsconfig.${name}.json`)).flatMap(path => ['--project', path])], { cwd: cli, env: process.env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stdout + result.stderr);
    return { ...result, output: result.stdout + result.stderr };
  };
  const green = run();
  const producerEvidence = async () => {
    const cache = join(ui, 'node_modules/.cache/tsc');
    const { parsed } = readTypecheckProject(join(cli, 'node_modules/.cache/tsc/tsconfig.test-ui.json'));
    const files = await readdir(cache, { recursive: true });
    const declarations = await Promise.all(files.filter(file => file.endsWith('.d.ts')).map(async file => {
      const path = join(cache, file);
      const text = await readFile(path, 'utf8');
      return { file, text, resolvedImports: ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => ({
        specifier: fileName, resolved: ts.resolveModuleName(fileName, path, parsed.options, ts.sys).resolvedModule?.resolvedFileName,
      })) };
    }));
    const projects = await Promise.all(files.filter(file => /^tsconfig\./.test(file)).map(async file => ({ file,
      config: JSON.parse(await readFile(join(cache, file), 'utf8')) })));
    return '\nProducer filesystem/configuration and TS API resolution evidence:\n' + JSON.stringify({ declarations, projects }, null, 2);
  };
  const hasPreparedConsumer = existsSync(join(cli, 'node_modules/.cache/tsc/tsconfig.test-ui.json'));
  const nativeTrace = green.status && hasPreparedConsumer ? run([join(cli, 'node_modules/.cache/tsc/tsconfig.test-ui.json')], ['--traceResolution']).output : '';
  assert.equal(green.status, 0, green.output + (green.status && hasPreparedConsumer ? await producerEvidence() + '\nNative resolution trace:\n' + nativeTrace : ''));
  const uiConsumer = run([join(ui, 'node_modules/.cache/tsc/tsconfig.test-other.json')]);
  assert.equal(uiConsumer.status, 0, uiConsumer.output + (uiConsumer.status ? await producerEvidence() : ''));
  const projected = await Promise.all(names.map(async name => JSON.parse(await readFile(join(cli, 'node_modules/.cache/tsc', `tsconfig.${name}.json`), 'utf8'))));
  for (const name of Object.keys(roots)) assert.equal(projected.filter(config => config.files.includes(join(cli, 'src', name))).length, 1, `${name} must be checked exactly once`);
  const uiProgram = projected.find(config => config.files.includes(join(cli, 'src/foreignUi.test.tsx')));
  const ordinaryProgram = projected.find(config => config.files.includes(join(cli, 'src/ordinary.test.ts')));
  assert.notEqual(uiProgram, ordinaryProgram, 'the browser global must not contaminate ordinary CLI fixtures');
  assert.ok(ordinaryProgram.files.includes(join(cli, 'src/foreignProtocol.test.ts')),
    'public library DOM declarations must not import another app namespace or its globals');
  const libraryReference = ordinaryProgram.references.find(reference => relative(protocol, reference.path).startsWith(`node_modules${sep}`));
  assert.ok(libraryReference);
  const libraryProducer = readTypecheckProject(libraryReference.path).parsed;
  for (const ambient of ['environment.d.ts', 'timers.d.ts']) {
    const file = join(protocol, 'src', ambient);
    assert.ok(libraryProducer.fileNames.includes(file), 'the browser producer retains its authored environment');
    assert.ok(!ordinaryProgram.files.includes(file), 'the Node consumer retains ownership of its runtime globals');
  }
  const serverReference = ordinaryProgram.references.find(reference => relative(server, reference.path).startsWith(`node_modules${sep}`));
  assert.ok(serverReference, 'the real server closure must be checked by a server-owned declaration producer');
  for (const [name, content] of Object.entries(roots)) await put(join(cli, 'src', name), content
    + '\nconst deliberate: string = null; export { deliberate };'
    + (name === 'ordinary.test.ts' ? '\nacceptIdentity("unbranded");' : '')
    + (name === 'ordinary.test.ts' ? '\nlet forbiddenDom: Document | undefined; export { forbiddenDom };' : '')
    + (name === 'foreignUi.test.tsx' ? '\nconst uiEnv: NodeJS.ProcessEnv = {}; export { uiEnv };' : '')
    + (name === 'serverIntegration.test.ts' ? '\nconst wrongAmbientOwner: "cli" = service().content.host; export { wrongAmbientOwner };' : ''));
  const rejected = run(names.filter(name => name.startsWith('test')).map(name => join(cli, 'node_modules/.cache/tsc', `tsconfig.${name}.json`)));
  assert.notEqual(rejected.status, 0, 'test roots escaped strict checking');
  for (const name of Object.keys(roots)) assert.match(rejected.output,
    new RegExp(`${name.replaceAll('.', '\\.')}\\(\\d+,\\d+\\): error TS2322:`));
  assert.match(rejected.output, /foreignUi\.test\.tsx\(\d+,\d+\): error TS2741:/,
    'the UI program must retain its SDK-required NODE_ENV global contract');
  assert.match(rejected.output, /ordinary\.test\.ts\(3,\d+\): error TS2345:/,
    'the shared schema identity must still reject unbranded values');
  assert.match(rejected.output, /ordinary\.test\.ts\(4,\d+\): error TS2304:/,
    'foreign browser library ownership must not add DOM globals to ordinary CLI tests');
  assert.match(rejected.output, /serverIntegration\.test\.ts\(3,\d+\): error TS2322:/,
    'the ambient alias must retain the server model rather than becoming CLI-owned or any');
  for (const [name, content] of Object.entries(roots)) await put(join(cli, 'src', name), content);
  await put(join(root, 'node_modules/owner-condition/server.d.ts'), 'export declare const selected: "wrong-condition";');
  await put(join(protocol, 'src/document.ts'), protocolSource.replace('{ NODE_ENV: "production" }', '{}'));
  const wrongCondition = run();
  assert.notEqual(wrongCondition.status, 0, 'a producer must retain its own conditional export branch');
  assert.match(wrongCondition.output, /document\.ts\(\d+,\d+\): error TS2322:/);
  assert.match(wrongCondition.output, /document\.ts\(\d+,\d+\): error TS2741:/,
    'the browser producer must retain its own required environment contract');
  await put(join(protocol, 'src/document.ts'), protocolSource);
  await put(join(root, 'node_modules/owner-condition/server.d.ts'), 'export declare const selected: "server";');
  await put(join(server, 'src/model.ts'), 'export interface ServerModel { host: "wrong-server" }');
  const wrongAlias = run([serverReference.path]);
  assert.notEqual(wrongAlias.status, 0, 'server aliases must resolve to server declarations, not a similarly named CLI module');
  assert.match(wrongAlias.output, /wrong-server/);
});
