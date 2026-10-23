import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';

/** Raw generator-published declaration IO; executable ingress owns validation. */
export function readBundledPluginManifest(locator: Readonly<{ manifestRelativePath: string }> | Readonly<{ manifest: unknown }>, runtimeRoot?: string): unknown {
    if ('manifest' in locator) return locator.manifest;
    const manifestPath = runtimeRoot ? join(runtimeRoot, locator.manifestRelativePath) : resolveCliRuntimeAssetPath(locator.manifestRelativePath);
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
}
