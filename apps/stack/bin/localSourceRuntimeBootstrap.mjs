import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Load checkout tooling from its authored workspace authority before the
 * entry's import graph can reach a partially refreshed vendored package.
 * Installed Stack packages retain the published dependency closure. */
export async function bootstrapLocalStackSourceRuntime() {
  const source = new URL('../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url);
  if (!existsSync(source)) return;
  const repoDir = fileURLToPath(new URL('../../../', import.meta.url));
  const entry = resolve(process.argv[1] ?? '');
  const isToolEntry = ['apps/stack', 'scripts/workspaces'].some(directory => {
    const path = relative(resolve(repoDir, directory), entry);
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  });
  // Inherited preloads must not turn emitted CLI/server product children into
  // source consumers. Only repository tooling participates in this bootstrap.
  if (!isToolEntry) return;
  await import(source.href);
  // Entry children use the same authority. The ordinary bundle preflight still
  // owns vendoring and its freshness manifest, without an import-time deadlock.
  const option = `--import=${JSON.stringify(fileURLToPath(import.meta.url))}`;
  if (!String(process.env.NODE_OPTIONS ?? '').includes(option)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, option].filter(Boolean).join(' ');
  }
}

await bootstrapLocalStackSourceRuntime();
