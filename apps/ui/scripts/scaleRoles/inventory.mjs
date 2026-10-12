import { relative } from 'node:path';
import { analyzeFile, defaultRoots, repoRoot, sourceFiles } from './codemod.mjs';

// Advisory report only. No CI hook, allowlist or per-file migration ledger.
const roots = process.argv.slice(2);
const totals = new Map();
for (const path of await sourceFiles(roots.length ? roots : defaultRoots)) {
  const { sites } = await analyzeFile(path);
  const file = relative(repoRoot, path).replaceAll('\\', '/');
  const area = file.startsWith('packages/') ? file.split('/').slice(0, 4).join('/') : file.split('/').slice(0, 5).join('/');
  const count = totals.get(area) ?? { files: 0, fontSizes: 0, computedFontSizes: 0, offRoleSizes: 0, lineHeights: 0, tracking: 0, spacing: 0, computedSpacing: 0, offStepSpacing: 0, flagged: 0, fontValues: {}, spacingValues: {} };
  if (sites.length) count.files++;
  for (const site of sites) {
    if (site.kind === 'font') {
      if (typeof site.value === 'number') {
        count.fontSizes++;
        if (![11, 12, 13, 14, 15, 22, 28].includes(site.value)) count.offRoleSizes++;
        count.fontValues[site.value] = (count.fontValues[site.value] ?? 0) + 1;
      } else count.computedFontSizes++;
    }
    if (site.kind === 'line-height' && typeof site.value === 'number') count.lineHeights++;
    if (site.kind === 'tracking' && typeof site.value === 'number') count.tracking++;
    if (site.kind === 'spacing') {
      if (typeof site.value === 'number') {
        count.spacing++;
        if (site.status !== 'retained' && ![2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48].includes(site.value)) count.offStepSpacing++;
        count.spacingValues[site.value] = (count.spacingValues[site.value] ?? 0) + 1;
      } else count.computedSpacing++;
    }
    if (site.status === 'flagged') count.flagged++;
  }
  totals.set(area, count);
}
console.log(JSON.stringify({ roots: roots.length ? roots : defaultRoots, areas: Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b))) }, null, 2));
