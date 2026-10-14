import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';

function readProject(path) {
  const config = ts.readConfigFile(path, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(path), undefined, path);
  if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => dirname(path), getNewLine: () => '\n',
  }));
  return { config: config.config, parsed };
}

function sharedDeclaration(file) {
  if (!file.endsWith('.d.ts')) return false;
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  return !ts.isExternalModule(source) || source.statements.some(statement =>
    ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name)
      || Boolean(statement.flags & ts.NodeFlags.GlobalAugmentation)));
}

/** Derive source cycles, their dependency-ordered prerequisites, the source
 * remainder, and caller-selected test programs from the current graph.
 * TypeScript 5 is used only as a compiler API; checking stays with native TS7.
 */
export async function deriveTypecheckProjects(packageDir, { sourceNames, testNames, testProject = "test", testGroup = () => 0, check = false, writeAuthored = false } = {}) {
  const names = [...sourceNames, ...testNames];
  packageDir = resolve(packageDir);
  const original = readProject(resolve(packageDir, 'tsconfig.json'));
  const projects = names.map(name => readProject(resolve(packageDir, `tsconfig.${name}.json`)));
  const originalRoots = new Set(original.parsed.fileNames);
  const shared = original.parsed.fileNames.filter(sharedDeclaration);
  const sharedSet = new Set(shared);
  const testConfig = readProject(resolve(packageDir, `tsconfig.${testProject}.json`));
  const existingTests = new Set(testConfig.parsed.fileNames.filter(file => existsSync(file)
    && !basename(file).includes('.composed.')));
  const testRoots = new Set([...existingTests, ...originalRoots].filter(file => !sharedSet.has(file)
    && (existingTests.has(file) || /\.(?:test|spec)\.tsx?$/.test(file)
      || file.replaceAll('\\', '/').includes('/__tests__/'))));
  const owned = new Set();
  const results = [];
  const path = file => relative(packageDir, file).replaceAll('\\', '/');
  const moduleCache = ts.createModuleResolutionCache(packageDir, file => file, original.parsed.options);
  const imports = new Map();
  const authored = resolved => /\.(?:json|[cm]?tsx?)$/.test(resolved.resolvedFileName)
    || (original.parsed.options.allowJs && !resolved.isExternalLibraryImport
      && !/[\\/]node_modules[\\/]/.test(resolved.resolvedFileName)
      && /\.(?:[cm]?js|jsx)$/.test(resolved.resolvedFileName));
  const importClosure = seeds => {
    const found = new Set();
    const pending = [...seeds];
    while (pending.length) {
      const file = pending.pop();
      if (found.has(file) || !existsSync(file)) continue;
      found.add(file);
      if (!imports.has(file)) {
        const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
        const dependencies = info.importedFiles.flatMap(({ fileName }) => {
          const resolved = ts.resolveModuleName(fileName, file, original.parsed.options, ts.sys, moduleCache).resolvedModule;
          return resolved && authored(resolved) ? [resolve(resolved.resolvedFileName)] : [];
        });
        dependencies.push(...info.referencedFiles.map(({ fileName }) => resolve(dirname(file), fileName)));
        dependencies.push(...info.typeReferenceDirectives.flatMap(({ fileName }) => {
          const resolved = ts.resolveTypeReferenceDirective(fileName, file, original.parsed.options, ts.sys).resolvedTypeReferenceDirective;
          return resolved ? [resolve(resolved.resolvedFileName)] : [];
        }));
        imports.set(file, dependencies);
      }
      pending.push(...imports.get(file));
    }
    return [...found];
  };
  const sources = importClosure([...originalRoots].filter(file => !testRoots.has(file)));
  const implementations = new Set(sources.filter(file => !/\.d\.[cm]?ts$/.test(file)));
  // Iterative strongly-connected components avoid recursion limits on the UI
  // graph. Edges through authored declaration packages still join real cycles.
  const visited = new Set();
  const order = [];
  for (const root of sources) {
    if (visited.has(root)) continue;
    const stack = [[root, false]];
    while (stack.length) {
      const [file, finished] = stack.pop();
      if (finished) { order.push(file); continue; }
      if (visited.has(file)) continue;
      visited.add(file);
      stack.push([file, true]);
      for (const dependency of imports.get(file) ?? []) if (imports.has(dependency) && !visited.has(dependency)) stack.push([dependency, false]);
    }
  }
  const reverse = new Map();
  for (const [file, dependencies] of imports) for (const dependency of dependencies) {
    if (!reverse.has(dependency)) reverse.set(dependency, []);
    reverse.get(dependency).push(file);
  }
  visited.clear();
  const components = [];
  let core = [];
  let coreWeight = 0;
  for (const root of order.reverse()) {
    if (visited.has(root)) continue;
    const component = [];
    const pending = [root];
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      component.push(file);
      pending.push(...reverse.get(file) ?? []);
    }
    components.push(component);
    const weight = component.filter(file => implementations.has(file)).length;
    if (weight > coreWeight) { core = component; coreWeight = weight; }
  }
  const coreSet = new Set(core);
  const foundation = importClosure([...core, ...shared]).filter(file => !coreSet.has(file));
  const prerequisiteGroups = Array.from({ length: sourceNames.length - 2 }, () => []);
  const foundationSet = new Set(foundation);
  const prerequisiteComponents = components.slice().reverse().map(component => component.filter(file => foundationSet.has(file))).filter(component => component.length);
  const targetWeight = foundation.filter(file => implementations.has(file)).length / prerequisiteGroups.length;
  let prerequisiteGroup = 0;
  let assignedWeight = 0;
  for (const component of prerequisiteComponents) {
    prerequisiteGroups[prerequisiteGroup].push(...component);
    assignedWeight += component.filter(file => implementations.has(file)).length;
    if (assignedWeight >= targetWeight * (prerequisiteGroup + 1) && prerequisiteGroup < prerequisiteGroups.length - 1) prerequisiteGroup++;
  }
  const sourceGroups = [...prerequisiteGroups, core, sources];
  for (let index = 0; index < sourceNames.length; index++) {
    const project = projects[index];
    const seeds = sourceGroups[index];
    // Scan one file at a time, retaining edges rather than full compiler ASTs.
    // Resolution includes authored TS dependencies, reference directives, JSON.
    const closure = importClosure([...seeds, ...shared])
      .filter(file => !/\.d\.[cm]?ts$/.test(file) || originalRoots.has(file));
    const files = [...new Set([...seeds, ...closure])]
      .filter(file => (!/\.d\.[cm]?ts$/.test(file) || originalRoots.has(file)) && !sharedSet.has(file) && !owned.has(file)).sort();
    for (const file of files) owned.add(file);
    results.push({ ...project.config, files: [...files, ...shared].map(path).sort(), include: [], exclude: [] });
  }
  for (let index = 0; index < testNames.length; index++) {
    const roots = [...testRoots].filter(file => testGroup(path(file)) === index);
    results.push({ ...projects[sourceNames.length + index].config, files: [...roots, ...shared].map(path).sort(), include: [], exclude: [] });
  }
  // Catch a stale selector or accidental test/source overlap before native
  // declaration emission; never silently omit an original implementation root.
  const memberships = results.map(config => new Set(config.files));
  for (const file of originalRoots) {
    const count = memberships.filter(files => files.has(path(file))).length;
    if (count !== (sharedSet.has(file) ? names.length : 1)) throw new Error(`TypeScript compiler ownership mismatch: ${path(file)} (${count})`);
  }
  // Explicit maintenance shares the same membership producer; public checks
  // only refresh the ignored compiler projections below.
  if (writeAuthored && !check) {
    for (let index = 0; index < names.length; index++) {
      await writeJsonAtomic(resolve(packageDir, `tsconfig.${names[index]}.json`), results[index]);
    }
    if (!names.includes(testProject)) await writeJsonAtomic(resolve(packageDir, `tsconfig.${testProject}.json`), {
      ...testConfig.config, files: [...testRoots, ...shared].map(path).sort(), include: [], exclude: [],
    });
  }
  const changed = [];
  const outputDir = resolve(packageDir, 'node_modules/.cache/tsc');
  const targets = names.map(name => resolve(outputDir, `tsconfig.${name}.json`));
  for (let index = 0; index < names.length; index++) {
    const target = targets[index];
    // Inherit authored options at their original path so relative aliases,
    // type roots and declaration outputs keep their existing meaning.
    const config = {
      extends: resolve(packageDir, `tsconfig.${names[index]}.json`),
      files: results[index].files.map(file => resolve(packageDir, file)),
      include: [], exclude: [],
      references: (projects[index].config.references ?? []).map(reference => {
        const authored = resolve(packageDir, reference.path);
        const sibling = names.findIndex(name => authored === resolve(packageDir, `tsconfig.${name}.json`));
        return { ...reference, path: sibling < 0 ? authored : targets[sibling] };
      }),
    };
    const text = JSON.stringify(config, null, 2) + '\n';
    if (existsSync(target) && readFileSync(target, 'utf8') === text) continue;
    changed.push(names[index]);
    if (!check) {
      mkdirSync(outputDir, { recursive: true });
      await writeJsonAtomic(target, config);
    }
  }
  if (check && changed.length) throw new Error(`TypeScript compiler partitions need regeneration: ${changed.join(', ')}`);
  return results.map((config, index) => ({ project: names[index], files: config.files.length, configPath: targets[index] }));
}

export async function prepareDerivedTypecheckProjects(projects, cwd, { names, derive, beforeDerive } = {}) {
  const paths = projects.map(project => project.project && resolve(cwd, project.project));
  if (paths.length !== names.length || paths.some((path, index) => !path || basename(path) !== `tsconfig.${names[index]}.json`)) return;
  const packageDir = dirname(paths[0]);
  if (paths.some(path => dirname(path) !== packageDir) || !existsSync(resolve(packageDir, 'tsconfig.json'))) return;
  await beforeDerive?.(packageDir);
  const inventory = await derive(packageDir);
  for (let index = 0; index < projects.length; index++) {
    const project = projects[index];
    const target = inventory[index].configPath;
    if (project.args) project.args = project.args.map((arg, argIndex) => ['--project', '-p'].includes(project.args[argIndex - 1])
      ? target : arg.startsWith('--project=') ? `--project=${target}` : arg);
    project.project = target;
  }
  process.stderr.write(`[typescript] derived ${basename(packageDir)} partitions: ${inventory.map(({ project, files }) => `${project}=${files}`).join(', ')}\n`);
  return inventory;
}
