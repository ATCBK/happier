import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pathExists } from '../fs/fs.mjs';

export function isYarnWorkspace(manifest) {
  return typeof manifest?.packageManager === 'string' && manifest.packageManager.startsWith('yarn@');
}

export async function readWorkspacePatterns(monorepoRoot) {
  // The executor also serves the supported Yarn predecessor checkout. Its
  // declared workspace set remains owned by package.json, never pnpm's YAML.
  const manifestPath = join(monorepoRoot, 'package.json');
  if (await pathExists(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    if (isYarnWorkspace(manifest)) {
      const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
      if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string' || !pattern.trim())) {
        throw new Error(`Invalid Yarn workspace patterns in ${manifestPath}`);
      }
      return patterns;
    }
  }
  const workspacePath = join(monorepoRoot, 'pnpm-workspace.yaml');
  const lines = (await readFile(workspacePath, 'utf-8')).split(/\r?\n/u);
  const header = lines.findIndex((line) => /^packages:/u.test(line));
  const unsupported = () => new Error(`Unsupported packages syntax in ${workspacePath}: expected a block sequence of string globs.`);
  if (header < 0 || !/^packages:\s*(?:#.*)?$/u.test(lines[header])) throw unsupported();

  // Gate selection consumes this before dependencies are installed. Keep its one workspace
  // reader dependency-free: the repository writes a block sequence of string globs. If the
  // workspace owner adopts other YAML syntax, extend this boundary explicitly instead of
  // guessing a different workspace set or falling back to directory discovery.
  const patterns = [];
  for (const line of lines.slice(header + 1)) {
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    if (/^\S/u.test(line)) break;
    const item = line.match(/^ +-[ \t]+(.+)$/u)?.[1];
    if (!item) throw unsupported();
    const doubleQuoted = item.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/u);
    const singleQuoted = item.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/u);
    let pattern;
    if (doubleQuoted) {
      try { pattern = JSON.parse(doubleQuoted[1]); } catch { throw unsupported(); }
    } else if (singleQuoted) {
      pattern = singleQuoted[1].replaceAll("''", "'");
    } else {
      pattern = item.replace(/\s+#.*$/u, '').trim();
      if (/^["'&*!\[\]{}>|%@`]/u.test(pattern) || /:\s/u.test(pattern)
        || /^(?:null|true|false|~|[-+]?\d+(?:\.\d+)?)$/iu.test(pattern)) throw unsupported();
    }
    if (!pattern) throw unsupported();
    patterns.push(pattern);
  }
  return patterns;
}

function workspacePatternToSegments(pattern) {
  const value = String(pattern ?? '').trim();
  if (!value || value.startsWith('!')) return null;
  return value
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .split('/')
    .filter(Boolean);
}

function wildcardSegmentRegex(segment) {
  const raw = String(segment ?? '');
  let out = '^';

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '*') {
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (ch === '[') {
      const end = raw.indexOf(']', i + 1);
      if (end > i + 1) {
        out += raw.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    out += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }

  out += '$';
  return new RegExp(out);
}

async function expandWorkspacePatternSegments(baseDir, segments, index = 0) {
  if (index >= segments.length) {
    return [baseDir];
  }

  const segment = segments[index];
  if (!segment || segment === '**') {
    return [];
  }

  if (!segment.includes('*')) {
    return await expandWorkspacePatternSegments(join(baseDir, segment), segments, index + 1);
  }

  let entries = [];
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const matcher = wildcardSegmentRegex(segment);
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!matcher.test(entry.name)) continue;
    out.push(...await expandWorkspacePatternSegments(join(baseDir, entry.name), segments, index + 1));
  }
  return out;
}

export async function collectWorkspacePackageJsonPaths(monorepoRoot) {
  const patterns = await readWorkspacePatterns(monorepoRoot);
  const out = new Set();

  for (const pattern of patterns) {
    const segments = workspacePatternToSegments(pattern);
    if (!segments?.length) continue;
    for (const workspaceDir of await expandWorkspacePatternSegments(monorepoRoot, segments)) {
      const pkgJsonPath = join(workspaceDir, 'package.json');
      if (await pathExists(pkgJsonPath)) {
        out.add(pkgJsonPath);
      }
    }
  }

  return Array.from(out);
}
