import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import {
  deriveMarketplaceSourceId,
  deriveMarketplaceSourceTitle,
  normalizeMarketplaceSourceUrlV1,
} from './marketplaceSourceRegistryV1.js';

const MARKETPLACE_BROWSER_EXPORTS = [
  'deriveMarketplaceSourceId',
  'normalizeMarketplaceSourceUrlV1',
  'MarketplaceIndexQueryResultV1Schema',
] as const;

describe('marketplace source identity and URL boundary', () => {
  it.each([
    'http://catalog.example/index.json',
    'https://token@catalog.example/index.json',
    'https://catalog.example/index.json#secret',
  ])('rejects unsafe marketplace source URL %s', (sourceUrl) => {
    expect(() => normalizeMarketplaceSourceUrlV1(sourceUrl)).toThrow(/credential-free HTTPS/i);
  });

  it('normalizes safe URLs without truncating source configuration', () => {
    const query = 'x'.repeat(3_000);
    expect(normalizeMarketplaceSourceUrlV1(` https://CATALOG.example/index.json?key=${query} `))
      .toBe(`https://catalog.example/index.json?key=${query}`);
    expect(deriveMarketplaceSourceTitle('https://catalog.example/index.json')).toBe('catalog.example');
  });

  it('retains the stable SHA-256 source identity used by persisted marketplace records', () => {
    expect(deriveMarketplaceSourceId('https://marketplace.example.test/catalog.json'))
      .toBe('marketplace:eb6d4c94505d');
  });

  it('runs the bundled marketplace and registry source projections without Node built-ins', async () => {
    const marketplaceEntry = resolve(import.meta.dirname, 'index.ts');
    const registryEntry = resolve(import.meta.dirname, '../registries/index.ts');
    let browserBundle: string | undefined;

    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [{
        name: 'marketplace-source-registry-browser-projection',
        resolveId(id) {
          return id === 'virtual:marketplace-source-registry-browser-projection' ? `\0${id}` : null;
        },
        load(id) {
          if (id !== '\0virtual:marketplace-source-registry-browser-projection') return null;
          return `export { ${MARKETPLACE_BROWSER_EXPORTS.join(', ')} } from ${JSON.stringify(marketplaceEntry)};
            export { RegistrySourcesRecordV1Schema, listRegistrySourcesV1, deriveRegistrySourceIdV1 } from ${JSON.stringify(registryEntry)};`;
        },
        generateBundle(_options, bundle) {
          const chunks = Object.values(bundle).filter((entry) => entry.type === 'chunk');
          expect(chunks).toHaveLength(1);
          expect(chunks[0]!.imports).toEqual([]);
          expect(chunks[0]!.dynamicImports).toEqual([]);
          browserBundle = chunks[0]!.code;
        },
      }],
      build: {
        minify: false,
        target: 'es2022',
        write: false,
        rollupOptions: {
          input: 'virtual:marketplace-source-registry-browser-projection',
          preserveEntrySignatures: 'strict',
          output: { format: 'iife', name: 'MarketplaceBrowserProjection', inlineDynamicImports: true },
        },
      },
    });

    expect(browserBundle).toBeTypeOf('string');
    // Execute emitted bytes with browser globals and no Node process, require,
    // or Buffer. The emitted module is an untyped VM boundary, scoped to these public exports.
    const browserExports = runInNewContext(`${browserBundle}; MarketplaceBrowserProjection;`, {
      URL, TextEncoder, TextDecoder,
    }) as Pick<typeof import('./index.js'), typeof MARKETPLACE_BROWSER_EXPORTS[number]>
      & Pick<typeof import('../registries/index.js'), 'RegistrySourcesRecordV1Schema' | 'listRegistrySourcesV1' | 'deriveRegistrySourceIdV1'>;
    const sourceUrl = browserExports.normalizeMarketplaceSourceUrlV1('https://marketplace.example.test/catalog.json');
    expect(browserExports.deriveMarketplaceSourceId(sourceUrl)).toBe('marketplace:eb6d4c94505d');
    expect(browserExports.deriveRegistrySourceIdV1('https://GitHub.com/acme/skills.git/'))
      .toBe(browserExports.deriveRegistrySourceIdV1('https://github.com/acme/skills'));
    const record = browserExports.RegistrySourcesRecordV1Schema.parse({ v: 2, sources: [], disabledSourceIds: [] });
    expect(browserExports.listRegistrySourcesV1({ record, pluginSources: [] })).toEqual(expect.arrayContaining([
      expect.objectContaining({ format: 'happier-catalog', origin: { kind: 'built_in' }, removable: false }),
    ]));
    expect(browserExports.MarketplaceIndexQueryResultV1Schema.parse({
      revision: 1, items: [], nextCursor: null, sources: [], diagnostics: [],
    })).toEqual({ revision: 1, items: [], nextCursor: null, sources: [], diagnostics: [] });
  }, 60_000);
});
