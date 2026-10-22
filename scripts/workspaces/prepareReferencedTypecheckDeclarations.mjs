import { mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import { readTypecheckAmbientModules, readTypecheckProject } from './deriveTypecheckProjects.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';

function absoluteTypecheckPaths(project, configPath) {
  const base = project.parsed.options.baseUrl ?? project.parsed.options.pathsBasePath ?? dirname(configPath);
  return Object.fromEntries(Object.entries(project.parsed.options.paths ?? {})
    .map(([name, targets]) => [name, targets.map(target => resolve(base, target))]));
}

/** Native TS7 resolves redirected declarations at their producer source/options.
 * Prepare those strict references without rewriting declaration imports/globals.
 */
export async function prepareReferencedTypecheckDeclarations(projects, cwd, inventory) {
  const consumers = projects.filter(project => {
    const authored = project.authoredProject ?? project.project;
    return authored && basename(authored).startsWith('tsconfig.test') && basename(dirname(resolve(cwd, authored))) === 'cli';
  });
  if (!consumers.length) return [];
  const publicWorkspacePaths = Object.assign({}, ...consumers.map(consumer => {
    const configPath = resolve(cwd, consumer.project);
    return Object.fromEntries(Object.entries(absoluteTypecheckPaths(readTypecheckProject(configPath), configPath))
      .filter(([name]) => name.startsWith('@happier-dev/')));
  }));
  const producers = [];
  const redirects = new Map();
  const ambientInputs = new Map();
  const ambientModules = new Map();
  const modulesFor = file => {
    if (!ambientModules.has(file)) ambientModules.set(file, readTypecheckAmbientModules(file));
    return ambientModules.get(file);
  };
  const preparedOwners = new Set();
  for (const consumer of consumers) {
    const configPath = resolve(cwd, consumer.project);
    const { config } = readTypecheckProject(configPath);
    for (const reference of config.references ?? []) {
      const referencePath = resolve(dirname(configPath), reference.path);
      if (basename(referencePath) !== 'tsconfig.source.json' || basename(dirname(referencePath)) !== 'ui') continue;
      if (redirects.has(referencePath)) continue;
      const uiDir = dirname(referencePath);
      const uiProjects = ['foundation', 'core', 'source'].map(name => {
        const project = resolve(uiDir, `tsconfig.${name}.json`);
        const args = ['--singleThreaded', '--project', project];
        return { project, authoredProject: project, args, authoredArgs: args };
      });
      const { prepareUiTypecheckProjects } = await import('../../apps/ui/scripts/deriveTypecheckProjects.mjs');
      await prepareUiTypecheckProjects(uiProjects, cwd);
      producers.push(...uiProjects);
      redirects.set(referencePath, uiProjects.at(-1).project);
      preparedOwners.add(resolve(uiDir, 'tsconfig.json'));
    }
  }
  for (const foreign of inventory?.foreignProjects ?? []) {
    if (preparedOwners.has(foreign.configPath)) continue;
    const ownerDir = dirname(foreign.configPath);
    const { cacheSuffix } = resolveTypeScriptCliInvocation({
      args: ['-p', foreign.configPath, '--noEmit', 'false', '--emitDeclarationOnly'], workspaceDir: cwd,
    });
    const cache = resolve(ownerDir, `node_modules/.cache/tsc${cacheSuffix}`);
    const project = resolve(cache, 'tsconfig.consumer-declarations.json');
    const source = readTypecheckProject(foreign.configPath);
    // Retain producer strictness and explicit aliases. Host workspace defaults
    // also apply here: author examples may have old installed SDK/UI copies.
    // Absolute paths preserve each alias's authored base in the cache config.
    await mkdir(cache, { recursive: true });
    await writeJsonAtomic(project, {
      extends: foreign.configPath,
      compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, noEmit: false,
        rootDir: resolve(ownerDir, '../..'), outDir: resolve(cache, 'consumer.declarations'),
        tsBuildInfoFile: resolve(cache, 'consumer.typecheck.tsbuildinfo'), disableSourceOfProjectReferenceRedirect: true,
        ...(Object.keys(publicWorkspacePaths).length ? {
          paths: { ...publicWorkspacePaths, ...absoluteTypecheckPaths(source, foreign.configPath) },
        } : {}) },
      files: foreign.files,
      include: [], exclude: [],
    });
    const args = ['--singleThreaded', '--project', project];
    producers.push({ project, authoredProject: project, args, authoredArgs: args });
    redirects.set(foreign.configPath, project);
    ambientInputs.set(foreign.configPath, foreign.ambientInputs ?? []);
    preparedOwners.add(foreign.configPath);
  }
  for (const consumer of consumers) {
    const configPath = resolve(cwd, consumer.project);
    const { config, parsed } = readTypecheckProject(configPath);
    const authored = resolve(cwd, consumer.authoredProject ?? consumer.project);
    const references = (config.references ?? []).map(reference => {
      const path = resolve(dirname(configPath), reference.path);
      return { ...reference, path: redirects.get(path) ?? path };
    });
    const roots = new Set(parsed.fileNames);
    const requiredOwners = new Set([...(inventory?.testContexts ?? [])].filter(([file]) => roots.has(file))
      .flatMap(([, context]) => context.owners.map(owner => owner.configPath)));
    for (const owner of requiredOwners) {
      const path = redirects.get(owner);
      if (path && !references.some(reference => reference.path === path)) references.push({ path });
    }
    const primaryInputs = inventory?.consumerPrimaryAmbientInputs?.get(authored) ?? [];
    const primaryNamespaces = new Set(primaryInputs
      .flatMap(file => modulesFor(file).namespaces));
    const primaryModules = new Set(primaryInputs.flatMap(file => modulesFor(file).moduleDefinitions));
    const consumerAmbientInputs = [...requiredOwners].flatMap(owner => {
      return (ambientInputs.get(owner) ?? []).filter(file => {
        // Reached ambient modules/type namespaces form declaration contracts,
        // including external augmentations, but
        // never replace consumer-owned primary bindings or runtime globals.
        const contribution = modulesFor(file);
        return !contribution.hasOtherGlobals
          && !contribution.namespaces.some(name => primaryNamespaces.has(name))
          && !contribution.moduleDefinitions.some(name => primaryModules.has(name))
          && contribution.modules.length + contribution.namespaces.length > 0;
      });
    });
    const files = [...new Set([...parsed.fileNames, ...consumerAmbientInputs])];
    const target = configPath === authored ? resolve(dirname(authored), 'node_modules/.cache/tsc', basename(authored)) : configPath;
    if (!redirects.size) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeJsonAtomic(target, configPath === authored
      ? { extends: authored, files, include: [], exclude: [], references }
      : { ...config, files, references });
    if (target !== configPath) {
      consumer.args = consumer.args.map((arg, index) => ['--project', '-p'].includes(consumer.args[index - 1])
        ? target : arg.startsWith('--project=') ? `--project=${target}` : arg);
      consumer.project = target;
    }
  }
  return producers;
}

