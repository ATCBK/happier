/**
 * Generates the README "supported agents" logo strip into `.github/`:
 *
 *   .github/supported-agents-light.svg / .png  — dark #57606a glyphs, for LIGHT backgrounds
 *   .github/supported-agents-dark.svg  / .png  — light #8b949e glyphs, for DARK backgrounds
 *
 * Source of truth: the exact per-agent monochrome SVG marks the app's pre-auth
 * welcome screen renders as a horizontal row
 * (`apps/ui/sources/components/onboarding/preAuth/ProviderMarkRow.tsx`). That row maps
 * `AGENT_IDS` (the generated bundled-plugin catalog order,
 * `packages/agents/src/generated/agentIds.ts`) through `AgentIcon`, whose SVG marks come
 * from two generated owners:
 *
 *   - `apps/ui/sources/agents/registry/generatedAgentLogoSvgXml.ts` — the hand-drawn
 *     `AGENT_LOGO_SVG_XML` resolver map (imported directly; its imports are type-only);
 *   - `apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts` — per-agent
 *     `<NAME>_SVG_ICON_XML` inline resolvers plus the `svgIconXml:` wiring in each
 *     `<NAME>_UI` block. That module's runtime import graph (path aliases, RN deps)
 *     cannot load under plain Node, so this script PARSES those self-contained
 *     resolvers out of the generated source instead of importing the module.
 *
 * Tinting replicates `AgentIcon.applySvgIconColor` (agents/registry/AgentIcon.tsx):
 * every fill/stroke (except fill="none") becomes the single strip color, so inherently
 * colored marks stay monochrome exactly as in the app. Agents whose generated UI entry
 * has `svgIconXml: null` (no mark to draw — e.g. coderabbit, deepsec) are skipped and
 * listed on stdout.
 *
 * Regenerate with:  pnpm run generate:agents-strip
 *             (or:  node --experimental-strip-types scripts/generateSupportedAgentsStrip.mjs)
 *
 * PNGs are rasterized at 2x for retina README rendering, via the repo's `sharp`
 * dependency. If sharp's native binding is unavailable on this machine (e.g. the
 * workspace was installed for another platform), the SVGs are still written and exact
 * PNG instructions are printed; you can point the script at any working sharp install
 * with SUPPORTED_AGENTS_STRIP_SHARP=/path/to/node_modules/sharp.
 *
 * README.md consumes the PNGs through a <picture> element that switches the light/dark
 * variant on `prefers-color-scheme`. Idempotent: overwrites the four files, nothing else.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');

const LOGO_MODULE_PATH = path.join(
  repoRoot, 'apps', 'ui', 'sources', 'agents', 'registry', 'generatedAgentLogoSvgXml.ts',
);
const BUNDLED_ENTRIES_PATH = path.join(
  repoRoot, 'apps', 'ui', 'sources', 'agents', 'registry', 'generatedBundledPluginEntries.ts',
);
const AGENT_IDS_PATH = path.join(
  repoRoot, 'packages', 'agents', 'src', 'generated', 'agentIds.ts',
);
const OUT_DIR = path.join(repoRoot, '.github');

// Layout (1x units). Mirrors the welcome row's rhythm (square glyph boxes, even gaps):
// 28px glyph boxes inside 44px-tall rows, laid out on TWO centered rows for the README
// (a single long line renders each mark too small at README width), rasterized at 2x.
const GLYPH_SIZE = 28;
const GLYPH_GAP = 40;
const PAD_X = 10;
const ROW_HEIGHT = 44;
const ROWS = 2;
const PNG_SCALE = 2;

// Marks excluded from the README strip. `customAcp` is the neutral "bring your own ACP
// CLI" placeholder glyph, not a real agent brand; the welcome screen shows it, the
// README should not (founder decision, 2026-09-21). The bundled catalog on this line
// does not list it in AGENT_IDS, so the entry is a guard, not an active filter.
const EXCLUDED_AGENT_IDS = new Set(['customAcp']);

const VARIANTS = Object.freeze([
  { name: 'supported-agents-light', color: '#1f2328', note: 'dark glyphs / light background (GitHub light-mode text color)' },
  { name: 'supported-agents-dark', color: '#e6edf3', note: 'light glyphs / dark background (GitHub dark-mode text color)' },
]);

// Same pattern as AgentIcon.applySvgIconColor (agents/registry/AgentIcon.tsx): re-tint
// every fill/stroke attribute except fill="none"; `fill-rule` etc. are untouched because
// the pattern requires `="` right after the attribute name.
const SVG_COLOR_ATTRIBUTE_PATTERN = /\s(fill|stroke)="(?!none\b)[^"]*"/g;

function applySvgIconColor(svgXml, color) {
  return svgXml.replace(SVG_COLOR_ATTRIBUTE_PATTERN, (_match, attribute) => ` ${attribute}="${color}"`);
}

/** Same helpers the generated bundled-entries module defines for its inline resolvers. */
function normalizeGeneratedSvgXml(xml) {
  return xml.replace(/\s{2,}/g, ' ').trim();
}
function createGeneratedSvgIconXml(viewBox, body) {
  return normalizeGeneratedSvgXml(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`);
}

/** Welcome-screen order: the generated bundled catalog's AGENT_IDS declaration order. */
async function readWelcomeScreenAgentOrder() {
  try {
    const module_ = await import(pathToFileURL(AGENT_IDS_PATH).href);
    const ids = module_.AGENT_IDS;
    if (Array.isArray(ids) && ids.length > 0) return [...ids];
  } catch {
    // fall through to the textual parse
  }
  try {
    const source = await readFile(AGENT_IDS_PATH, 'utf8');
    const block = source.match(/export const AGENT_IDS = Object\.freeze\(\[([\s\S]*?)\]/u);
    if (!block) return null;
    const keys = [...block[1].matchAll(/'([A-Za-z0-9_]+)'/gu)].map((entry) => entry[1]);
    return keys.length > 0 ? keys : null;
  } catch {
    return null;
  }
}

/**
 * The inline `<NAME>_SVG_ICON_XML` resolvers and the per-agent `svgIconXml:` wiring,
 * parsed out of generatedBundledPluginEntries.ts (see the module docblock for why it
 * cannot simply be imported). Returns Map<agentId, resolver|null>.
 */
async function readBundledEntriesSvgWiring() {
  const source = await readFile(BUNDLED_ENTRIES_PATH, 'utf8');

  const inlineResolvers = new Map();
  const resolverPattern = /const ([A-Z0-9_]+_SVG_ICON_XML): AgentIconSvgXmlResolver = \(theme\)(?:: string)? =>/gu;
  for (const match of source.matchAll(resolverPattern)) {
    const name = match[1];
    const start = match.index + match[0].length;
    // The resolver body is a single createGeneratedSvgIconXml(...) call ending at the
    // first `\n);` after the arrow (the generator always emits that shape).
    const end = source.indexOf('\n);', start);
    if (end === -1) continue;
    const body = source.slice(start, end + 2).trim();
    // The body is plain JS already (template literal + string args); wrap it back into
    // an arrow function evaluated with our local helper in scope.
    // eslint-disable-next-line no-new-func
    const factory = new Function('createGeneratedSvgIconXml', `return (theme) => ${body.replace(/\)\s*;?$/u, ')')};`);
    inlineResolvers.set(name, factory(createGeneratedSvgIconXml));
  }

  const wiring = new Map();
  const uiBlockPattern = /const [A-Z0-9_]+_UI: AgentUiConfig = \{\s*id: '([A-Za-z0-9_]+)',[\s\S]*?svgIconXml: ([^,\n]+),/gu;
  for (const match of source.matchAll(uiBlockPattern)) {
    const [, agentId, expr] = match;
    wiring.set(agentId, expr.trim());
  }
  return { inlineResolvers, wiring };
}

function loadSharp() {
  const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));
  const candidates = [];
  if (process.env.SUPPORTED_AGENTS_STRIP_SHARP) {
    candidates.push(process.env.SUPPORTED_AGENTS_STRIP_SHARP);
  }
  candidates.push('sharp');
  let lastError;
  for (const candidate of candidates) {
    try {
      const loaded = requireFromRoot(candidate);
      return { sharp: loaded, from: candidate };
    } catch (error) {
      lastError = error;
    }
  }
  return { sharp: null, error: lastError };
}

/**
 * Split `count` glyphs into ROWS rows, longer rows first (9 + 9 for 18), each row
 * horizontally centered within the widest row.
 */
function rowLayout(count) {
  const base = Math.floor(count / ROWS);
  const remainder = count % ROWS;
  const rows = Array.from({ length: ROWS }, (_row, i) => base + (i < remainder ? 1 : 0));
  return rows.filter((n) => n > 0);
}

function rowWidth(n) {
  return n * GLYPH_SIZE + (n - 1) * GLYPH_GAP;
}

function buildStripSvg(glyphs, { width, height }) {
  const rows = rowLayout(glyphs.length);
  const maxRowWidth = Math.max(...rows.map(rowWidth));
  const cells = [];
  let cursor = 0;
  rows.forEach((rowCount, rowIndex) => {
    const xStart = PAD_X + (maxRowWidth - rowWidth(rowCount)) / 2;
    const y = rowIndex * ROW_HEIGHT + (ROW_HEIGHT - GLYPH_SIZE) / 2;
    for (let i = 0; i < rowCount; i += 1) {
      const { agentId, xml } = glyphs[cursor];
      cursor += 1;
      const x = xStart + i * (GLYPH_SIZE + GLYPH_GAP);
      // Nest each mark as an inner <svg> so its own viewBox keeps scaling + centering it
      // inside a square box, exactly like AgentIcon's fixed-size SvgXml box. Some marks
      // (e.g. antigravity) carry their own width/height on the root tag; strip those
      // from the ROOT TAG ONLY (inner <filter> etc. keep theirs) so the injected box
      // wins instead of redefining the attributes, which is an XML error.
      const rootTagEnd = xml.indexOf('>');
      const rootTag = xml.slice(0, rootTagEnd + 1).replace(/\s(?:width|height)="[^"]*"/g, '');
      const cleaned = rootTag + xml.slice(rootTagEnd + 1);
      const positioned = cleaned.replace(
        '<svg ',
        `<svg x="${x}" y="${y}" width="${GLYPH_SIZE}" height="${GLYPH_SIZE}" `,
      );
      cells.push(`  <!-- ${agentId} -->\n  ${positioned}`);
    }
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" role="img" aria-label="Supported AI coding agents">`,
    cells.join('\n'),
    '</svg>',
    '',
  ].join('\n');
}

let VIEW_WIDTH = 0;
let VIEW_HEIGHT = 0;

async function main() {
  const logoModule = await import(pathToFileURL(LOGO_MODULE_PATH).href);
  const logoMap = logoModule.AGENT_LOGO_SVG_XML;
  if (!logoMap || typeof logoMap !== 'object') {
    throw new Error(`AGENT_LOGO_SVG_XML not found in ${LOGO_MODULE_PATH}`);
  }

  const { inlineResolvers, wiring } = await readBundledEntriesSvgWiring();

  const resolveFor = (agentId) => {
    const expr = wiring.get(agentId);
    if (expr === undefined) return typeof logoMap[agentId] === 'function' ? logoMap[agentId] : null;
    if (expr === 'null') return null;
    const logoRef = expr.match(/^AGENT_LOGO_SVG_XML\.([A-Za-z0-9_]+)/u);
    if (logoRef) return typeof logoMap[logoRef[1]] === 'function' ? logoMap[logoRef[1]] : null;
    if (inlineResolvers.has(expr)) return inlineResolvers.get(expr);
    return null;
  };

  const welcomeOrder = await readWelcomeScreenAgentOrder();
  const declarationOrder = [...wiring.keys()];
  const agentIds = [...(welcomeOrder ?? declarationOrder)];
  for (const id of declarationOrder) {
    if (!agentIds.includes(id)) agentIds.push(id); // never drop an agent the map declares
  }

  const skipped = [];
  const rendered = [];
  for (const agentId of agentIds) {
    if (EXCLUDED_AGENT_IDS.has(agentId)) { skipped.push(`${agentId} (excluded)`); continue; }
    const resolver = resolveFor(agentId);
    if (!resolver) { skipped.push(`${agentId} (no SVG mark)`); continue; }
    rendered.push({ agentId, resolver });
  }
  if (rendered.length === 0) throw new Error('No agent logo resolvers found.');

  const rows = rowLayout(rendered.length);
  VIEW_WIDTH = PAD_X * 2 + Math.max(...rows.map(rowWidth));
  VIEW_HEIGHT = rows.length * ROW_HEIGHT;

  const { sharp, from: sharpFrom, error: sharpError } = loadSharp();
  const written = [];

  for (const variant of VARIANTS) {
    // The resolvers take the app theme and read colour leaves off it
    // (`theme.colors.text.primary`, and e.g. `theme.colors.accent.orange` /
    // `theme.colors.surface.base` for ohMyPi). In the app the welcome row hands
    // AgentIcon a tint colour, whose applySvgIconColor pass overwrites every one
    // of those fills with the single tint anyway — so feeding EVERY theme leaf
    // the strip colour, plus the same re-tint pass below, reproduces the app
    // pipeline exactly. A recursive Proxy keeps this robust to new theme reads.
    const themeLeaf = (color) => new Proxy(function () {}, {
      get: (_target, prop) => {
        if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
          return () => color;
        }
        return themeLeaf(color);
      },
    });
    const theme = themeLeaf(variant.color);
    const glyphs = rendered.map(({ agentId, resolver }) => ({
      agentId,
      xml: applySvgIconColor(resolver(theme), variant.color),
    }));

    const svg1x = buildStripSvg(glyphs, { width: VIEW_WIDTH, height: VIEW_HEIGHT });
    const svgPath = path.join(OUT_DIR, `${variant.name}.svg`);
    await writeFile(svgPath, svg1x, 'utf8');
    written.push(`${path.relative(repoRoot, svgPath)} (${VIEW_WIDTH}x${VIEW_HEIGHT})`);

    if (sharp) {
      const svg2x = buildStripSvg(glyphs, {
        width: VIEW_WIDTH * PNG_SCALE,
        height: VIEW_HEIGHT * PNG_SCALE,
      });
      const pngPath = path.join(OUT_DIR, `${variant.name}.png`);
      await sharp(Buffer.from(svg2x)).png().toFile(pngPath);
      written.push(`${path.relative(repoRoot, pngPath)} (${VIEW_WIDTH * PNG_SCALE}x${VIEW_HEIGHT * PNG_SCALE})`);
    }
  }

  console.log(`Rendered ${rendered.length} agent marks (${welcomeOrder ? 'bundled-catalog AGENT_IDS order' : 'generated UI-entry declaration order'}):`);
  console.log(`  ${rendered.map((g) => g.agentId).join(', ')}`);
  if (skipped.length > 0) console.log(`Skipped: ${skipped.join(', ')}`);
  console.log('Wrote:');
  for (const file of written) console.log(`  ${file}`);
  if (sharp) {
    console.log(`PNG rasterizer: sharp (resolved via ${sharpFrom === 'sharp' ? 'workspace root node_modules' : sharpFrom})`);
  } else {
    console.warn('\nWARNING: sharp could not be loaded on this machine — SVGs written, PNGs skipped.');
    if (sharpError) console.warn(`  (${String(sharpError.message).split('\n')[0]})`);
    console.warn('  To produce the PNGs, either:');
    console.warn('    - re-run inside the dev VM / any machine where the workspace sharp install matches the platform, or');
    console.warn('    - SUPPORTED_AGENTS_STRIP_SHARP=/path/to/node_modules/sharp pnpm run generate:agents-strip, or');
    console.warn(`    - rsvg-convert -w ${VIEW_WIDTH * PNG_SCALE} .github/supported-agents-light.svg -o .github/supported-agents-light.png (and the dark variant).`);
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
