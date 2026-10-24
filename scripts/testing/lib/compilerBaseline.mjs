import { dirname, relative, resolve } from 'node:path';

const fields = ['package', 'file', 'line', 'column', 'code', 'message'];
const portable = value => value.replaceAll('\\', '/');
const key = value => JSON.stringify(fields.map(field => value[field]));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(field => Object.hasOwn(value, field));
const path = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..');

export function parseCompilerBaseline(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('invalid compiler baseline JSON'); }
  if (!exactKeys(value, ['sourceCommit', 'diagnostics']) || !/^[a-f0-9]{40}$/u.test(value.sourceCommit)
    || !Array.isArray(value.diagnostics) || value.diagnostics.some(row => !exactKeys(row, fields)
      || !path(row.package) || !path(row.file) || ![row.line, row.column, row.code].every(number => Number.isSafeInteger(number) && number > 0)
      || typeof row.message !== 'string' || row.message.length === 0)) throw new Error('invalid compiler baseline');
  return value;
}

export function compilerReportPackage(report, rootDir) {
  const packagePath = portable(relative(rootDir, dirname(resolve(report.cwd, portable(report.project)))));
  if (!path(packagePath)) throw new Error('compiler report project is outside a package');
  return packagePath;
}

export function compilerDiagnosticFromLine(line, cwd, rootDir) {
  const match = /^(.+)\((\d+),(\d+)\): error TS(\d+): (.+)$/u.exec(line);
  if (!match) return null;
  const file = portable(relative(rootDir, resolve(cwd, portable(match[1]))));
  if (!path(file)) throw new Error('compiler diagnostic is outside repository source');
  return { file, line: Number(match[2]), column: Number(match[3]), code: Number(match[4]), message: match[5] };
}

export function diagnosticsFromCompilerReport(report, rootDir) {
  if (!object(report) || typeof report.cwd !== 'string' || typeof report.project !== 'string'
    || typeof report.stdout !== 'string' || typeof report.stderr !== 'string'
    || report.signal !== null || report.error || ![0, 1, 2].includes(report.status) || report.stderr.trim()) {
    throw new Error(`compiler failed without a complete diagnostic result: ${report?.project ?? 'unknown'}`);
  }
  const packagePath = compilerReportPackage(report, rootDir);
  const rows = [];
  const output = report.stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const diagnostic = compilerDiagnosticFromLine(line, report.cwd, rootDir);
    if (diagnostic) {
      rows.push({ package: packagePath, ...diagnostic });
    } else if (/^\s+\S/u.test(line) && rows.length) {
      rows.at(-1).message += ` ${line.trim()}`;
    } else {
      throw new Error(`unrecognized compiler output: ${line}`);
    }
  }
  for (const row of rows) row.message = portable(row.message).replaceAll(portable(resolve(rootDir)), '<repo>').replace(/\s+/gu, ' ').trim();
  if ((report.status === 0) !== (rows.length === 0)) throw new Error('compiler status disagrees with diagnostic output');
  return rows;
}

// Git supplies zero-context hunks. Changed/deleted lines have no old identity;
// only unchanged source is eligible for the existing diagnostic allowance.
export function mapUnchangedLine(line, patch) {
  let offset = 0;
  for (const text of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text);
    if (!match) continue;
    const start = Number(match[1]);
    const removed = match[2] === undefined ? 1 : Number(match[2]);
    const added = match[4] === undefined ? 1 : Number(match[4]);
    if (line < start || (removed === 0 && line === start)) return line + offset;
    if (removed > 0 && line < start + removed) return null;
    offset += added - removed;
  }
  return line + offset;
}

export function assertCompilerBaselineDoesNotIncrease(current, base) {
  if (current.sourceCommit !== base.sourceCommit) throw new Error('compiler baseline source commit cannot change');
  const remaining = new Map();
  for (const row of base.diagnostics) remaining.set(key(row), (remaining.get(key(row)) ?? 0) + 1);
  for (const row of current.diagnostics) {
    const count = remaining.get(key(row)) ?? 0;
    if (!count) throw new Error(`compiler baseline increase rejected: ${row.file}:${row.line} TS${row.code}`);
    remaining.set(key(row), count - 1);
  }
}

export function compareCompilerBaseline(current, base, diagnostics, mapLine) {
  assertCompilerBaselineDoesNotIncrease(current, base);
  const allowed = new Map();
  for (const row of current.diagnostics) {
    const mappedLine = mapLine(row.line, row.file);
    if (mappedLine === null) continue;
    const mapped = key({ ...row, line: mappedLine });
    const occurrences = allowed.get(mapped) ?? [];
    occurrences.push(row);
    allowed.set(mapped, occurrences);
  }
  const retained = [];
  const added = [];
  for (const row of diagnostics) {
    const existing = allowed.get(key(row))?.shift();
    if (existing) retained.push(existing);
    else added.push(row);
  }
  if (added.length) throw new Error(`new compiler diagnostics:\n${added.map(row => `- ${row.package}: ${row.file}:${row.line}:${row.column} TS${row.code} ${row.message}`).join('\n')}`);
  return { sourceCommit: current.sourceCommit, diagnostics: retained.sort((left, right) => key(left).localeCompare(key(right))) };
}
