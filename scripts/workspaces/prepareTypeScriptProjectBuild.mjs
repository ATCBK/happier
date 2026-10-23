import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
  rmSync as defaultRmSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export async function verifyTypeScriptProjectCoverage({ baselinePath, baseline: selectedBaseline, projectPaths, cwd = process.cwd() }) {
  // Retain the compiler API for configuration parsing only. Native TypeScript
  // still owns every semantic diagnostic and declaration emission.
  const { default: ts } = await import('typescript');
  const parse = (path) => {
    const configPath = normalizeProjectPath(path, cwd);
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    });
    if (parsed.errors.length) throw new Error(parsed.errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
    return { configPath, fileNames: parsed.fileNames };
  };
  const configPath = normalizeProjectPath(baselinePath, cwd);
  const baseline = selectedBaseline?.configPath === configPath ? selectedBaseline : parse(configPath);
  const assignments = new Map();
  for (const path of projectPaths) {
    const project = parse(path);
    for (const file of project.fileNames) {
      const owners = assignments.get(file) ?? [];
      owners.push(project.configPath);
      assignments.set(file, owners);
    }
  }
  const missing = baseline.fileNames.filter((file) => !assignments.has(file));
  const duplicates = [...assignments].filter(([file, owners]) => owners.length > 1
    && !/\.d\.[cm]?ts$/u.test(file));
  if (missing.length || duplicates.length) {
    throw new Error(`TypeScript partition coverage for ${baseline.configPath} is incomplete; update ${projectPaths.join(', ')}:\n`
      + missing.map((file) => `- unassigned: ${relative(cwd, file)}`).join('\n')
      + (duplicates.length ? '\n' + duplicates.map(([file, owners]) =>
        `- duplicate: ${relative(cwd, file)} (${owners.join(', ')})`).join('\n') : ''));
  }
}

function readJson(path, { readFileSync = defaultReadFileSync } = {}) {
  return JSON.parse(String(readFileSync(path, 'utf8')));
}

function resolveMaybeRelativePath(baseDir, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return isAbsolute(raw) ? raw : resolve(baseDir, raw);
}

function normalizeProjectPath(rawProjectPath, cwd) {
  const raw = String(rawProjectPath ?? '').trim();
  if (!raw) return '';
  const resolved = isAbsolute(raw) ? raw : resolve(cwd, raw);
  return resolved.endsWith('.json') ? resolved : resolve(resolved, 'tsconfig.json');
}

export function resolveTypeScriptProjectPathFromArgs(args, { cwd = process.cwd() } = {}) {
  const values = Array.isArray(args) ? args : [];
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] ?? '');
    if (value === '-p' || value === '--project') {
      return normalizeProjectPath(values[index + 1], cwd);
    }
    if (value.startsWith('--project=')) {
      return normalizeProjectPath(value.slice('--project='.length), cwd);
    }
  }
  return '';
}

export function prepareTypeScriptProjectBuild({
  tsconfigPath,
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
  rmSync = defaultRmSync,
} = {}) {
  const resolvedTsconfigPath = normalizeProjectPath(tsconfigPath, process.cwd());
  if (!resolvedTsconfigPath || !existsSync(resolvedTsconfigPath)) {
    return;
  }

  let tsconfig;
  try {
    tsconfig = readJson(resolvedTsconfigPath, { readFileSync });
  } catch {
    return;
  }

  const compilerOptions = tsconfig?.compilerOptions;
  if (!compilerOptions || typeof compilerOptions !== 'object') {
    return;
  }

  const tsconfigDir = dirname(resolvedTsconfigPath);
  const outDir = resolveMaybeRelativePath(tsconfigDir, compilerOptions.outDir);
  const tsBuildInfoFile = resolveMaybeRelativePath(tsconfigDir, compilerOptions.tsBuildInfoFile);
  if (!outDir || !tsBuildInfoFile || existsSync(outDir) || !existsSync(tsBuildInfoFile)) {
    return;
  }

  rmSync(tsBuildInfoFile, { force: true });
}

export function prepareTypeScriptProjectBuildFromArgs(args, { cwd = process.cwd(), ...options } = {}) {
  const values = Array.isArray(args) ? args : [];
  if (values.includes('--noEmit')) {
    return;
  }

  const tsconfigPath = resolveTypeScriptProjectPathFromArgs(values, { cwd });
  if (!tsconfigPath) {
    return;
  }

  prepareTypeScriptProjectBuild({ tsconfigPath, ...options });
}
