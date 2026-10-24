import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { compilerDiagnosticFromLine } from '../testing/lib/compilerBaseline.mjs';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import { typecheckCompilerOptions } from './resolveTypeScriptCliInvocation.mjs';

const execute = promisify(execFile);
const portable = value => value.replaceAll('\\', '/');
const location = row => `${row.line}:${row.column}:${row.code}`;
const inside = value => value !== '..' && !value.startsWith('../') && !isAbsolute(value);
const introspection = new Set(['--explainfiles', '--listfiles', '--listfilesonly', '--traceresolution', '--diagnostics', '--extendeddiagnostics']);

async function packageRoot(config, root) {
  let directory = dirname(config);
  while (inside(portable(relative(root, directory)))) {
    try {
      await readFile(resolve(directory, 'package.json'));
      return directory;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
}

// This is an observation of the previous completed invocation, never a compiler
// allowance or a package-green verdict. Interrupted/partial runs don't replace it.
export async function createTypecheckDiagnosticRun({ projects, cwd = process.cwd(), repoRoot } = {}) {
  const groups = new Map();
  const projectGroups = new Map();
  for (const project of projects) {
    const args = project.authoredArgs;
    if (args.some(arg => introspection.has(arg.toLowerCase()))) continue;
    const options = typecheckCompilerOptions(args, cwd);
    if (options?.noEmit !== true || !options.configFilePath) continue;
    if (!repoRoot) {
      try { repoRoot = (await execute('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim(); }
      catch { break; } // External author projects without Git still compile normally.
    }
    const root = await packageRoot(options.configFilePath, repoRoot);
    if (!root) continue;
    let group = groups.get(root);
    if (!group) {
      const path = resolve(root, 'node_modules/.cache/typecheck/diagnostics.json');
      group = { root, path, projects: [], results: new Map() };
      groups.set(root, group);
    }
    group.projects.push(portable(relative(repoRoot, options.configFilePath)));
    projectGroups.set(project, group);
  }
  return {
    enabled: groups.size > 0,
    record(project, result) { projectGroups.get(project)?.results.set(project, result); },
    async publish() {
      const reports = [];
      for (const group of groups.values()) {
        if (group.results.size !== group.projects.length) continue;
        const diagnosticsByPath = Object.create(null);
        const locations = new Set();
        const globalDiagnostics = new Set();
        let complete = true;
        for (const result of group.results.values()) {
          if (result.error || result.signal || ![0, 1, 2].includes(result.status)) { complete = false; break; }
          let recognized = 0;
          let continuation = false;
          // Admission owns stderr too. Read diagnostic headers from both
          // streams, but only the compiler's stdout has a diagnostic-only format.
          for (const [stream, text] of [['stdout', result.stdout ?? ''], ['stderr', result.stderr ?? '']]) {
            for (const line of text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').split(/\r?\n/u)) {
              if (!line.trim()) continue;
              const row = compilerDiagnosticFromLine(line, cwd, repoRoot);
              if (row) {
                const key = `${row.file}:${location(row)}`;
                if (!locations.has(key)) {
                  locations.add(key);
                  (diagnosticsByPath[row.file] ??= []).push({ line: row.line, column: row.column, code: row.code });
                }
                recognized += 1;
                continuation = true;
              } else if (/^error TS\d+:/u.test(line)) {
                globalDiagnostics.add(line);
                recognized += 1;
                continuation = true;
              } else if (stream === 'stdout' && (!/^\s/u.test(line) || !continuation)) {
                complete = false;
              }
            }
          }
          if ((result.status === 0) !== (recognized === 0)) complete = false;
        }
        if (!complete) continue;
        const projects = [...group.projects].sort();
        let previous;
        try { previous = JSON.parse(await readFile(group.path, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        const baseline = JSON.stringify(previous?.projects) === JSON.stringify(projects)
          && previous?.diagnosticsByPath && typeof previous.diagnosticsByPath === 'object'
          && Object.values(previous.diagnosticsByPath).every(rows => Array.isArray(rows) && rows.every(row =>
            row && [row.line, row.column, row.code].every(value => Number.isSafeInteger(value) && value > 0)));
        const packagePath = portable(relative(repoRoot, group.root)) || '.';
        const git = async args => (await execute('git', args, { cwd: repoRoot })).stdout.split('\0').filter(Boolean).map(portable);
        const touched = new Set([
          ...await git(['diff', '--name-only', '-z', 'HEAD']),
          ...await git(['ls-files', '--others', '--exclude-standard', '-z', '--', packagePath]),
        ]);
        let newInTouchedPaths = 0;
        let total = 0;
        for (const [file, rows] of Object.entries(diagnosticsByPath)) {
          total += rows.length;
          if (!baseline || !touched.has(file)) continue;
          const old = new Set((previous.diagnosticsByPath[file] ?? []).map(location));
          newInTouchedPaths += rows.filter(row => !old.has(location(row))).length;
        }
        await writeJsonAtomic(group.path, { projects, diagnosticsByPath, globalDiagnostics: globalDiagnostics.size });
        reports.push({ package: packagePath, path: group.path, baseline: Boolean(baseline),
          newInTouchedPaths: baseline ? newInTouchedPaths : null, total, globalDiagnostics: globalDiagnostics.size });
      }
      return reports;
    },
  };
}
