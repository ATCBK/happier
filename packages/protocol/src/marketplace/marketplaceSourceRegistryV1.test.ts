import {resolve} from 'node:path';
import {build} from 'vite';
import {describe,expect,it} from 'vitest';
import {normalizeMarketplaceSourceUrlV1,deriveMarketplaceSourceId,deriveMarketplaceSourceTitle} from './marketplaceSourceRegistryV1.js';
const MARKETPLACE_BROWSER_EXPORTS=['normalizeMarketplaceSourceUrlV1','deriveMarketplaceSourceId','MarketplaceIndexQueryResultV1Schema','projectCommunityNpmListingV1'] as const;
describe('published marketplace source identity',()=>{
  it('retains the published SHA-256 source identity',()=>{expect(deriveMarketplaceSourceId('https://marketplace.example.test/catalog.json')).toBe('marketplace:eb6d4c94505d');});
  it.each(['http://catalog.example/index.json','https://token@catalog.example/index.json','https://catalog.example/index.json#secret'])('refuses unsafe catalog URL %s',url=>{expect(()=>normalizeMarketplaceSourceUrlV1(url)).toThrow();});
  it('normalizes URL spelling and derives a display title without inventing source authority',()=>{expect(normalizeMarketplaceSourceUrlV1(' https://CATALOG.example/index.json ')).toBe('https://catalog.example/index.json');expect(deriveMarketplaceSourceTitle('https://catalog.example/index.json')).toBe('catalog.example');});
  it('bundles the public marketplace source projection without Node built-ins', async () => {
    const marketplaceEntry = resolve(import.meta.dirname, 'index.ts');
    const moduleIds = new Set<string>();
    const nodeImports = new Set<string>();
    const browserExternalImporters = new Set<string>();

    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [{
        name: 'marketplace-source-registry-browser-projection',
        resolveId(id, importer) {
          if (id.startsWith('node:')) {
            nodeImports.add(`${id} from ${importer ?? '<entry>'}`);
          }
          return id === 'virtual:marketplace-source-registry-browser-projection' ? `\0${id}` : null;
        },
        load(id) {
          if (id !== '\0virtual:marketplace-source-registry-browser-projection') return null;
          return `export { ${MARKETPLACE_BROWSER_EXPORTS.join(', ')} } from ${JSON.stringify(marketplaceEntry)};`;
        },
        generateBundle() {
          for (const id of this.getModuleIds()) {
            moduleIds.add(id);
            if (id.includes('__vite-browser-external')) {
              for (const importer of this.getModuleInfo(id)?.importers ?? []) {
                const pending = [[importer]];
                const seen = new Set<string>();
                let trace = importer;
                while (pending.length) {
                  const path = pending.shift()!;
                  const current = path.at(-1)!;
                  if (seen.has(current)) continue;
                  seen.add(current);
                  if (current === marketplaceEntry) { trace = path.reverse().join(' -> '); break; }
                  for (const parent of this.getModuleInfo(current)?.importers ?? []) pending.push([...path, parent]);
                }
                browserExternalImporters.add(trace);
              }
            }
          }
        },
      }],
      build: {
        minify: false,
        target: 'es2022',
        write: false,
        rollupOptions: {
          input: 'virtual:marketplace-source-registry-browser-projection',
          preserveEntrySignatures: 'strict',
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });

    expect({
      nodeImports: [...nodeImports],
      browserExternalImporters: [...browserExternalImporters],
      forbiddenModuleIds: [...moduleIds].filter((id) => id.startsWith('node:') || id.includes('__vite-browser-external')),
    }).toEqual({ nodeImports: [], browserExternalImporters: [], forbiddenModuleIds: [] });
  }, 60_000);
});
