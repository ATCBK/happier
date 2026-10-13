import { appendFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const portable = value => value.replaceAll('\\', '/');
const text = value => String(value ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').trim();
const firstMessage = value => (text(value).split(/\r?\n/u).find(line => line.trim()) ?? '')
  .replace(/^(?:AssertionError|Error|TypeError|RangeError|ReferenceError|SyntaxError):\s*/u, '');
const identity = row => JSON.stringify([row.kind, row.file, row.name, row.code]);
const signature = row => JSON.stringify([identity(row), row.sourceLine ?? '', row.message]);
const sourcePath = (root, cwd, file) => portable(relative(root, resolve(cwd, portable(file))));

async function owner(root, file) {
  let directory = dirname(resolve(root, file));
  while (directory !== root && !isAbsolute(relative(root, directory))
    && !portable(relative(root, directory)).startsWith('../') && relative(root, directory) !== '..') {
    try {
      const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
      if (typeof manifest.name === 'string') return `${manifest.name} (${portable(relative(root, directory))})`;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    directory = dirname(directory);
  }
  const parts = file.split('/');
  return parts[0] === 'packages' && parts[1] === 'plugins' ? parts.slice(0, 3).join('/') : parts.slice(0, 2).join('/');
}

async function compilerResults(input, root) {
  const files = (await stat(input)).isDirectory()
    ? (await readdir(input)).filter(name => name.endsWith('.json')).map(name => resolve(input, name)) : [input];
  if (!files.length) throw new Error('no native compiler reports');
  const failures = [];
  const observedOwners = new Set();
  const sources = new Map();
  for (const file of files) {
    const report = JSON.parse(await readFile(file, 'utf8'));
    if (typeof report.cwd !== 'string' || typeof report.project !== 'string' || typeof report.stdout !== 'string'
      || typeof report.stderr !== 'string' || report.signal !== null || report.error || ![0, 1, 2].includes(report.status)) {
      throw new Error('incomplete native compiler report');
    }
    const packageOwner = await owner(root, sourcePath(root, report.cwd, report.project));
    observedOwners.add(packageOwner);
    let count = 0;
    for (const line of text(report.stdout).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const match = /^(.+)\((\d+),(\d+)\): error TS(\d+): (.+)$/u.exec(line);
      if (match) {
        const source = sourcePath(root, report.cwd, match[1]);
        // Source context tolerates line insertions, while distinguishing an
        // old error fixed beside a new identical error in the same file.
        // Reporting from a moving lane is advisory; package status is final.
        if (!sources.has(source) && !isAbsolute(source) && !source.startsWith('../')) {
          sources.set(source, readFile(resolve(root, source), 'utf8').then(contents => contents.split(/\r?\n/u)));
        }
        const sourceLine = sources.has(source) ? (await sources.get(source))[Number(match[2]) - 1]?.trim() ?? '' : '';
        failures.push({ kind: 'compiler', owner: await owner(root, source), compiledBy: packageOwner, file: source,
          name: '', code: `TS${match[4]}`, line: Number(match[2]), column: Number(match[3]), sourceLine, message: match[5] });
        count++;
      } else if (/^\s+\S/u.test(line) && count) failures.at(-1).message += ` ${line.trim()}`;
      else throw new Error(`unrecognized native compiler output: ${line}`);
    }
    if ((report.status === 0) !== (count === 0)) throw new Error('native compiler telemetry is incomplete');
    // Process/admission diagnostics may accompany otherwise complete TS7 output.
    // Keep them visible; the package's original result remains authoritative.
    if (report.stderr.trim()) process.stderr.write(`Compiler adapter stderr (${packageOwner}): ${report.stderr.trim()}\n`);
  }
  for (const row of failures) row.message = portable(row.message).replaceAll(portable(root), '<repo>').replace(/\s+/gu, ' ');
  return { failures, observes: row => row.kind === 'compiler' && observedOwners.has(row.compiledBy ?? row.owner) };
}

async function unitResults(input, root) {
  const report = JSON.parse(await readFile(input, 'utf8'));
  if (!Array.isArray(report.testResults)) throw new Error('not a Vitest JSON report');
  const failures = [];
  const observed = new Set();
  for (const module of report.testResults) {
    const file = sourcePath(root, root, module.name);
    const packageOwner = await owner(root, file);
    const row = { kind: 'unit', owner: packageOwner, file, name: '<load>', code: '' };
    observed.add(identity(row));
    const cases = module.assertionResults ?? [];
    if (!cases.length && module.status === 'failed') failures.push({ ...row, message: firstMessage(module.message) || 'Test module failed to load' });
    for (const item of cases) {
      const current = { ...row, name: item.fullName };
      observed.add(identity(current));
      if (item.status === 'failed') failures.push({ ...current, message: firstMessage(item.failureMessages?.[0]) || 'Test failed' });
    }
  }
  return { failures, observes: row => observed.has(identity(row)) };
}

async function readBaseline(file) {
  if (!file) return [];
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    process.stdout.write(`Baseline unavailable: ${file}; all observed failures are reported as new.\n`);
    return [];
  }
  if (!Array.isArray(value.failures) || !value.failures.every(row => row && ['compiler', 'unit'].includes(row.kind)
    && ['file', 'owner', 'name', 'code', 'message'].every(key => typeof row[key] === 'string'))) {
    throw new Error('invalid triage baseline');
  }
  return value.failures;
}

async function summarize({ failures, observes }, baseline, status) {
  const remaining = new Map();
  for (const row of baseline) {
    const key = signature(row);
    remaining.set(key, [...(remaining.get(key) ?? []), row]);
  }
  const added = failures.filter(row => !remaining.get(signature(row))?.shift());
  const resolved = [...remaining.values()].flat().filter(observes);
  const lines = [`Package result: ${status === 0 ? 'passed' : 'failed'} (exit ${status})`,
    `New since baseline: ${added.length}; current failures: ${failures.length}`,
    `Resolved since baseline: ${resolved.length}`];
  for (const row of added) {
    const description = `${row.owner}: ${row.file}${row.line ? `:${row.line}:${row.column}` : ''} ${row.code || row.name} ${row.message}`;
    lines.push(description);
    if (process.env.GITHUB_ACTIONS) {
      const escape = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
      const property = value => escape(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
      lines.push(`::notice file=${property(row.file)}${row.line ? `,line=${row.line},col=${row.column}` : ''}::${escape(description)}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const owners = new Map();
    for (const row of added) owners.set(row.owner, (owners.get(row.owner) ?? 0) + 1);
    const rows = [...owners].map(([packageOwner, count]) => `| ${packageOwner.replaceAll('|', '\\|')} | ${count} |`);
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### Gate triage\n\n${lines.slice(0, 3).join('  \n')}\n\n| Package owner | New |\n| --- | ---: |\n${rows.join('\n')}\n\nFile details are in the step log and annotations.\n`);
  }
}

/** Vitest's real reporter hook adds triage only; Vitest retains exit-status ownership. */
export default class GateTriageReporter {
  async onTestRunEnd(modules, unhandledErrors, reason) {
    try {
      const root = resolve(process.env.HAPPIER_GATE_TRIAGE_ROOT ?? repoRoot);
      const failures = [];
      const observed = new Set();
      for (const module of modules) {
        const file = sourcePath(root, root, module.moduleId);
        const row = { kind: 'unit', owner: await owner(root, file), file, name: '<load>', code: '' };
        observed.add(identity(row));
        for (const error of [...module.errors(), ...[...module.children.allSuites()].flatMap(suite => suite.errors())]) {
          failures.push({ ...row, message: firstMessage(error.message) });
        }
        for (const item of module.children.allTests()) {
          const current = { ...row, name: item.fullName };
          observed.add(identity(current));
          const result = item.result();
          if (result.state === 'failed') failures.push({ ...current, message: firstMessage(result.errors?.[0]?.message) || 'Test failed' });
        }
      }
      for (const error of unhandledErrors) failures.push({ kind: 'unit', owner: 'runner', file: '<runner>', name: 'unhandled', code: '', message: firstMessage(error.message) });
      const status = reason === 'interrupted' || unhandledErrors.length || modules.some(module => module.state() === 'failed') ? 1 : 0;
      await summarize({ failures, observes: row => observed.has(identity(row)) }, await readBaseline(process.env.HAPPIER_GATE_TRIAGE_BASELINE), status);
    } catch (error) {
      process.stderr.write(`Triage unavailable: ${error.message}\n`);
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = new Map(process.argv.slice(2).map(arg => {
    const index = arg.indexOf('=');
    return [arg.slice(0, index), arg.slice(index + 1)];
  }));
  const status = Number(args.get('--package-status'));
  if (!Number.isInteger(status) || status < 0 || status > 255) throw new Error('--package-status must be the terminal package exit code');
  // A triage or baseline error must never reinterpret the package verdict.
  try {
    const root = resolve(args.get('--root') ?? repoRoot);
    const kind = args.get('--kind');
    const results = kind === 'compiler' ? await compilerResults(args.get('--input'), root)
      : kind === 'unit' ? await unitResults(args.get('--input'), root) : undefined;
    if (!results) throw new Error('--kind must be compiler or unit');
    await summarize(results, await readBaseline(args.get('--baseline')), status);
    if (args.get('--write-baseline')) await writeFile(args.get('--write-baseline'), `${JSON.stringify({ failures: results.failures }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Triage unavailable: ${error.message}\n`);
  } finally {
    process.exitCode = status;
  }
}
