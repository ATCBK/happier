import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';

const { createRequire } = getVitestNodeBuiltin<typeof import('node:module')>('module');
const { pathToFileURL } = getVitestNodeBuiltin<typeof import('node:url')>('url');

// Vitest supplies the module filename even when jsdom's import.meta.url is HTTP.
const packageRequire = createRequire(__filename);

export function resolveEnrichedMarkdownPackageFile(relativePath: string): string {
    return packageRequire.resolve(`react-native-enriched-markdown/${relativePath}`);
}

export function enrichedMarkdownPackageFileUrl(relativePath: string): string {
    return pathToFileURL(resolveEnrichedMarkdownPackageFile(relativePath)).href;
}
