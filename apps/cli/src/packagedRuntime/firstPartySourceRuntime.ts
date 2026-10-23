import { fileURLToPath } from 'node:url';

/** Direct TS loading alone may import moving first-party source. Emitted JS never may. */
export function defaultCanImportFirstPartyPluginSource(): boolean {
  const modulePath = fileURLToPath(import.meta.url).replaceAll('\\', '/');
  return modulePath.endsWith('/src/packagedRuntime/firstPartySourceRuntime.ts');
}
