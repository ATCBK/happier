/**
 * Renders the server configuration reference from the server configuration registry
 * (`packages/protocol/src/serverConfig` plus the families the server declares for feature keys,
 * API rate limits and retention; plan `2026-09-26-home-owner-console` §3.14).
 *
 * The registry is the one declaration of every key the server reads — its type, default,
 * bounds, whether it applies live, and who may set it — so the pages below are generated rather
 * than written:
 *
 * - `self-hosting/env.mdx` keeps its hand-written guidance and gains a generated
 *   "Configuration reference" section between two markers;
 * - `self-hosting/feature-env.mdx` lists every feature key with its default.
 *
 * The composed registry lives in server TypeScript, so it is read by running the server's
 * `printServerConfigRegistry.ts` through the server's own tsx runner.
 *
 * Regenerate with `pnpm --dir apps/docs run generate:reference`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SERVER = join(REPO, 'apps', 'server');
export const ENV_OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'self-hosting', 'env.mdx');
export const FEATURE_ENV_OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'self-hosting', 'feature-env.mdx');

export const REFERENCE_START = '{/* server-config-reference:start — generated from the server configuration registry by apps/docs/scripts/generateServerConfigReference.mjs; do not edit by hand */}';
export const REFERENCE_END = '{/* server-config-reference:end */}';

let cachedRegistry = null;

/** The composed registry as `{ entries: [{ key, type, default?, bounds?, ..., origin }] }`. */
export function loadServerConfigRegistry() {
  if (cachedRegistry) return cachedRegistry;
  const runner = join(SERVER, 'scripts', 'runTsx.mjs');
  const script = join(SERVER, 'scripts', 'serverConfig', 'printServerConfigRegistry.ts');
  if (!existsSync(runner) || !existsSync(script)) {
    const error = new Error('The server workspace is not checked out; the configuration registry cannot be read.');
    error.code = 'ENOENT';
    throw error;
  }
  const result = spawnSync(process.execPath, [runner, '--tsconfig', join(SERVER, 'tsconfig.json'), script], {
    cwd: SERVER,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`printServerConfigRegistry failed (${result.status}): ${(result.stderr || '').trim().slice(-2000)}`);
  }
  const lastLine = result.stdout.trim().split('\n').pop() ?? '';
  cachedRegistry = JSON.parse(lastLine);
  return cachedRegistry;
}

const SECTION_TITLES = {
  reach: 'How this Home is reached',
  email: 'Email',
  policies: 'Sign-in and identity policy',
  data: 'Data and retention',
  runtime: 'Runtime',
  server: 'Server',
};

const SET_FROM = {
  home: 'Home settings or env',
  bootstrap: 'Env only',
  internal: 'Set by the server',
};

/** MDX treats `<`, `{` and `}` as syntax and `|` ends a table cell. */
export function escapeCell(text) {
  return String(text)
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/[{}]/g, (c) => `\\${c}`)
    .replace(/\s*\n\s*/g, ' ');
}

export function formatType(entry) {
  const bounds = entry.bounds ?? {};
  if (entry.type === 'enum') return `one of ${bounds.values.map((v) => `\`${v}\``).join(', ')}`;
  const parts = [entry.type];
  if (typeof bounds.min === 'number' && typeof bounds.max === 'number') parts.push(`${bounds.min}–${bounds.max}`);
  else if (typeof bounds.min === 'number') parts.push(`≥ ${bounds.min}`);
  else if (typeof bounds.max === 'number') parts.push(`≤ ${bounds.max}`);
  if (bounds.values) parts.push(`of ${bounds.values.map((v) => `\`${v}\``).join(', ')}`);
  if (bounds.scheme) parts.push(`(${bounds.scheme} when set from Home settings)`);
  return parts.join(' ');
}

export function formatDefault(entry) {
  if (entry.sensitivity === 'secret') return 'secret';
  if (entry.default === undefined) return '—';
  const value = Array.isArray(entry.default) ? entry.default.join(',') : typeof entry.default === 'object' ? JSON.stringify(entry.default) : String(entry.default);
  return value === '' ? '(empty)' : `\`${value}\``;
}

function formatKey(entry) {
  const aliases = entry.aliases?.length ? ` (alias ${entry.aliases.map((a) => `\`${a}\``).join(', ')})` : '';
  return `\`${entry.key}\`${aliases}`;
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function entryRow(entry) {
  return [
    formatKey(entry),
    escapeCell(formatType(entry)),
    escapeCell(formatDefault(entry)),
    entry.apply === 'live' ? 'Live' : 'Restart',
    SET_FROM[entry.editable],
    escapeCell(entry.description),
  ];
}

const HEADERS = ['Variable', 'Type', 'Default', 'Applies', 'Set from', 'Description'];

function titleOfFamily(family) {
  const words = family.replace(/[._]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Rows sub-group by the entry's `group`, else its `family`. */
function groupOf(entry) {
  return entry.group ?? entry.family ?? '';
}

function byKey(a, b) {
  return a.key.localeCompare(b.key);
}

/** The generated section of `env.mdx`: every key except the two families that have their own page. */
export function renderServerConfigReferenceSection({ entries }) {
  const listed = entries.filter((entry) => entry.origin !== 'features' && !(entry.origin === 'rateLimits' && /_RATE_LIMIT_(MAX|WINDOW)$/.test(entry.key)));
  const featureCount = entries.filter((entry) => entry.origin === 'features').length;
  const routeLimitCount = entries.length - listed.length - featureCount;
  const sections = Object.keys(SECTION_TITLES)
    .map((section) => {
      const inSection = listed.filter((entry) => entry.section === section).sort(byKey);
      if (!inSection.length) return '';
      const families = [...new Set(inSection.map(groupOf))].sort();
      const body = families.length === 1
        ? table(HEADERS, inSection.map(entryRow))
        : families
          .map((family) => {
            const rows = inSection.filter((entry) => groupOf(entry) === family).map(entryRow);
            return `#### ${family ? titleOfFamily(family) : 'General'}\n\n${table(HEADERS, rows)}`;
          })
          .join('\n\n');
      return `### ${SECTION_TITLES[section]}\n\n${body}`;
    })
    .filter(Boolean)
    .join('\n\n');

  return `${REFERENCE_START}

## Configuration reference

Every key the server reads is declared once in the server configuration registry, with its type,
default and bounds; this section is generated from it. **Set from** says who may change a key:
*Home settings or env* can also be set by a Home owner in Home Administration (an explicit env
value still wins and is shown there as fixed); *Env only* keys are read before the database opens,
so only the environment can set them. **Applies** says whether a change takes effect on the next
request or at the next start.

The ${featureCount} feature keys are listed on [Feature environment variables](/self-hosting/feature-env)
and the ${routeLimitCount} per-route rate-limit keys on [API rate limits](/self-hosting/rate-limits).

${sections}

${REFERENCE_END}`;
}

/** `env.mdx` with its generated section replaced (or appended when the markers are missing). */
export function spliceReferenceSection(current, section) {
  const start = current.indexOf(REFERENCE_START);
  const end = current.indexOf(REFERENCE_END);
  if (start >= 0 && end > start) {
    return `${current.slice(0, start)}${section}${current.slice(end + REFERENCE_END.length)}`;
  }
  return `${current.replace(/\s*$/, '')}\n\n${section}\n`;
}

export async function renderEnvReferenceMarkdown({ registry = loadServerConfigRegistry(), currentPath = ENV_OUTPUT_PATH } = {}) {
  return spliceReferenceSection(readFileSync(currentPath, 'utf8'), renderServerConfigReferenceSection(registry));
}

export async function renderFeatureEnvReferenceMarkdown({ registry = loadServerConfigRegistry() } = {}) {
  const features = registry.entries.filter((entry) => entry.origin === 'features');
  const switches = features.filter((entry) => entry.key.endsWith('__ENABLED')).length;
  const homeEditable = features.filter((entry) => entry.editable === 'home').length;
  const families = [...new Set(features.map((entry) => entry.family ?? 'other'))].sort();
  const sections = families
    .map((family) => {
      const rows = features
        .filter((entry) => (entry.family ?? 'other') === family)
        .sort(byKey)
        .map((entry) => {
          const [key, type, def, applies, setFrom, description] = entryRow(entry);
          return [key, entry.key.endsWith('__ENABLED') ? 'Switch' : 'Setting', type, def, applies, setFrom, description];
        });
      return `### ${titleOfFamily(family)}\n\n${table(['Variable', 'Kind', 'Type', 'Default', 'Applies', 'Set from', 'Description'], rows)}`;
    })
    .join('\n\n');

  return `---
title: Feature environment variables
description: Every HAPPIER_FEATURE_* variable the server reads, generated from the server configuration registry.
---

This is the complete list of environment variables the server reads to decide
what it advertises and how much of it a client may use. There are **${features.length}**, of
which **${switches}** are on/off switches and the rest are limits, timeouts,
policies and header names. **${homeEditable}** of them can also be set by a Home owner
in Home Administration; an explicit env value still wins there and is shown as fixed.

- **Switches** (\`…__ENABLED\`) turn a capability on or off. When the capability
  also appears in the client feature catalog, it is listed with its flag id on
  [Feature flags](/extras/feature-flags) — start there if you are trying to
  hide or reveal something users can see.
- **Settings** tune a capability that is already on: byte ceilings, rate limits,
  idle timeouts, accepted encodings, certificate header names.

<Callout type="info">
  Setting a variable for a capability whose switch is off does nothing. Check
  the switch in the same group first — a tunnel cap that seems to be ignored is
  usually a tunnel feature that was never enabled.
</Callout>

Every other server variable is listed in the
[configuration reference](/self-hosting/env#configuration-reference).

## Variables

Grouped by feature family.

${sections}
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(ENV_OUTPUT_PATH, await renderEnvReferenceMarkdown());
  writeFileSync(FEATURE_ENV_OUTPUT_PATH, await renderFeatureEnvReferenceMarkdown());
}
